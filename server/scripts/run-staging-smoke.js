const { ACCOUNTS, ORDER_IDS } = require("./seed-staging-synthetic");

const EXPECTED_SCHEMA_VERSION = 16;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 60000;
const SAFE_PATHS = Object.freeze([
  "/api/health", "/api/products", "/api/users/login", "/api/users/me", "/api/users/logout",
  "/api/users/admin-session", "/api/auth/me", "/api/orders", "/api/inventory",
  "/api/activity-logs", "/api/payments/config",
]);
const PROVIDER_TRIGGERING_ROUTE = /(?:^|\/)(?:confirm|reconcile|cancel|webhook|naver|oauth|sync|import)(?:\/|$)/i;

function smokeTimeoutMs(env = process.env) {
  const raw = String(env.STAGING_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!/^\d+$/.test(raw)) throw new Error("STAGING_SMOKE_TIMEOUT_MS must be a positive integer.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`STAGING_SMOKE_TIMEOUT_MS must be between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return value;
}

function stagingBaseUrl(env = process.env, { allowInsecureForTests = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(env.STAGING_BASE_URL || ""));
  } catch {
    throw new Error("STAGING_BASE_URL 설정이 올바르지 않습니다.");
  }
  if ((!allowInsecureForTests && parsed.protocol !== "https:")
    || (allowInsecureForTests && !["http:", "https:"].includes(parsed.protocol))
    || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("STAGING_BASE_URL은 허용된 staging HTTPS origin이어야 합니다.");
  }
  const publicBase = String(env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (parsed.origin !== publicBase) throw new Error("STAGING_BASE_URL은 현재 staging PUBLIC_BASE_URL과 일치해야 합니다.");
  if (!allowInsecureForTests) {
    const firstLabel = parsed.hostname.toLowerCase().split(".")[0];
    if (firstLabel !== "staging" && !firstLabel.endsWith("-staging")) {
      throw new Error("STAGING_BASE_URL은 staging 전용 hostname을 사용해야 합니다.");
    }
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || /\.example(?:\.|$)/i.test(parsed.hostname)) {
      throw new Error("STAGING_BASE_URL은 로컬 또는 예제 hostname을 사용할 수 없습니다.");
    }
  }
  return parsed.origin;
}

function smokePasswords(env) {
  const result = new Map();
  for (const account of ACCOUNTS) {
    const password = env[account.passwordKey];
    if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password) > 72) {
      throw new Error(`staging smoke credential 설정이 올바르지 않습니다: ${account.passwordKey}`);
    }
    result.set(account.username, password);
  }
  return result;
}

function assertProviderDisabled(env) {
  const expected = [
    ["PAYMENT_MODE", "disabled"], ["TOSS_MOCK_MODE", "false"],
    ["NOTIFICATION_MODE", "none"], ["EMAIL_MODE", "disabled"],
    ["NAVER_COMMERCE_SYNC_ENABLED", "false"], ["NAVER_ORDER_IMPORT_ENABLED", "false"],
  ];
  if (expected.some(([key, value]) => String(env[key] || "").trim().toLowerCase() !== value)) {
    throw new Error("staging provider-disabled 계약이 충족되지 않았습니다.");
  }
  const credentialKeys = [
    "TOSS_CLIENT_KEY", "TOSS_SECRET_KEY", "SOLAPI_API_KEY", "SOLAPI_API_SECRET",
    "SOLAPI_SENDER_PHONE", "KAKAO_PLUS_FRIEND_ID", "KAKAO_TEMPLATE_ORDER",
    "KAKAO_TEMPLATE_READY", "KAKAO_TEMPLATE_REMIND", "RESEND_API_KEY", "PASSWORD_RESET_FROM",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "KAKAO_CLIENT_ID", "KAKAO_CLIENT_SECRET",
    "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET", "NAVER_COMMERCE_CLIENT_ID",
    "NAVER_COMMERCE_CLIENT_SECRET", "NAVER_COMMERCE_ACCOUNT_ID", "NAVER_ORDER_PII_KEY",
    "NAVER_ORDER_PII_KEY_VERSION",
  ];
  if (credentialKeys.some((key) => String(env[key] || "").trim())) {
    throw new Error("staging provider credential은 설정할 수 없습니다.");
  }
}

function createRequester(baseUrl, fetchImpl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let requests = 0;
  let providerTriggeringRequests = 0;
  const dynamicPaths = new Set([
    `/api/payments/${ORDER_IDS.legacy}`,
    `/api/orders/${ORDER_IDS.encrypted}/pii-access`,
    `/api/orders/${ORDER_IDS.update}/pii-access`,
    `/api/orders/${ORDER_IDS.update}/pii`,
  ]);
  return {
    count: () => requests,
    providerTriggeringCount: () => providerTriggeringRequests,
    async send(path, { method = "GET", body, token, cookie } = {}) {
      if (PROVIDER_TRIGGERING_ROUTE.test(path)) {
        providerTriggeringRequests += 1;
        const error = new Error("provider-triggering smoke route blocked");
        error.safeCategory = "PROVIDER_TRIGGERING_ROUTE_BLOCKED";
        throw error;
      }
      if (!SAFE_PATHS.includes(path) && !dynamicPaths.has(path) && !path.startsWith("/server/")
        && path !== "/.env" && !path.startsWith("/docs/")) {
        throw new Error("허용되지 않은 smoke 요청 경로입니다.");
      }
      const target = new URL(path, baseUrl);
      if (target.origin !== baseUrl) throw new Error("staging origin 밖의 요청이 차단되었습니다.");
      requests += 1;
      try {
        return await fetchImpl(target, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(cookie ? { cookie } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (cause) {
        if (cause?.name === "AbortError" || cause?.name === "TimeoutError") {
          const error = new Error("staging smoke request timed out");
          error.safeCategory = "REQUEST_TIMEOUT";
          throw error;
        }
        throw cause;
      }
    },
  };
}

async function safeJson(response) {
  try { return await response.json(); } catch { throw new Error("응답 형식이 올바르지 않습니다."); }
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function runStagingSmoke({ env = process.env, fetchImpl = globalThis.fetch, allowInsecureForTests = false } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("HTTP smoke transport를 사용할 수 없습니다.");
  const baseUrl = stagingBaseUrl(env, { allowInsecureForTests });
  assertProviderDisabled(env);
  const passwords = smokePasswords(env);
  const requester = createRequester(baseUrl, fetchImpl, { timeoutMs: smokeTimeoutMs(env) });
  const checks = [];
  const check = async (name, action) => {
    try { await action(); checks.push({ name, passed: true }); }
    catch (error) { const wrapped = new Error(`smoke check failed: ${name}`); wrapped.cause = error; wrapped.checkName = name; wrapped.httpStatus = error.httpStatus; wrapped.safeCategory = error.safeCategory; throw wrapped; }
  };
  const expectStatus = (response, status) => {
    if (response.status !== status) {
      const error = new Error("unexpected HTTP status");
      error.httpStatus = response.status;
      throw error;
    }
  };

  await check("health", async () => {
    const response = await requester.send("/api/health");
    expectStatus(response, 200);
    const body = await safeJson(response);
    if (body.ok !== true || body.database !== "ready" || body.schemaVersion !== EXPECTED_SCHEMA_VERSION) throw new Error("health contract mismatch");
  });
  await check("public-products", async () => {
    const response = await requester.send("/api/products");
    expectStatus(response, 200);
    const body = await safeJson(response);
    if (!Array.isArray(body.products) || !body.products.length
      || body.products.some((item) => item.status === "inactive" || "password_hash" in item)) throw new Error("product contract mismatch");
  });
  await check("customer-auth", async () => {
    const customer = ACCOUNTS.find((account) => account.role === "customer");
    const login = await requester.send("/api/users/login", { method: "POST", body: { identifier: customer.username, password: passwords.get(customer.username) } });
    expectStatus(login, 200);
    const cookie = cookieFrom(login);
    if (!cookie) throw new Error("customer cookie missing");
    expectStatus(await requester.send("/api/users/me", { cookie }), 200);
    expectStatus(await requester.send("/api/users/logout", { method: "POST", cookie }), 200);
  });

  const tokens = new Map();
  for (const account of ACCOUNTS.filter((entry) => entry.adminRole)) {
    await check(`admin-auth-${account.adminRole}`, async () => {
      const login = await requester.send("/api/users/login", { method: "POST", body: { identifier: account.username, password: passwords.get(account.username) } });
      expectStatus(login, 200);
      const cookie = cookieFrom(login);
      const exchange = await requester.send("/api/users/admin-session", { method: "POST", cookie });
      expectStatus(exchange, 200);
      const exchangeBody = await safeJson(exchange);
      if (typeof exchangeBody.token !== "string" || exchangeBody.admin?.role !== account.adminRole) throw new Error("admin session mismatch");
      tokens.set(account.adminRole, exchangeBody.token);
      const me = await requester.send("/api/auth/me", { token: exchangeBody.token });
      expectStatus(me, 200);
    });
  }
  await check("rbac", async () => {
    expectStatus(await requester.send("/api/inventory", { method: "POST", token: tokens.get("viewer"), body: {} }), 403);
    expectStatus(await requester.send("/api/orders", { token: tokens.get("operations") }), 200);
    expectStatus(await requester.send("/api/inventory", { token: tokens.get("operations") }), 200);
    expectStatus(await requester.send(`/api/payments/${ORDER_IDS.legacy}`, { token: tokens.get("finance") }), 200);
    expectStatus(await requester.send(`/api/orders/${ORDER_IDS.encrypted}/pii-access`, { method: "POST", token: tokens.get("finance"), body: { reason: "order_issue" } }), 403);
  });
  await check("order-pii", async () => {
    const ordersResponse = await requester.send("/api/orders", { token: tokens.get("operations") });
    expectStatus(ordersResponse, 200);
    const orders = await safeJson(ordersResponse);
    const target = orders.find((order) => order.id === ORDER_IDS.encrypted);
    if (!target || !String(target.customer || "").includes("*")) throw new Error("masked order missing");
    const piiResponse = await requester.send(`/api/orders/${ORDER_IDS.encrypted}/pii-access`, {
      method: "POST", token: tokens.get("operations"), body: { reason: "order_issue" },
    });
    expectStatus(piiResponse, 200);
    if (!String(piiResponse.headers.get("cache-control") || "").includes("no-store")) throw new Error("PII no-store missing");
    const pii = await safeJson(piiResponse);
    if (pii.customer !== "Encrypted Synthetic Customer" || pii.phone !== "01000002002") throw new Error("PII fixture mismatch");
    const audit = await requester.send("/api/activity-logs", { token: tokens.get("operations") });
    expectStatus(audit, 200);
  });
  await check("order-pii-update", async () => {
    const currentResponse = await requester.send(`/api/orders/${ORDER_IDS.update}/pii-access`, {
      method: "POST", token: tokens.get("super_admin"), body: { reason: "order_issue" },
    });
    expectStatus(currentResponse, 200);
    const current = await safeJson(currentResponse);
    const nextCustomer = current.customer === "Updated Synthetic Customer A"
      ? "Updated Synthetic Customer B" : "Updated Synthetic Customer A";
    const update = await requester.send(`/api/orders/${ORDER_IDS.update}/pii`, {
      method: "PATCH", token: tokens.get("super_admin"),
      body: { customer: nextCustomer, reason: "name_correction" },
    });
    expectStatus(update, 200);
    if (!String(update.headers.get("cache-control") || "").includes("no-store")) throw new Error("PII update no-store missing");
    const updated = await safeJson(update);
    if (!Array.isArray(updated.updatedFields) || !updated.updatedFields.includes("customer")
      || !String(updated.customer || "").includes("*")) throw new Error("PII update contract mismatch");
  });
  await check("provider-disabled", async () => {
    const response = await requester.send("/api/payments/config");
    expectStatus(response, 200);
    const body = await safeJson(response);
    if (body.ready !== false || body.clientKey) throw new Error("payment provider unexpectedly ready");
  });
  await check("static-boundary", async () => {
    for (const path of ["/server/config.js", "/.env", "/docs/staging-validation.md"]) {
      expectStatus(await requester.send(path), 404);
    }
  });
  return {
    checksTotal: checks.length,
    passed: checks.length,
    failed: 0,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    providerTriggeringRequests: requester.providerTriggeringCount(),
    stagingRequests: requester.count(),
  };
}

async function main() {
  require("dotenv").config();
  const { assertStagingSeedAllowed } = require("./production-guard");
  assertStagingSeedAllowed("staging smoke");
  try {
    const result = await runStagingSmoke();
    console.log(`Staging smoke passed: checks=${result.checksTotal} passed=${result.passed} failed=${result.failed} schemaVersion=${result.schemaVersion} providerTriggeringRequests=${result.providerTriggeringRequests}`);
  } catch (error) {
    const name = error.checkName || "configuration";
    const status = Number.isInteger(error.httpStatus) ? ` httpStatus=${error.httpStatus}` : "";
    const category = error.safeCategory || "SMOKE_CHECK_FAILED";
    console.error(`Staging smoke failed: check=${name}${status} category=${category}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { EXPECTED_SCHEMA_VERSION, assertProviderDisabled, createRequester, runStagingSmoke, smokePasswords, smokeTimeoutMs, stagingBaseUrl };
