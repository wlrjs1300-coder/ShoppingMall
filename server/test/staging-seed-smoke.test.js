process.env.NODE_ENV = "production";
process.env.APP_ENV = "staging";
process.env.ALLOW_STAGING_SEED = "true";
process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "staging-smoke-test-jwt-secret-at-least-32-bytes";
process.env.AUTH_CODE_PEPPER = "staging-smoke-test-pepper-at-least-32-bytes";
process.env.ADMIN_JWT_ISSUER = "staging-smoke-test-admin";
process.env.ADMIN_JWT_AUDIENCE = "staging-smoke-test-api";
process.env.ORDER_PII_PROTECTION_ENABLED = "true";
process.env.ORDER_PII_KEYS_JSON = JSON.stringify([{ version: "staging-v1", key: Buffer.alloc(32, 41).toString("base64") }]);
process.env.ORDER_PII_ACTIVE_KEY_VERSION = "staging-v1";
process.env.PAYMENT_MODE = "disabled";
process.env.TOSS_MOCK_MODE = "false";
process.env.NOTIFICATION_MODE = "none";
process.env.EMAIL_MODE = "disabled";
process.env.NAVER_COMMERCE_SYNC_ENABLED = "false";
process.env.NAVER_ORDER_IMPORT_ENABLED = "false";
for (const key of [
  "TOSS_CLIENT_KEY", "TOSS_SECRET_KEY", "SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER_PHONE",
  "KAKAO_PLUS_FRIEND_ID", "KAKAO_TEMPLATE_ORDER", "KAKAO_TEMPLATE_READY", "KAKAO_TEMPLATE_REMIND",
  "RESEND_API_KEY", "PASSWORD_RESET_FROM", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "KAKAO_CLIENT_ID", "KAKAO_CLIENT_SECRET", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET",
  "NAVER_COMMERCE_CLIENT_ID", "NAVER_COMMERCE_CLIENT_SECRET", "NAVER_COMMERCE_ACCOUNT_ID",
  "NAVER_ORDER_PII_KEY", "NAVER_ORDER_PII_KEY_VERSION",
]) process.env[key] = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const db = require("../db");
const app = require("../index");
const { assertStagingSeedAllowed } = require("../scripts/production-guard");
const { ACCOUNTS, ORDER_IDS, runStagingSyntheticSeed } = require("../scripts/seed-staging-synthetic");
const { createRequester, runStagingSmoke, smokeTimeoutMs, stagingBaseUrl } = require("../scripts/run-staging-smoke");

const scriptRoot = path.resolve(__dirname, "../scripts");
const passwords = Object.fromEntries(ACCOUNTS.map((account, index) => [account.passwordKey, `StagingPassword${index + 1}!`]));
const seedEnv = { ...process.env, ...passwords };

function clearFixtures() {
  db.prepare("DELETE FROM payments WHERE id LIKE 'staging-synthetic-%'").run();
  db.prepare("DELETE FROM orders WHERE id LIKE 'staging-synthetic-%'").run();
  db.prepare("DELETE FROM user_accounts WHERE id LIKE 'staging-synthetic-%'").run();
}

test.beforeEach(clearFixtures);
test.after(() => { clearFixtures(); db.close(); });

test("staging seed guard requires production, staging and exact explicit opt-in", () => {
  assert.doesNotThrow(() => assertStagingSeedAllowed("fixture", {
    NODE_ENV: "production", APP_ENV: "staging", ALLOW_STAGING_SEED: "true",
  }));
  for (const env of [
    { NODE_ENV: "production", APP_ENV: "production", ALLOW_STAGING_SEED: "true" },
    { NODE_ENV: "development", APP_ENV: "staging", ALLOW_STAGING_SEED: "true" },
    { NODE_ENV: "production", APP_ENV: "staging" },
    { NODE_ENV: "production", APP_ENV: "staging", ALLOW_STAGING_SEED: "TRUE" },
    { NODE_ENV: "production", APP_ENV: "staging", ALLOW_STAGING_SEED: "false" },
  ]) assert.throws(() => assertStagingSeedAllowed("fixture", env), /staging|승인/);
});

test("staging seed CLIs fail before opening a database outside the approved environment", () => {
  for (const name of ["seed-staging-synthetic.js", "run-staging-smoke.js"]) {
    const missing = path.join(os.tmpdir(), `staging-guard-${name}-${Date.now()}`, "must-not-exist.sqlite");
    const result = spawnSync(process.execPath, [path.join(scriptRoot, name)], {
      env: { ...process.env, NODE_ENV: "production", APP_ENV: "production", ALLOW_STAGING_SEED: "true", DB_PATH: missing },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, name);
    assert.equal(fs.existsSync(missing), false, name);
    assert.equal(`${result.stdout}${result.stderr}`.includes(missing), false, name);
  }
});

test("synthetic seed is idempotent and creates fixed role, order and payment fixtures", () => {
  const first = runStagingSyntheticSeed({ db, env: seedEnv, bcryptRounds: 4 });
  const second = runStagingSyntheticSeed({ db, env: seedEnv, bcryptRounds: 4 });
  assert.equal(first.accounts, 5);
  assert.equal(second.created, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM user_accounts WHERE id LIKE 'staging-synthetic-%'").get().count, 5);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM admin_accounts WHERE user_id LIKE 'staging-synthetic-%'").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE id LIKE 'staging-synthetic-%'").get().count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payments WHERE id LIKE 'staging-synthetic-%'").get().count, 1);
  assert.deepEqual(db.prepare("SELECT role FROM admin_accounts WHERE user_id LIKE 'staging-synthetic-%' ORDER BY role").all().map((row) => row.role),
    ["finance", "operations", "super_admin", "viewer"]);
  const encrypted = db.prepare("SELECT customer_name,pii_ciphertext,pii_key_version FROM orders WHERE id=?").get(ORDER_IDS.encrypted);
  assert.equal(encrypted.customer_name, "[protected]");
  assert.ok(encrypted.pii_ciphertext);
  assert.equal(encrypted.pii_key_version, "staging-v1");
  const payment = db.prepare("SELECT customer_name,customer_phone FROM payments WHERE order_id=?").get(ORDER_IDS.legacy);
  assert.ok(payment.customer_name && payment.customer_phone);
});

test("synthetic seed rejects collisions and rolls back every partial fixture", () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user_accounts
    (id,username,email,password_hash,name,phone,role,status,terms_agreed_at,privacy_agreed_at,marketing_consent,created_at,updated_at)
    VALUES ('unrelated','staging_super_admin','unrelated@example.test','hash','Unrelated','01099999999','customer','active',?,?,0,?,?)`)
    .run(now, now, now, now);
  assert.throws(() => runStagingSyntheticSeed({ db, env: seedEnv, bcryptRounds: 4 }), /충돌/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM user_accounts WHERE id LIKE 'staging-synthetic-%'").get().count, 0);
  db.prepare("DELETE FROM user_accounts WHERE id='unrelated'").run();

  db.exec(`CREATE TEMP TRIGGER fail_staging_order BEFORE INSERT ON orders
    WHEN NEW.id LIKE 'staging-synthetic-%' BEGIN SELECT RAISE(ABORT, 'injected staging failure'); END`);
  try {
    assert.throws(() => runStagingSyntheticSeed({ db, env: seedEnv, bcryptRounds: 4 }), /injected staging failure/);
  } finally { db.exec("DROP TRIGGER fail_staging_order"); }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM user_accounts WHERE id LIKE 'staging-synthetic-%'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE id LIKE 'staging-synthetic-%'").get().count, 0);
});

test("seed summary and source expose no password, key or provider call", () => {
  const result = runStagingSyntheticSeed({ db, env: seedEnv, bcryptRounds: 4 });
  const report = JSON.stringify(result);
  for (const secret of [...Object.values(passwords), process.env.ORDER_PII_KEYS_JSON]) assert.equal(report.includes(secret), false);
  const source = fs.readFileSync(path.join(scriptRoot, "seed-staging-synthetic.js"), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|toss\.|SOLAPI|RESEND|oauth2\/token/);
});

test("staging URL requires a bound HTTPS staging hostname outside tests", () => {
  assert.equal(stagingBaseUrl({ STAGING_BASE_URL: "https://shop-staging.realstore.kr", PUBLIC_BASE_URL: "https://shop-staging.realstore.kr" }), "https://shop-staging.realstore.kr");
  for (const url of ["https://shop.realstore.kr", "http://shop-staging.realstore.kr", "https://localhost", "https://staging.example.com/path"]) {
    assert.throws(() => stagingBaseUrl({ STAGING_BASE_URL: url, PUBLIC_BASE_URL: url }), /STAGING_BASE_URL/);
  }
});

test("smoke timeout validates bounds and aborts a hanging request safely", async () => {
  assert.equal(smokeTimeoutMs({}), 10000);
  assert.equal(smokeTimeoutMs({ STAGING_SMOKE_TIMEOUT_MS: "25" }), 25);
  for (const value of ["0", "-1", "1.5", "60001", "invalid"]) {
    assert.throws(() => smokeTimeoutMs({ STAGING_SMOKE_TIMEOUT_MS: value }), /STAGING_SMOKE_TIMEOUT_MS/);
  }
  const requester = createRequester("https://shop-staging.realstore.kr", (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }), { timeoutMs: 10 });
  const secret = "must-not-appear-token-cookie-pii";
  await assert.rejects(
    requester.send("/api/health", { token: secret, cookie: secret, body: { pii: secret } }),
    (error) => error.safeCategory === "REQUEST_TIMEOUT" && !String(error).includes(secret),
  );
});

test("requester uses exact dynamic routes and blocks provider-triggering routes before fetch", async () => {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url.pathname);
    return { status: 200 };
  };
  const requester = createRequester("https://shop-staging.realstore.kr", fetchImpl);
  for (const route of [
    `/api/payments/${ORDER_IDS.legacy}`,
    `/api/orders/${ORDER_IDS.encrypted}/pii-access`,
    `/api/orders/${ORDER_IDS.update}/pii-access`,
    `/api/orders/${ORDER_IDS.update}/pii`,
  ]) await requester.send(route);
  assert.equal(fetched.length, 4);

  const dangerous = [
    "/api/payments/order/confirm", "/api/payments/order/reconcile", "/api/payments/order/cancel",
    "/api/payments/webhook", "/api/naver/sync", "/api/oauth/login", "/api/orders/import",
  ];
  for (const route of dangerous) {
    await assert.rejects(requester.send(route), (error) => error.safeCategory === "PROVIDER_TRIGGERING_ROUTE_BLOCKED");
  }
  assert.equal(requester.providerTriggeringCount(), dangerous.length);
  assert.equal(fetched.length, 4);
  await assert.rejects(requester.send("/api/orders/unapproved/pii-access"), /smoke/);
  assert.equal(fetched.length, 4);
});

test("staging smoke validates health, auth, RBAC, masked PII and zero provider-triggering requests", async () => {
  runStagingSyntheticSeed({ db, env: seedEnv, bcryptRounds: 4 });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await runStagingSmoke({
      env: { ...seedEnv, STAGING_BASE_URL: baseUrl, PUBLIC_BASE_URL: baseUrl },
      fetchImpl: globalThis.fetch,
      allowInsecureForTests: true,
    });
    assert.equal(result.failed, 0);
    assert.equal(result.passed, result.checksTotal);
    assert.equal(result.schemaVersion, 16);
    assert.equal(result.providerTriggeringRequests, 0);
    assert.ok(result.stagingRequests > result.checksTotal);
    const report = JSON.stringify(result);
    for (const secret of [...Object.values(passwords), "Encrypted Synthetic Customer", "01000002002"]) assert.equal(report.includes(secret), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("package exposes manual staging commands without startup hooks", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.scripts["staging:seed"], "node scripts/seed-staging-synthetic.js");
  assert.equal(pkg.scripts["staging:smoke"], "node scripts/run-staging-smoke.js");
  assert.doesNotMatch(`${pkg.scripts.start} ${pkg.scripts.dev}`, /staging:(?:seed|smoke)/);
});
