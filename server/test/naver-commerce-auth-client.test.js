process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "naver-commerce-test-jwt-secret-at-least-32-bytes";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const db = require("../db");
const app = require("../index");
const salesChannelsRoute = require("../routes/sales-channels");
const { createClientSecretSign, createTimestamp } = require("../lib/naver-commerce-auth");
const {
  NaverCommerceError,
  createNaverCommerceClient,
  parseRetryAfter,
  responseMetadata,
} = require("../services/naver-commerce-client");
const { getNaverCommerceConfig, naverCommerceConfigErrors } = require("../config");

const SECRET = "$2a$10$abcdefghijklmnopqrstuv";
const OFFICIAL_SIGNATURE = "JDJhJDEwJGFiY2RlZmdoaWprbG1ub3BxcnN0dXVCVldZSk42T0VPdEx1OFY0cDQxa2IuTnpVaUEzbmsy";

function config(overrides = {}) {
  return {
    enabled: true,
    clientId: "aaaabbbbcccc",
    clientSecret: SECRET,
    authType: "SELF",
    accountId: "",
    apiBaseUrl: "https://mock.invalid/external",
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function tokenResponse(token = "fixture-token-never-returned", expiresIn = 10800, init = {}) {
  return jsonResponse({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }, init);
}

function legacyToken(role = "viewer") {
  return jwt.sign({ sub: `fixture-${role}`, role }, process.env.JWT_SECRET, { algorithm: "HS256" });
}

test("official bcrypt and standard Base64 signature vector is reproduced without mutating input", () => {
  const input = { clientId: "aaaabbbbcccc", clientSecret: SECRET, timestamp: 1643961623299 };
  const before = { ...input };
  assert.equal(createClientSecretSign(input), OFFICIAL_SIGNATURE);
  assert.deepEqual(input, before);
  assert.equal(createTimestamp(() => 1643961623299), 1643961623299);
});

test("signature rejects missing credentials and invalid millisecond timestamp", () => {
  assert.throws(() => createClientSecretSign({ clientId: "", clientSecret: SECRET, timestamp: 1 }), /CLIENT_ID/);
  assert.throws(() => createClientSecretSign({ clientId: "id", clientSecret: "", timestamp: 1 }), /CLIENT_SECRET/);
  for (const timestamp of [0, -1, 1.2, "1643961623299", NaN]) {
    assert.throws(() => createClientSecretSign({ clientId: "id", clientSecret: SECRET, timestamp }), /TIMESTAMP/);
  }
});

test("token request is form-urlencoded and SELF excludes account_id", async () => {
  let captured;
  const client = createNaverCommerceClient({
    config: config(),
    now: () => 1643961623299,
    fetchImpl: async (url, options) => { captured = { url, options }; return tokenResponse(); },
  });
  const token = await client.getAccessToken();
  assert.equal(captured.url, "https://mock.invalid/external/v1/oauth2/token");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.ok(captured.options.body instanceof URLSearchParams);
  assert.equal(captured.options.body.get("grant_type"), "client_credentials");
  assert.equal(captured.options.body.get("type"), "SELF");
  assert.equal(captured.options.body.has("account_id"), false);
  assert.equal(token.accessToken, "fixture-token-never-returned");
});

test("SELLER includes account_id and missing account is blocked before fetch", async () => {
  let body;
  const seller = createNaverCommerceClient({
    config: config({ authType: "SELLER", accountId: "seller-fixture" }),
    fetchImpl: async (_url, options) => { body = options.body; return tokenResponse(); },
  });
  await seller.getAccessToken();
  assert.equal(body.get("account_id"), "seller-fixture");
  let calls = 0;
  const invalid = createNaverCommerceClient({
    config: config({ authType: "SELLER", accountId: "" }),
    fetchImpl: async () => { calls += 1; return tokenResponse(); },
  });
  await assert.rejects(invalid.getAccessToken(), (error) => error.category === "CONFIG_ERROR");
  assert.equal(calls, 0);
});

test("token response contract, cache, refresh skew and single-flight are enforced", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const client = createNaverCommerceClient({
    config: config(),
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      await Promise.resolve();
      return tokenResponse(`fixture-token-${calls}`, 600);
    },
  });
  const [first, second] = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  await client.getAccessToken();
  assert.equal(calls, 1);
  now += 301_000;
  await client.getAccessToken();
  assert.equal(calls, 2);

  for (const body of [
    { expires_in: 100 },
    { access_token: "x", expires_in: 0 },
    { access_token: "x", expires_in: "bad" },
  ]) {
    const invalid = createNaverCommerceClient({ config: config(), fetchImpl: async () => jsonResponse(body) });
    await assert.rejects(invalid.getAccessToken(), (error) => error.category === "INVALID_RESPONSE");
  }
});

test("failed token promise is cleared and next call may retry", async () => {
  let calls = 0;
  const client = createNaverCommerceClient({
    config: config(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("credential must not leak");
      return tokenResponse();
    },
  });
  await assert.rejects(client.getAccessToken(), (error) => error.category === "NETWORK_ERROR" && !error.message.includes("credential"));
  await client.getAccessToken();
  assert.equal(calls, 2);
});

test("common client joins safe relative paths and protects Authorization", async () => {
  const calls = [];
  const client = createNaverCommerceClient({
    config: config(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? tokenResponse() : jsonResponse({ ok: true });
    },
  });
  const result = await client.request("/v1/seller/account");
  assert.deepEqual(result.data, { ok: true });
  assert.equal(calls[1].url, "https://mock.invalid/external/v1/seller/account");
  assert.equal(calls[1].options.headers.get("Authorization"), "Bearer fixture-token-never-returned");
  for (const path of ["https://evil.invalid/x", "//evil.invalid/x", "/v1/../secret", "/v1\\secret"]) {
    await assert.rejects(client.request(path), /경로/);
  }
  await assert.rejects(client.request("/v1/seller/account", { headers: { Authorization: "Bearer attacker" } }), /인증 헤더/);
});

test("success body, empty body, non-JSON response and timeout are normalized", async () => {
  let count = 0;
  const client = createNaverCommerceClient({
    config: config({ requestTimeoutMs: 5 }),
    fetchImpl: async (_url, options) => {
      count += 1;
      if (count === 1) return tokenResponse();
      if (count === 2) return new Response(null, { status: 204 });
      if (count === 3) return new Response("provider secret detail", { status: 502 });
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    },
  });
  assert.equal((await client.request("/v1/empty")).data, null);
  await assert.rejects(client.request("/v1/failure"), (error) => error.category === "SERVER_ERROR" && !error.message.includes("provider"));
  await assert.rejects(client.request("/v1/timeout"), (error) => error.category === "TIMEOUT" && error.retryable);
});

test("GET retries one GW.AUTHN response while non-idempotent requests do not retry by default", async () => {
  let tokenCalls = 0;
  let apiCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/token")) { tokenCalls += 1; return tokenResponse(`token-${tokenCalls}`); }
    apiCalls += 1;
    return apiCalls === 1 ? jsonResponse({ code: "GW.AUTHN" }, { status: 401 }) : jsonResponse({ ok: true });
  };
  const getClient = createNaverCommerceClient({ config: config(), fetchImpl });
  assert.equal((await getClient.request("/v1/read")).data.ok, true);
  assert.equal(tokenCalls, 2);
  assert.equal(apiCalls, 2);

  let postApiCalls = 0;
  const postClient = createNaverCommerceClient({
    config: config(),
    fetchImpl: async (url) => url.endsWith("/oauth2/token")
      ? tokenResponse()
      : (postApiCalls += 1, jsonResponse({ code: "GW.AUTHN" }, { status: 401 })),
  });
  await assert.rejects(postClient.request("/v1/write", { method: "POST" }), (error) => error.category === "AUTH_ERROR");
  assert.equal(postApiCalls, 1);
});

test("rate, quota, trace and Retry-After metadata are normalized", () => {
  const headers = new Headers({
    "GNCP-GW-Trace-ID": "trace-fixture",
    "GNCP-GW-RateLimit-Replenish-Rate": "10",
    "GNCP-GW-RateLimit-Burst-Capacity": "20",
    "GNCP-GW-RateLimit-Remaining": "not-a-number",
    "GNCP-GW-Quota-Period": "SECONDS",
    "GNCP-GW-Quota-Limit": "30",
    "GNCP-GW-Quota-Remaining": "4",
    "Retry-After": "7",
  });
  const metadata = responseMetadata(headers, 0);
  assert.deepEqual(metadata.rateLimit, { replenishRate: 10, burstCapacity: 20, remaining: null });
  assert.deepEqual(metadata.quota, { period: "SECONDS", limit: 30, remaining: 4 });
  assert.equal(metadata.traceId, "trace-fixture");
  assert.equal(metadata.retryAfterMs, 7000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("2026-01-01T00:00:00Z")), 10000);
  assert.equal(parseRetryAfter(null, 0), null);
});

test("429 quota/rate, 4xx and 5xx errors receive safe categories", async () => {
  for (const [status, code, category, retryable] of [
    [429, "GW.RATE_LIMIT", "RATE_LIMIT", true],
    [429, "GW.QUOTA_LIMIT", "QUOTA_LIMIT", true],
    [400, "BAD_INPUT", "CLIENT_ERROR", false],
    [503, "GW.BLOCK.01", "SERVER_ERROR", true],
  ]) {
    let calls = 0;
    const client = createNaverCommerceClient({
      config: config(),
      fetchImpl: async () => (++calls === 1 ? tokenResponse() : jsonResponse({ code, message: "secret provider text" }, { status })),
    });
    await assert.rejects(client.request("/v1/test"), (error) => {
      assert.ok(error instanceof NaverCommerceError);
      return error.category === category && error.retryable === retryable && !error.message.includes("secret provider");
    });
  }
});

test("configuration defaults, disabled mode and production validation are safe", () => {
  const disabled = getNaverCommerceConfig({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.authType, "SELF");
  assert.equal(disabled.requestTimeoutMs, 10000);
  assert.deepEqual(naverCommerceConfigErrors({ NODE_ENV: "production" }), []);
  const base = {
    NODE_ENV: "production", NAVER_COMMERCE_SYNC_ENABLED: "true",
    NAVER_COMMERCE_CLIENT_ID: "client-fixture", NAVER_COMMERCE_CLIENT_SECRET: SECRET,
  };
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_CLIENT_ID: "" }).map((e) => e.code).join(), /CLIENT_ID_MISSING/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_CLIENT_SECRET: "" }).map((e) => e.code).join(), /CLIENT_SECRET_MISSING/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_AUTH_TYPE: "OTHER" }).map((e) => e.code).join(), /AUTH_TYPE_INVALID/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_AUTH_TYPE: "SELLER" }).map((e) => e.code).join(), /ACCOUNT_ID_MISSING/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_API_BASE_URL: "http://localhost" }).map((e) => e.code).join(), /BASE_URL_INVALID/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_API_BASE_URL: "https://mock.invalid/external" }).map((e) => e.code).join(), /BASE_URL_INVALID/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_REQUEST_TIMEOUT_MS: "0" }).map((e) => e.code).join(), /TIMEOUT_INVALID/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_CLIENT_ID: "your-client-id" }).map((e) => e.code).join(), /PLACEHOLDER/);
});

test("connection endpoint enforces permission and returns no credentials", async () => {
  let calls = 0;
  salesChannelsRoute.setClientFactoryForTest(() => ({
    getConnectionStatus: async () => {
      calls += 1;
      return { channel: "naver", enabled: true, configured: true, connected: true, authType: "SELF", tokenExpiresAt: "2026-07-29T10:00:00.000Z", traceId: null };
    },
  }));
  const response = await request(app).get("/api/sales-channels/naver/connection")
    .set("Authorization", `Bearer ${legacyToken("viewer")}`).expect(200);
  assert.equal(calls, 1);
  assert.equal(response.body.connected, true);
  assert.equal("accessToken" in response.body, false);
  assert.equal("clientSecret" in response.body, false);
  assert.equal("clientId" in response.body, false);
  await request(app).get("/api/sales-channels/naver/connection").expect(401);
  const audit = db.prepare("SELECT message FROM activity_logs WHERE action='naver_connection_check_succeeded' ORDER BY created_at DESC").get();
  assert.ok(audit);
  assert.equal(audit.message.includes(SECRET), false);
  salesChannelsRoute.setClientFactoryForTest(null);
});

test("disabled connection status performs no external call and exposes no configuration", async () => {
  let calls = 0;
  const client = createNaverCommerceClient({
    config: config({ enabled: false, clientId: "", clientSecret: "" }),
    fetchImpl: async () => { calls += 1; return tokenResponse(); },
  });
  const status = await client.getConnectionStatus();
  assert.deepEqual(status, {
    channel: "naver", enabled: false, configured: false, connected: false,
    authType: "SELF", tokenExpiresAt: null, traceId: null,
  });
  assert.equal(calls, 0);
  await assert.rejects(client.request("/v1/seller/account"), (error) => error.code === "NAVER_SYNC_DISABLED");
});

test("route default client is a process singleton and factory reset restores it", async () => {
  const first = salesChannelsRoute.getDefaultClientForTest();
  salesChannelsRoute.setClientFactoryForTest(() => ({ getConnectionStatus: async () => ({ connected: true }) }));
  salesChannelsRoute.setClientFactoryForTest(null);
  assert.equal(salesChannelsRoute.getDefaultClientForTest(), first);
});

test("repeated and concurrent connection checks share one client token cache and single-flight", async () => {
  let tokenFetches = 0;
  const sharedClient = createNaverCommerceClient({
    config: config(),
    fetchImpl: async () => {
      tokenFetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return tokenResponse();
    },
  });
  salesChannelsRoute.setClientFactoryForTest(() => sharedClient);
  const auth = { Authorization: `Bearer ${legacyToken()}` };
  await request(app).get("/api/sales-channels/naver/connection").set(auth).expect(200);
  await request(app).get("/api/sales-channels/naver/connection").set(auth).expect(200);
  assert.equal(tokenFetches, 1);

  sharedClient.clearTokenCache();
  tokenFetches = 0;
  await Promise.all([
    request(app).get("/api/sales-channels/naver/connection").set(auth).expect(200),
    request(app).get("/api/sales-channels/naver/connection").set(auth).expect(200),
  ]);
  assert.equal(tokenFetches, 1);
  salesChannelsRoute.setClientFactoryForTest(null);
});

test("caller AbortSignal is preserved and classified separately from timeout", async () => {
  const controller = new AbortController();
  let apiSignal;
  let calls = 0;
  const client = createNaverCommerceClient({
    config: config({ requestTimeoutMs: 1000 }),
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) return tokenResponse();
      apiSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    },
  });
  const pending = client.request("/v1/read", { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "NAVER_REQUEST_ABORTED"
    && error.category === "REQUEST_ABORTED" && error.retryable === false);
  assert.equal(apiSignal.aborted, true);
});

test("an already aborted caller signal prevents every external fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = createNaverCommerceClient({
    config: config(),
    fetchImpl: async () => { calls += 1; return tokenResponse(); },
  });
  await assert.rejects(client.request("/v1/read", { signal: controller.signal }),
    (error) => error.code === "NAVER_REQUEST_ABORTED" && error.category !== "TIMEOUT");
  assert.equal(calls, 0);
});

test("completed requests clear the timeout timer without later aborting the fetch signal", async () => {
  let completedSignal;
  let calls = 0;
  const client = createNaverCommerceClient({
    config: config({ requestTimeoutMs: 10 }),
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) return tokenResponse();
      completedSignal = options.signal;
      return jsonResponse({ ok: true });
    },
  });
  await client.request("/v1/read");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(completedSignal.aborted, false);
});

test("token_type only accepts case-insensitive Bearer", async () => {
  for (const tokenType of ["Bearer", "bearer", "BEARER", undefined]) {
    const client = createNaverCommerceClient({
      config: config(),
      fetchImpl: async () => jsonResponse({
        access_token: "fixture-token",
        expires_in: 10800,
        ...(tokenType === undefined ? {} : { token_type: tokenType }),
      }),
    });
    assert.equal((await client.getAccessToken()).tokenType, tokenType || "Bearer");
  }
  const invalid = createNaverCommerceClient({
    config: config(),
    fetchImpl: async () => jsonResponse({ access_token: "fixture-token", expires_in: 10800, token_type: "Basic" }),
  });
  await assert.rejects(invalid.getAccessToken(),
    (error) => error.code === "NAVER_TOKEN_RESPONSE_INVALID" && error.category === "INVALID_RESPONSE");
});

test("expires_in rejects non-numeric types and unsafe expiry calculations", async () => {
  for (const expiresIn of [true, {}, [], "", Infinity, -1, 0, NaN]) {
    const client = createNaverCommerceClient({
      config: config(),
      fetchImpl: async () => jsonResponse({ access_token: "fixture-token", expires_in: expiresIn, token_type: "Bearer" }),
    });
    await assert.rejects(client.getAccessToken(),
      (error) => error.code === "NAVER_TOKEN_RESPONSE_INVALID" && error.category === "INVALID_RESPONSE");
  }
  const overflow = createNaverCommerceClient({
    config: config(),
    now: () => Number.MAX_SAFE_INTEGER - 500,
    fetchImpl: async () => tokenResponse("fixture-token", 1),
  });
  await assert.rejects(overflow.getAccessToken(),
    (error) => error.code === "NAVER_TOKEN_RESPONSE_INVALID");
});
