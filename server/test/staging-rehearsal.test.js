const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { checkStagingRehearsal } = require("../scripts/staging-rehearsal-guard");

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "server/scripts/staging-rehearsal-guard.js");
const evidence = path.join(root, "docs/staging-rehearsal-evidence-template.md");
const validation = path.join(root, "docs/staging-validation.md");
const outside = path.join(os.tmpdir(), "shoppingmall-staging-rehearsal-contract");

function validEnv(overrides = {}) {
  const env = {
    NODE_ENV: "production", APP_ENV: "staging",
    DB_PATH: path.join(outside, "data", "staging.sqlite"),
    BACKUP_DIR: path.join(outside, "backups"),
    JWT_SECRET: "staging-rehearsal-jwt-material-01-safe-fixture",
    AUTH_CODE_PEPPER: "staging-rehearsal-pepper-material-02-fixture",
    ALLOWED_ORIGIN: "https://shop-staging.realstore.test",
    PUBLIC_BASE_URL: "https://shop-staging.realstore.test",
    STAGING_BASE_URL: "https://shop-staging.realstore.test",
    STORE_NAME: "Staging Store", STORE_PHONE: "0315551234", STORE_HOURS: "09:00 - 19:00",
    STORE_ADDRESS: "Staging synthetic address",
    ADMIN_JWT_ISSUER: "shoppingmall-staging-admin",
    ADMIN_JWT_AUDIENCE: "shoppingmall-staging-admin-api", ADMIN_TOKEN_TTL: "1h",
    ADMIN_LOGIN_RATE_MAX: "5", ADMIN_LOGIN_RATE_WINDOW_MS: "900000",
    ALLOW_LEGACY_ADMIN_LOGIN: "false", PAYMENT_MODE: "disabled", TOSS_MOCK_MODE: "false",
    NOTIFICATION_MODE: "none", EMAIL_MODE: "disabled",
    NAVER_COMMERCE_SYNC_ENABLED: "false", NAVER_ORDER_IMPORT_ENABLED: "false",
    ORDER_PII_PROTECTION_ENABLED: "false",
    ...overrides,
  };
  for (const key of [
    "ADMIN_CODE", "TOSS_CLIENT_KEY", "TOSS_SECRET_KEY", "SOLAPI_API_KEY", "SOLAPI_API_SECRET",
    "SOLAPI_SENDER_PHONE", "KAKAO_PLUS_FRIEND_ID", "KAKAO_TEMPLATE_ORDER", "KAKAO_TEMPLATE_READY",
    "KAKAO_TEMPLATE_REMIND", "RESEND_API_KEY", "PASSWORD_RESET_FROM", "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET", "KAKAO_CLIENT_ID", "KAKAO_CLIENT_SECRET", "NAVER_CLIENT_ID",
    "NAVER_CLIENT_SECRET", "NAVER_COMMERCE_CLIENT_ID", "NAVER_COMMERCE_CLIENT_SECRET",
    "NAVER_COMMERCE_ACCOUNT_ID", "NAVER_ORDER_PII_KEY", "NAVER_ORDER_PII_KEY_VERSION",
    "DEMO_MODE", "PHONE_TEST_CODE", "PASSWORD_RESET_TEST_TOKEN", "ALLOW_PORTFOLIO_SEED",
  ]) if (!Object.hasOwn(env, key)) env[key] = "";
  return env;
}

test("staging rehearsal guard returns only a fixed safe readiness summary", () => {
  assert.deepEqual(checkStagingRehearsal(validEnv()), {
    appEnvironment: "staging", databaseIdentity: "staging", backupIdentity: "external",
    providers: "disabled", baseUrlStatus: "matched", ready: true,
  });
});

test("staging rehearsal guard rejects production APP_ENV and non-production runtime", () => {
  assert.throws(() => checkStagingRehearsal(validEnv({ APP_ENV: "production" })),
    (error) => error.code === "STAGING_APP_ENV_REQUIRED");
  assert.throws(() => checkStagingRehearsal(validEnv({ NODE_ENV: "development" })),
    (error) => error.code === "STAGING_RUNTIME_REQUIRED");
});

test("staging rehearsal guard rejects unsafe DB and backup identities", () => {
  assert.throws(() => checkStagingRehearsal(validEnv({ DB_PATH: path.join(outside, "data", "app.sqlite") })),
    (error) => error.code === "STAGING_CONFIGURATION_INVALID");
  assert.throws(() => checkStagingRehearsal(validEnv({ DB_PATH: "relative-staging.sqlite" })),
    (error) => error.code === "STAGING_CONFIGURATION_INVALID");
  assert.throws(() => checkStagingRehearsal(validEnv({ BACKUP_DIR: path.join(outside, "data") })),
    (error) => error.code === "STAGING_CONFIGURATION_INVALID");
  assert.throws(() => checkStagingRehearsal(validEnv({ DB_PATH: path.join(root, "staging.sqlite") })),
    (error) => error.code === "STAGING_CONFIGURATION_INVALID");
});

test("staging rehearsal guard rejects provider activation and credentials", () => {
  assert.throws(() => checkStagingRehearsal(validEnv({ PAYMENT_MODE: "toss" })),
    (error) => ["STAGING_CONFIGURATION_INVALID", "STAGING_PROVIDERS_NOT_DISABLED"].includes(error.code));
  assert.throws(() => checkStagingRehearsal(validEnv({ TOSS_SECRET_KEY: "must-not-leak" })),
    (error) => ["STAGING_CONFIGURATION_INVALID", "STAGING_PROVIDERS_NOT_DISABLED"].includes(error.code));
});

test("staging rehearsal guard rejects URL mismatch and production-looking hostnames", () => {
  assert.throws(() => checkStagingRehearsal(validEnv({ STAGING_BASE_URL: "https://other-staging.realstore.test" })),
    (error) => error.code === "STAGING_BASE_URL_INVALID");
  assert.throws(() => checkStagingRehearsal(validEnv({
    PUBLIC_BASE_URL: "https://shop-staging.production.test",
    ALLOWED_ORIGIN: "https://shop-staging.production.test",
    STAGING_BASE_URL: "https://shop-staging.production.test",
  })), (error) => error.code === "STAGING_BASE_URL_INVALID");
});

test("guard CLI creates no DB or backup path and exposes no configured values", () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "staging-rehearsal-guard-test-"));
  const env = validEnv({
    DB_PATH: path.join(isolated, "missing", "staging-private.sqlite"),
    BACKUP_DIR: path.join(isolated, "missing-backups"),
  });
  const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.equal(fs.existsSync(path.dirname(env.DB_PATH)), false);
  assert.equal(fs.existsSync(env.BACKUP_DIR), false);
  for (const value of [env.DB_PATH, env.BACKUP_DIR, env.PUBLIC_BASE_URL, env.JWT_SECRET]) {
    assert.equal(output.includes(value), false);
  }
});

test("guard source has no DB open, external fetch or filesystem write", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.doesNotMatch(source, /require\(["']\.\.\/db["']\)|DatabaseSync|\bfetch\s*\(|writeFile|mkdir|copyFile/);
});

test("package exposes a manual rehearsal check without startup or deploy hooks", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.scripts["staging:rehearsal:check"], "node scripts/staging-rehearsal-guard.js");
  assert.doesNotMatch(`${pkg.scripts.start} ${pkg.scripts.dev} ${pkg.scripts["deploy:check"]}`,
    /staging:rehearsal:check/);
});

test("evidence template is empty, bounded and contains no credential examples", () => {
  const body = fs.readFileSync(evidence, "utf8");
  assert.match(body, /Document metadata/);
  assert.match(body, /NOT_STARTED/);
  assert.match(body, /Repository-safe/);
  assert.match(body, /Private-only/);
  assert.match(body, /Prohibited/);
  assert.doesNotMatch(body, /Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.|-----BEGIN|[A-Za-z0-9+/]{43}=/);
  assert.doesNotMatch(body, /status:\s*(?:PASS|FAIL|BLOCKED|SKIPPED)\b/);
});

test("staging validation documents phases, opt-in lifecycle and isolated DR boundaries", () => {
  const body = fs.readFileSync(validation, "utf8");
  for (let phase = 0; phase <= 13; phase += 1) assert.match(body, new RegExp(`Phase ${phase}\\b`));
  for (const phrase of [
    "smoke 완료 직후", "production에서는 어떤 경우에도", "자동 restore CLI 없음",
    "HTTP restore route 없음", "manual platform step", "different failure domain",
    "providerTriggeringRequests", "Safe summary schema",
  ]) assert.ok(body.includes(phrase), phrase);
});
