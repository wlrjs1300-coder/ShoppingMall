const { createClientSecretSign, createTimestamp } = require("../lib/naver-commerce-auth");
const { getNaverCommerceConfig } = require("../config");

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const REFRESH_SKEW_MS = 5 * 60 * 1000;

class NaverCommerceError extends Error {
  constructor({ code, category, status = null, retryable = false, traceId = null,
    retryAfterMs = null, providerCode = null, safeMessage }) {
    super(safeMessage);
    this.name = "NaverCommerceError";
    this.code = code;
    this.category = category;
    this.status = status;
    this.retryable = retryable;
    this.traceId = traceId;
    this.retryAfterMs = retryAfterMs;
    this.providerCode = providerCode;
    this.safeMessage = safeMessage;
  }
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : null;
}

function responseMetadata(headers, nowMs = Date.now()) {
  const get = (name) => headers?.get?.(name);
  return {
    traceId: get("GNCP-GW-Trace-ID") || null,
    rateLimit: {
      replenishRate: safeNumber(get("GNCP-GW-RateLimit-Replenish-Rate")),
      burstCapacity: safeNumber(get("GNCP-GW-RateLimit-Burst-Capacity")),
      remaining: safeNumber(get("GNCP-GW-RateLimit-Remaining")),
    },
    quota: {
      period: get("GNCP-GW-Quota-Period") || null,
      limit: safeNumber(get("GNCP-GW-Quota-Limit")),
      remaining: safeNumber(get("GNCP-GW-Quota-Remaining")),
    },
    retryAfterMs: parseRetryAfter(get("Retry-After"), nowMs),
  };
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return { data: null, json: true };
  try {
    return { data: JSON.parse(text), json: true };
  } catch {
    return { data: null, json: false };
  }
}

function errorFromResponse(response, body, metadata, authRequest = false) {
  const providerCode = typeof body?.code === "string" ? body.code : null;
  let category = "CLIENT_ERROR";
  let retryable = false;
  if (response.status === 401 || (authRequest && [400, 403].includes(response.status))) category = "AUTH_ERROR";
  else if (response.status === 429 && providerCode === "GW.QUOTA_LIMIT") { category = "QUOTA_LIMIT"; retryable = true; }
  else if (response.status === 429) { category = "RATE_LIMIT"; retryable = true; }
  else if (response.status >= 500) { category = "SERVER_ERROR"; retryable = true; }
  return new NaverCommerceError({
    code: `NAVER_${category}`,
    category,
    status: response.status,
    retryable,
    traceId: metadata.traceId || body?.traceId || null,
    retryAfterMs: metadata.retryAfterMs,
    providerCode,
    safeMessage: category === "AUTH_ERROR"
      ? "네이버 커머스API 인증에 실패했습니다."
      : "네이버 커머스API 요청을 처리하지 못했습니다.",
  });
}

function validateConfig(config) {
  if (!config.enabled) throw new NaverCommerceError({
    code: "NAVER_SYNC_DISABLED", category: "CONFIG_ERROR", safeMessage: "네이버 커머스API 연동이 비활성화되어 있습니다.",
  });
  if (!config.clientId || !config.clientSecret) throw new NaverCommerceError({
    code: "NAVER_CONFIG_MISSING", category: "CONFIG_ERROR", safeMessage: "네이버 커머스API 설정이 완료되지 않았습니다.",
  });
  if (!["SELF", "SELLER"].includes(config.authType) || (config.authType === "SELLER" && !config.accountId)) {
    throw new NaverCommerceError({
      code: "NAVER_CONFIG_INVALID", category: "CONFIG_ERROR", safeMessage: "네이버 커머스API 설정이 올바르지 않습니다.",
    });
  }
  try {
    const parsed = new URL(config.apiBaseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("invalid");
  } catch {
    throw new NaverCommerceError({
      code: "NAVER_CONFIG_INVALID", category: "CONFIG_ERROR", safeMessage: "네이버 커머스API 설정이 올바르지 않습니다.",
    });
  }
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
    throw new NaverCommerceError({
      code: "NAVER_CONFIG_INVALID", category: "CONFIG_ERROR", safeMessage: "네이버 커머스API 설정이 올바르지 않습니다.",
    });
  }
}

function createNaverCommerceClient({
  fetchImpl = global.fetch,
  now = Date.now,
  config = getNaverCommerceConfig(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("FETCH_IMPLEMENTATION_REQUIRED");
  let tokenCache = null;
  let tokenPromise = null;

  function clearTokenCache() {
    tokenCache = null;
  }

  function cachedTokenIsUsable() {
    return tokenCache && tokenCache.expiresAt - now() > REFRESH_SKEW_MS;
  }

  async function fetchWithTimeout(url, options) {
    const timeoutController = new AbortController();
    const callerSignal = options.signal;
    if (callerSignal?.aborted) throw new NaverCommerceError({
      code: "NAVER_REQUEST_ABORTED", category: "REQUEST_ABORTED", retryable: false,
      safeMessage: "네이버 커머스API 요청이 취소되었습니다.",
    });
    const combinedSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal;
    const timer = setTimeout(() => timeoutController.abort(), config.requestTimeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: combinedSignal });
    } catch (error) {
      if (error?.name === "AbortError" || combinedSignal.aborted) {
        if (timeoutController.signal.aborted) throw new NaverCommerceError({
          code: "NAVER_TIMEOUT", category: "TIMEOUT", retryable: true,
          safeMessage: "네이버 커머스API 응답 시간이 초과되었습니다.",
        });
        if (callerSignal?.aborted) throw new NaverCommerceError({
          code: "NAVER_REQUEST_ABORTED", category: "REQUEST_ABORTED", retryable: false,
          safeMessage: "네이버 커머스API 요청이 취소되었습니다.",
        });
      }
      if (error instanceof NaverCommerceError) throw error;
      throw new NaverCommerceError({
        code: "NAVER_NETWORK_ERROR", category: "NETWORK_ERROR", retryable: true, safeMessage: "네이버 커머스API에 연결하지 못했습니다.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function issueToken() {
    validateConfig(config);
    const timestamp = createTimestamp(now);
    const body = new URLSearchParams({
      client_id: config.clientId,
      timestamp: String(timestamp),
      grant_type: "client_credentials",
      client_secret_sign: createClientSecretSign({
        clientId: config.clientId, clientSecret: config.clientSecret, timestamp,
      }),
      type: config.authType,
    });
    if (config.authType === "SELLER") body.set("account_id", config.accountId);
    const response = await fetchWithTimeout(`${config.apiBaseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const parsed = await readBody(response);
    const metadata = responseMetadata(response.headers, now());
    if (!response.ok) throw errorFromResponse(response, parsed.data, metadata, true);
    const expiresInValue = parsed.data?.expires_in;
    const validExpiresType = typeof expiresInValue === "number"
      || (typeof expiresInValue === "string" && /^[1-9]\d*$/.test(expiresInValue));
    const expiresIn = validExpiresType ? Number(expiresInValue) : NaN;
    const issuedAt = now();
    const expiresAt = issuedAt + expiresIn * 1000;
    const tokenType = parsed.data?.token_type;
    if (!parsed.json || typeof parsed.data?.access_token !== "string" || !parsed.data.access_token
      || !Number.isFinite(expiresIn) || expiresIn <= 0
      || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt
      || (tokenType !== undefined && (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer"))) {
      throw new NaverCommerceError({
        code: "NAVER_TOKEN_RESPONSE_INVALID", category: "INVALID_RESPONSE",
        traceId: metadata.traceId, safeMessage: "네이버 인증 응답을 확인할 수 없습니다.",
      });
    }
    tokenCache = {
      accessToken: parsed.data.access_token,
      issuedAt,
      expiresAt,
      tokenType: tokenType || "Bearer",
      traceId: metadata.traceId,
    };
    return tokenCache;
  }

  async function getAccessToken() {
    if (cachedTokenIsUsable()) return tokenCache;
    if (tokenPromise) return tokenPromise;
    tokenPromise = issueToken();
    try {
      return await tokenPromise;
    } finally {
      tokenPromise = null;
    }
  }

  function buildUrl(requestPath) {
    if (typeof requestPath !== "string" || !requestPath.startsWith("/") || requestPath.startsWith("//")
      || requestPath.includes("\\") || requestPath.split(/[?#]/, 1)[0].split("/").includes("..")) {
      throw new NaverCommerceError({
        code: "NAVER_PATH_INVALID", category: "CONFIG_ERROR", safeMessage: "네이버 API 경로가 올바르지 않습니다.",
      });
    }
    const url = new URL(`${config.apiBaseUrl.replace(/\/$/, "")}${requestPath}`);
    const base = new URL(`${config.apiBaseUrl}/`);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) {
      throw new NaverCommerceError({
        code: "NAVER_PATH_INVALID", category: "CONFIG_ERROR", safeMessage: "네이버 API 경로가 올바르지 않습니다.",
      });
    }
    return url.toString();
  }

  async function performRequest(requestPath, options, allowAuthRetry) {
    validateConfig(config);
    if (options.signal?.aborted) throw new NaverCommerceError({
      code: "NAVER_REQUEST_ABORTED", category: "REQUEST_ABORTED", retryable: false,
      safeMessage: "네이버 커머스API 요청이 취소되었습니다.",
    });
    const method = String(options.method || "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw new NaverCommerceError({
      code: "NAVER_METHOD_INVALID", category: "CONFIG_ERROR", safeMessage: "지원하지 않는 네이버 API 요청 방식입니다.",
    });
    const callerHeaders = new Headers(options.headers || {});
    if (callerHeaders.has("Authorization")) throw new NaverCommerceError({
      code: "NAVER_AUTH_HEADER_FORBIDDEN", category: "CONFIG_ERROR", safeMessage: "인증 헤더를 직접 설정할 수 없습니다.",
    });
    const token = await getAccessToken();
    callerHeaders.set("Accept", callerHeaders.get("Accept") || "application/json");
    callerHeaders.set("Authorization", `Bearer ${token.accessToken}`);
    const { retryOnAuth, ...fetchOptions } = options;
    const response = await fetchWithTimeout(buildUrl(requestPath), {
      ...fetchOptions, method, headers: callerHeaders,
    });
    const parsed = await readBody(response);
    const metadata = responseMetadata(response.headers, now());
    if (response.ok) {
      if (!parsed.json) throw new NaverCommerceError({
        code: "NAVER_RESPONSE_INVALID", category: "INVALID_RESPONSE", traceId: metadata.traceId,
        safeMessage: "네이버 API 응답을 확인할 수 없습니다.",
      });
      return { data: parsed.data, ...metadata };
    }
    const error = errorFromResponse(response, parsed.data, metadata);
    const authFailure = response.status === 401 && (!error.providerCode || error.providerCode === "GW.AUTHN");
    const retryAllowed = IDEMPOTENT_METHODS.has(method) || options.retryOnAuth === true;
    if (allowAuthRetry && authFailure && retryAllowed) {
      clearTokenCache();
      return performRequest(requestPath, options, false);
    }
    throw error;
  }

  async function request(requestPath, options = {}) {
    return performRequest(requestPath, options, true);
  }

  async function getConnectionStatus() {
    if (!config.enabled) return { channel: "naver", enabled: false, configured: false, connected: false, authType: config.authType, tokenExpiresAt: null, traceId: null };
    try {
      validateConfig(config);
      const token = await getAccessToken();
      return {
        channel: "naver", enabled: true, configured: true, connected: true,
        authType: config.authType, tokenExpiresAt: new Date(token.expiresAt).toISOString(), traceId: token.traceId,
      };
    } catch (error) {
      if (error.category === "CONFIG_ERROR") {
        return { channel: "naver", enabled: true, configured: false, connected: false, authType: config.authType, tokenExpiresAt: null, traceId: null, errorCode: error.code };
      }
      return { channel: "naver", enabled: true, configured: true, connected: false, authType: config.authType, tokenExpiresAt: null, traceId: error.traceId || null, errorCode: error.code || "NAVER_CONNECTION_FAILED" };
    }
  }

  return { clearTokenCache, getAccessToken, request, getConnectionStatus };
}

let defaultClient;
function getDefaultNaverCommerceClient() {
  if (!defaultClient) defaultClient = createNaverCommerceClient();
  return defaultClient;
}

module.exports = {
  NaverCommerceError,
  createNaverCommerceClient,
  getDefaultNaverCommerceClient,
  parseRetryAfter,
  responseMetadata,
};
