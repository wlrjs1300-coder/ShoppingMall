process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "deployment-test-jwt-secret-at-least-32-bytes";
process.env.AUTH_CODE_PEPPER = "deployment-test-pepper-at-least-32-bytes";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const {
  assertProductionConfig,
  nodeVersionError,
  productionConfigErrors,
  productionReadinessReport,
  naverCommerceConfigErrors,
  naverOrderImportConfigErrors,
  orderPiiConfigErrors,
  getAppEnvironment,
} = require("../config");
const { assertStagingScript } = require("../scripts/production-guard");
const { runMigrations, migrations } = require("../migrations");

const root = path.resolve(__dirname, "../..");

test("Node.js backup API minimum version contract is enforced", () => {
  assert.equal(nodeVersionError("24.15.0"), null);
  assert.equal(nodeVersionError("22.16.0"), null);
  assert.match(nodeVersionError("22.15.9"), /22\.16\.0.*22\.15\.9/);
  assert.match(nodeVersionError("22.5.0"), /22\.16\.0.*22\.5\.0/);
  assert.match(nodeVersionError("invalid"), /22\.16\.0.*invalid/);
});

function validProductionEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    APP_ENV: "production",
    ADMIN_CODE: "strong-admin-code-2026",
    JWT_SECRET: "j".repeat(40),
    AUTH_CODE_PEPPER: "p".repeat(40),
    ALLOWED_ORIGIN: "https://shop.realstore.kr",
    PUBLIC_BASE_URL: "https://shop.realstore.kr",
    DB_PATH: path.join(path.parse(root).root, "data", "tteokjip.db"),
    BACKUP_DIR: path.join(path.parse(root).root, "shoppingmall-backups"),
    STORE_NAME: "따뜻한 떡집",
    STORE_PHONE: "031-123-4567",
    STORE_HOURS: "09:00 - 19:00",
    STORE_ADDRESS: "경기도 화성시 떡길 12",
    PAYMENT_MODE: "disabled",
    NOTIFICATION_MODE: "none",
    EMAIL_MODE: "disabled",
    ADMIN_JWT_ISSUER: "shoppingmall-admin",
    ADMIN_JWT_AUDIENCE: "shoppingmall-admin-api",
    ADMIN_TOKEN_TTL: "1h",
    ADMIN_LOGIN_RATE_MAX: "5",
    ADMIN_LOGIN_RATE_WINDOW_MS: "900000",
    ...overrides,
  };
}

test("운영 필수 환경변수가 누락되면 시작 검증이 실패한다", () => {
  const errors = productionConfigErrors({ NODE_ENV: "production" });
  assert.ok(errors.some((message) => message.startsWith("JWT_SECRET")));
  assert.ok(errors.some((message) => message.startsWith("DB_PATH")));
  assert.ok(errors.some((message) => message.startsWith("ALLOWED_ORIGIN")));
});

test("개발·테스트 환경에서는 운영 설정 검증을 실행하지 않는다", () => {
  assert.deepEqual(productionConfigErrors({ NODE_ENV: "development" }), []);
  assert.deepEqual(productionConfigErrors({ NODE_ENV: "test" }), []);
});

test("완전한 운영 환경변수는 시작 검증을 통과한다", () => {
  assert.deepEqual(productionConfigErrors(validProductionEnv()), []);
});

test("APP_ENV는 local과 test 기본값을 유지하고 production runtime을 fail closed한다", () => {
  assert.equal(getAppEnvironment({ NODE_ENV: "development" }), "local");
  assert.equal(getAppEnvironment({ NODE_ENV: "test" }), "test");
  assert.equal(getAppEnvironment({ NODE_ENV: "production", APP_ENV: "StAgInG" }), "staging");
  assert.match(productionConfigErrors(validProductionEnv({ APP_ENV: "" })).join(" "), /APP_ENV/);
  assert.match(productionConfigErrors(validProductionEnv({ APP_ENV: "unknown" })).join(" "), /APP_ENV/);
});

test("staging은 provider outbound와 provider credential을 모두 차단한다", () => {
  const base = validProductionEnv({
    APP_ENV: "staging",
    DB_PATH: path.join(path.parse(root).root, "data", "staging.sqlite"),
  });
  assert.deepEqual(productionConfigErrors(base), []);
  for (const overrides of [
    { PAYMENT_MODE: "toss", TOSS_CLIENT_KEY: "live-client", TOSS_SECRET_KEY: "live-secret", TOSS_MOCK_MODE: "false" },
    { TOSS_MOCK_MODE: "true" },
    { NOTIFICATION_MODE: "sms", SOLAPI_API_KEY: "key" },
    { EMAIL_MODE: "resend", RESEND_API_KEY: "key" },
    { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" },
    { NAVER_COMMERCE_SYNC_ENABLED: "true" },
    { NAVER_ORDER_IMPORT_ENABLED: "true" },
  ]) {
    assert.match(productionConfigErrors({ ...base, ...overrides }).join(" "), /staging/);
  }
});

test("staging과 production DB 파일 marker를 교차 사용하지 않는다", () => {
  assert.match(productionConfigErrors(validProductionEnv({
    APP_ENV: "staging",
    DB_PATH: path.join(path.parse(root).root, "data", "tteokjip.sqlite"),
  })).join(" "), /staging 표시/);
  assert.match(productionConfigErrors(validProductionEnv({
    DB_PATH: path.join(path.parse(root).root, "data", "staging.sqlite"),
  })).join(" "), /staging DB_PATH/);
});

test("staging script guard는 production runtime과 staging marker를 함께 요구한다", () => {
  assert.doesNotThrow(() => assertStagingScript("staging fixture", {
    NODE_ENV: "production", APP_ENV: "staging", ALLOW_STAGING_SEED: "true",
  }));
  for (const env of [
    { NODE_ENV: "development", APP_ENV: "staging" },
    { NODE_ENV: "production", APP_ENV: "production" },
    { NODE_ENV: "production" },
  ]) {
    assert.throws(() => assertStagingScript("staging fixture", env), /승인된 staging 환경/);
  }
});

test("운영 환경에서 모의 결제 모드를 차단한다", () => {
  const env = validProductionEnv({ TOSS_MOCK_MODE: "true" });
  assert.match(productionConfigErrors(env).join(" "), /TOSS_MOCK_MODE/);
});

test("운영 환경은 공개 데모 관리자 코드와 출처 불일치를 거부한다", () => {
  const env = validProductionEnv({
    ADMIN_CODE: "portfolio-admin",
    PUBLIC_BASE_URL: "https://other.realstore.kr",
  });
  const messages = productionConfigErrors(env).join(" ");
  assert.match(messages, /ADMIN_CODE/);
  assert.match(messages, /PUBLIC_BASE_URL/);
});

test("운영 필수값별 누락과 잘못된 공개 URL을 거부한다", () => {
  for (const key of ["JWT_SECRET", "AUTH_CODE_PEPPER", "ADMIN_JWT_ISSUER", "ADMIN_JWT_AUDIENCE", "ADMIN_TOKEN_TTL"]) {
    const env = validProductionEnv();
    delete env[key];
    assert.match(productionConfigErrors(env).join(" "), new RegExp(key));
  }
  assert.match(productionConfigErrors(validProductionEnv({ PUBLIC_BASE_URL: "http://shop.realstore.kr" })).join(" "), /PUBLIC_BASE_URL/);
  assert.match(productionConfigErrors(validProductionEnv({ PUBLIC_BASE_URL: "https://localhost" })).join(" "), /PUBLIC_BASE_URL/);
  assert.match(productionConfigErrors(validProductionEnv({ ALLOWED_ORIGIN: "http://shop.realstore.kr" })).join(" "), /ALLOWED_ORIGIN/);
  assert.match(productionConfigErrors(validProductionEnv({ DB_PATH: "data/tteokjip.db" })).join(" "), /DB_PATH/);
});

test("예제 매장 전화번호와 주소를 거부한다", () => {
  assert.match(productionConfigErrors(validProductionEnv({ STORE_PHONE: "031-000-0000" })).join(" "), /STORE_PHONE/);
  assert.match(productionConfigErrors(validProductionEnv({ STORE_ADDRESS: "경기도 화성시 소재" })).join(" "), /STORE_ADDRESS/);
  assert.deepEqual(productionConfigErrors(validProductionEnv({ STORE_ADDRESS: "서울특별시 종로구 떡길 12" })), []);
  assert.deepEqual(productionConfigErrors(validProductionEnv({ STORE_ADDRESS: "서울특별시 소재로 12" })), []);
});

test("결제 비활성화는 Toss 키 없이 통과하고 활성화는 운영 설정을 강제한다", () => {
  assert.deepEqual(productionConfigErrors(validProductionEnv({ PAYMENT_MODE: "disabled" })), []);
  assert.match(productionConfigErrors(validProductionEnv({ PAYMENT_MODE: "toss", TOSS_MOCK_MODE: "false" })).join(" "), /Toss 운영 키/);
  assert.match(productionConfigErrors(validProductionEnv({
    PAYMENT_MODE: "toss", TOSS_CLIENT_KEY: "test_ck_sample", TOSS_SECRET_KEY: "test_sk_sample", TOSS_MOCK_MODE: "false",
  })).join(" "), /테스트 키/);
  assert.match(productionConfigErrors(validProductionEnv({
    PAYMENT_MODE: "toss", TOSS_CLIENT_KEY: "live_ck_merchant", TOSS_SECRET_KEY: "live_sk_merchant", TOSS_MOCK_MODE: "true",
  })).join(" "), /TOSS_MOCK_MODE/);
  assert.deepEqual(productionConfigErrors(validProductionEnv({
    PAYMENT_MODE: "toss", TOSS_CLIENT_KEY: "live_ck_merchant", TOSS_SECRET_KEY: "live_sk_merchant", TOSS_MOCK_MODE: "false",
  })), []);
});

test("알림 모드는 비활성·SMS·카카오 설정을 정책대로 검증한다", () => {
  assert.deepEqual(productionConfigErrors(validProductionEnv({ NOTIFICATION_MODE: "none" })), []);
  assert.match(productionConfigErrors(validProductionEnv({ NOTIFICATION_MODE: "sms" })).join(" "), /Solapi/);
  assert.match(productionConfigErrors(validProductionEnv({ NOTIFICATION_MODE: "unsupported" })).join(" "), /NOTIFICATION_MODE/);
  assert.deepEqual(productionConfigErrors(validProductionEnv({
    NOTIFICATION_MODE: "sms",
    SOLAPI_API_KEY: "solapi-key",
    SOLAPI_API_SECRET: "solapi-secret",
    SOLAPI_SENDER_PHONE: "0311234567",
  })), []);
  assert.match(productionConfigErrors(validProductionEnv({
    NOTIFICATION_MODE: "kakao",
    SOLAPI_API_KEY: "solapi-key",
    SOLAPI_API_SECRET: "solapi-secret",
    SOLAPI_SENDER_PHONE: "0311234567",
  })).join(" "), /템플릿/);
  assert.deepEqual(productionConfigErrors(validProductionEnv({
    NOTIFICATION_MODE: "kakao",
    SOLAPI_API_KEY: "solapi-key",
    SOLAPI_API_SECRET: "solapi-secret",
    SOLAPI_SENDER_PHONE: "0311234567",
    KAKAO_PLUS_FRIEND_ID: "channel-id",
    KAKAO_TEMPLATE_ORDER: "order-template",
    KAKAO_TEMPLATE_READY: "ready-template",
    KAKAO_TEMPLATE_REMIND: "remind-template",
  })), []);
});

test("이메일 비활성화는 Resend 없이 통과하고 활성화는 키와 발신주소를 강제한다", () => {
  assert.deepEqual(productionConfigErrors(validProductionEnv({ EMAIL_MODE: "disabled" })), []);
  assert.match(productionConfigErrors(validProductionEnv({ EMAIL_MODE: "resend" })).join(" "), /Resend/);
  assert.match(productionConfigErrors(validProductionEnv({
    EMAIL_MODE: "resend", RESEND_API_KEY: "resend-key", PASSWORD_RESET_FROM: "",
  })).join(" "), /발신주소/);
  assert.deepEqual(productionConfigErrors(validProductionEnv({
    EMAIL_MODE: "resend",
    RESEND_API_KEY: "resend-key",
    PASSWORD_RESET_FROM: "따뜻한 떡집 <no-reply@realstore.kr>",
  })), []);
});

test("OAuth는 제공자별 ID와 secret의 완전한 쌍만 허용한다", () => {
  assert.deepEqual(productionConfigErrors(validProductionEnv()), []);
  for (const provider of ["GOOGLE", "KAKAO", "NAVER"]) {
    assert.match(productionConfigErrors(validProductionEnv({ [`${provider}_CLIENT_ID`]: "client-id" })).join(" "), new RegExp(provider));
    assert.deepEqual(productionConfigErrors(validProductionEnv({
      [`${provider}_CLIENT_ID`]: "client-id",
      [`${provider}_CLIENT_SECRET`]: "client-secret",
    })), []);
  }
});

test("운영 환경은 테스트·포트폴리오 환경변수를 거부한다", () => {
  for (const key of ["DEMO_MODE", "ALLOW_PORTFOLIO_SEED", "PHONE_TEST_CODE", "PASSWORD_RESET_TEST_TOKEN", "PORTFOLIO_ADMIN_PASSWORD", "PORTFOLIO_USER_EMAIL"]) {
    assert.match(productionConfigErrors(validProductionEnv({ [key]: "sensitive-test-value" })).join(" "), new RegExp(key));
  }
  assert.match(productionConfigErrors(validProductionEnv({ ALLOW_STAGING_SEED: "true" })).join(" "), /ALLOW_STAGING_SEED/);
});

test("설정 오류에는 입력한 비밀값을 출력하지 않는다", () => {
  const secret = "do-not-print-this-secret";
  assert.throws(
    () => assertProductionConfig(validProductionEnv({ PAYMENT_MODE: "toss", TOSS_CLIENT_KEY: secret, TOSS_SECRET_KEY: "" })),
    (error) => !error.message.includes(secret) && /Toss/.test(error.message),
  );
});

test("네이버 주문 import가 활성화될 때만 32-byte PII key와 version을 요구한다", () => {
  assert.deepEqual(naverOrderImportConfigErrors(validProductionEnv()), []);
  const enabled = validProductionEnv({ NAVER_ORDER_IMPORT_ENABLED: "true" });
  assert.match(naverOrderImportConfigErrors(enabled).map((item) => item.code).join(" "), /PII_KEY_INVALID/);
  const valid = {
    ...enabled,
    NAVER_ORDER_PII_KEY: Buffer.alloc(32, 9).toString("base64"),
    NAVER_ORDER_PII_KEY_VERSION: "v1",
  };
  assert.deepEqual(naverOrderImportConfigErrors(valid), []);
  assert.deepEqual(productionConfigErrors(valid), []);
});

test("네이버 주문 PII key 오류와 readiness는 secret 원문을 노출하지 않는다", () => {
  const secret = Buffer.alloc(31, 8).toString("base64");
  const env = validProductionEnv({
    NAVER_ORDER_IMPORT_ENABLED: "true",
    NAVER_ORDER_PII_KEY: secret,
    NAVER_ORDER_PII_KEY_VERSION: "v1",
  });
  const messages = productionConfigErrors(env).join(" ");
  const report = JSON.stringify(productionReadinessReport(env));
  assert.match(messages, /NAVER_ORDER_PII_KEY_INVALID/);
  assert.equal(messages.includes(secret), false);
  assert.equal(report.includes(secret), false);
});

test("order PII protection requires an independent valid keyring only when enabled", () => {
  assert.deepEqual(orderPiiConfigErrors(validProductionEnv()), []);
  const enabled = validProductionEnv({ ORDER_PII_PROTECTION_ENABLED: "true" });
  assert.match(orderPiiConfigErrors(enabled).map((item) => item.code).join(" "), /KEYRING_MISSING/);
  const valid = {
    ...enabled,
    ORDER_PII_KEYS_JSON: JSON.stringify([
      { version: "v1", key: Buffer.alloc(32, 17).toString("base64") },
      { version: "v2", key: Buffer.alloc(32, 18).toString("base64") },
    ]),
    ORDER_PII_ACTIVE_KEY_VERSION: "v2",
  };
  assert.deepEqual(orderPiiConfigErrors(valid), []);
  assert.deepEqual(productionConfigErrors(valid), []);
});

test("order PII readiness rejects unsafe keys without exposing key material", () => {
  const secret = Buffer.alloc(31, 19).toString("base64");
  const environments = [
    validProductionEnv({
      ORDER_PII_PROTECTION_ENABLED: "true",
      ORDER_PII_KEYS_JSON: JSON.stringify([{ version: "v1", key: secret }]),
      ORDER_PII_ACTIVE_KEY_VERSION: "v1",
    }),
    validProductionEnv({
      ORDER_PII_PROTECTION_ENABLED: "true",
      ORDER_PII_KEYS_JSON: JSON.stringify([
        { version: "v1", key: Buffer.alloc(32, 20).toString("base64") },
      ]),
      ORDER_PII_ACTIVE_KEY_VERSION: "v2",
    }),
  ];
  for (const env of environments) {
    const errors = productionConfigErrors(env).join(" ");
    const report = JSON.stringify(productionReadinessReport(env));
    assert.match(errors, /ORDER_PII_/);
    assert.equal(errors.includes(secret), false);
    assert.equal(report.includes(secret), false);
  }
});

test("모든 seed 스크립트는 production에서 실행이 차단된다", () => {
  const scripts = fs.readdirSync(path.join(root, "server", "scripts")).filter((name) => /^seed-.*\.js$/.test(name));
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [path.join(root, "server", "scripts", script)], {
      env: { ...process.env, NODE_ENV: "production", DB_PATH: ":memory:" },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, script);
    assert.match(`${result.stdout}${result.stderr}`, /운영 환경에서는/, script);
  }
});

test("포트폴리오 주문 상태 seed는 production에서 DB 모듈을 로드하기 전에 실패한다", () => {
  const script = path.join(root, "server", "scripts", "seed-portfolio-order-status-cases.js");
  const missingDbPath = path.join(os.tmpdir(), `guard-before-db-${Date.now()}`, "should-not-exist.db");
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, NODE_ENV: "production", DB_PATH: missingDbPath },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /운영 환경에서는 포트폴리오 주문 상태 데이터 생성.*실행할 수 없습니다/);
  assert.equal(fs.existsSync(missingDbPath), false);
});

test("공개 매장 설정 API는 비밀값 없이 화면용 정보만 반환한다", async () => {
  const response = await request(app).get("/api/site-config").expect(200);
  assert.equal(typeof response.body.name, "string");
  assert.equal("JWT_SECRET" in response.body, false);
  assert.equal("TOSS_SECRET_KEY" in response.body, false);
});

test("헬스체크는 DB와 스키마 버전을 확인한다", async () => {
  const response = await request(app).get("/api/health").expect(200);
  assert.equal(response.body.database, "ready");
  assert.equal(response.body.schemaVersion, migrations.at(-1).version);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("보안 헤더와 요청 추적 ID가 모든 응답에 적용된다", async () => {
  const response = await request(app).get("/api/health");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], undefined);
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.ok(response.headers["x-request-id"]);
  assert.match(response.headers["content-security-policy"], /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(response.headers["content-security-policy"], /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
});

test("버전형 마이그레이션은 재실행해도 한 번만 기록된다", () => {
  runMigrations(db);
  runMigrations(db);
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(rows.map((row) => row.version), migrations.map((migration) => migration.version));
});

test("없는 웹 페이지는 리다이렉트 대신 404 문서를 반환한다", async () => {
  const response = await request(app).get("/definitely-missing-page").expect(404);
  assert.match(response.text, /페이지를 찾을 수 없습니다/);
});

test("배포 설정, 운영 문서, 법무 초안과 백업 도구가 존재한다", () => {
  ["railway.json", "render.yaml", "docs/DEPLOYMENT_OPERATIONS.md", "privacy.html", "terms.html", "404.html", "server/scripts/backup-database.js", "server/scripts/verify-backup.js"].forEach((file) => {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  });
  assert.match(fs.readFileSync(path.join(root, "sw.js"), "utf8"), /networkFirst/);
});

test("SQLite 백업을 생성하고 임시 DB에서 복원 가능성을 검증한다", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tteokjip-backup-test-"));
  const source = path.join(temp, "database", "source.sqlite");
  const backupDir = path.join(temp, "backups");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const initialize = spawnSync(process.execPath, ["-e", "require('./db').close()"], {
    cwd: path.join(root, "server"),
    env: { ...process.env, DB_PATH: source, NODE_ENV: "test" },
    encoding: "utf8",
  });
  assert.equal(initialize.status, 0, initialize.stderr);
  const backup = spawnSync(process.execPath, [path.join(root, "server/scripts/backup-database.js")], {
    env: { ...process.env, DB_PATH: source, BACKUP_DIR: backupDir }, encoding: "utf8",
  });
  assert.equal(backup.status, 0, backup.stderr);
  const verify = spawnSync(process.execPath, [path.join(root, "server/scripts/verify-backup.js")], {
    env: { ...process.env, DB_PATH: source, BACKUP_DIR: backupDir }, encoding: "utf8",
  });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /Backup verification passed/);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("문서용 placeholder 비밀값을 production 값으로 허용하지 않는다", () => {
  const errors = productionConfigErrors(validProductionEnv({
    JWT_SECRET: "replace-with-a-random-secret-of-at-least-32-bytes",
    AUTH_CODE_PEPPER: "your-authentication-pepper-of-at-least-32-bytes",
  })).join(" ");
  assert.match(errors, /JWT_SECRET/);
  assert.match(errors, /AUTH_CODE_PEPPER/);
});

test("production URL은 HTTPS origin만 허용하고 wildcard, path, 중복을 거부한다", () => {
  for (const origin of [
    "*",
    "https://shop.realstore.kr/api",
    "https://shop.realstore.kr,https://shop.realstore.kr/",
  ]) {
    assert.match(productionConfigErrors(validProductionEnv({ ALLOWED_ORIGIN: origin })).join(" "), /ALLOWED_ORIGIN/);
  }
  assert.match(
    productionConfigErrors(validProductionEnv({ PUBLIC_BASE_URL: "https://example.com" })).join(" "),
    /PUBLIC_BASE_URL/,
  );
});

test("production DB와 backup 경로는 저장소 밖에서 분리한다", () => {
  const repositoryDb = path.join(root, "server", "data", "production.sqlite");
  assert.match(productionConfigErrors(validProductionEnv({ DB_PATH: repositoryDb })).join(" "), /DB_PATH/);
  const databaseDir = path.dirname(validProductionEnv().DB_PATH);
  assert.match(
    productionConfigErrors(validProductionEnv({ BACKUP_DIR: databaseDir })).join(" "),
    /BACKUP_DIR/,
  );
  assert.match(
    productionConfigErrors(validProductionEnv({ BACKUP_RETENTION_DAYS: "0" })).join(" "),
    /BACKUP_RETENTION_DAYS/,
  );
});

test("readiness report는 error와 운영자 확인을 구조적으로 분리하고 비밀값을 노출하지 않는다", () => {
  const secret = "never-print-this-production-secret";
  const report = productionReadinessReport(validProductionEnv({
    JWT_SECRET: secret,
    TOSS_SECRET_KEY: secret,
    ADMIN_JWT_AUDIENCE: "shoppingmall-admin",
  }));
  assert.equal(report.errors.length, 0);
  assert.ok(report.confirmations.length >= 1);
  assert.ok(report.items.every((item) => item.code && item.category && item.problem && item.action));
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("deploy preflight는 DB와 backup 파일을 생성하지 않는 읽기 전용 검사다", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-read-only-"));
  const dbPath = path.join(temp, "database", "production.sqlite");
  const backupDir = path.join(temp, "backups");
  const result = spawnSync(process.execPath, [path.join(root, "server/scripts/deployment-preflight.js")], {
    env: {
      ...process.env,
      ...validProductionEnv({ DB_PATH: dbPath, BACKUP_DIR: backupDir }),
    },
    encoding: "utf8",
  });
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.existsSync(backupDir), false);
  assert.match(`${result.stdout}${result.stderr}`, /\[(?:ERROR|CONFIRM-NEEDED)\]\[[A-Z0-9_]+\]/);
  assert.match(result.stdout, /appEnvironment: production/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(dbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  fs.rmSync(temp, { recursive: true, force: true });
});

test("staging deploy preflight는 provider-disabled 계약을 안전하게 보고한다", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "staging-readiness-"));
  const dbPath = path.join(temp, "database", "staging.sqlite");
  const backupDir = path.join(temp, "backups");
  const env = validProductionEnv({
    APP_ENV: "staging",
    DB_PATH: dbPath,
    BACKUP_DIR: backupDir,
    PUBLIC_BASE_URL: "https://staging.realstore.kr",
    ALLOWED_ORIGIN: "https://staging.realstore.kr",
    TOSS_MOCK_MODE: "false",
    NAVER_COMMERCE_SYNC_ENABLED: "false",
    NAVER_ORDER_IMPORT_ENABLED: "false",
  });
  const result = spawnSync(process.execPath, [path.join(root, "server/scripts/deployment-preflight.js")], {
    env: {
      ...process.env,
      ...env,
      TOSS_CLIENT_KEY: "",
      TOSS_SECRET_KEY: "",
      SOLAPI_API_KEY: "",
      SOLAPI_API_SECRET: "",
      SOLAPI_SENDER_PHONE: "",
      KAKAO_PLUS_FRIEND_ID: "",
      KAKAO_TEMPLATE_ORDER: "",
      KAKAO_TEMPLATE_READY: "",
      KAKAO_TEMPLATE_REMIND: "",
      RESEND_API_KEY: "",
      PASSWORD_RESET_FROM: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      KAKAO_CLIENT_ID: "",
      KAKAO_CLIENT_SECRET: "",
      NAVER_CLIENT_ID: "",
      NAVER_CLIENT_SECRET: "",
      NAVER_COMMERCE_CLIENT_ID: "",
      NAVER_COMMERCE_CLIENT_SECRET: "",
      NAVER_COMMERCE_ACCOUNT_ID: "",
      NAVER_ORDER_PII_KEY: "",
      NAVER_ORDER_PII_KEY_VERSION: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /appEnvironment: staging/);
  assert.match(result.stdout, /nodeEnvironment: production/);
  assert.match(result.stdout, /databasePathStatus: external/);
  assert.match(result.stdout, /backupPathStatus: external/);
  assert.match(result.stdout, /providers: disabled/);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.existsSync(backupDir), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(dbPath), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("Render staging Blueprint는 분리된 service와 provider-disabled 계약만 선언한다", () => {
  const blueprint = fs.readFileSync(path.join(root, "render.staging.yaml"), "utf8");
  assert.match(blueprint, /name: tteokjip-staging/);
  assert.match(blueprint, /branch: develop/);
  assert.match(blueprint, /name: tteokjip-staging-data/);
  assert.match(blueprint, /mountPath: \/data/);
  assert.match(blueprint, /value: \/data\/staging\.sqlite/);
  assert.match(blueprint, /value: \/data\/backups/);
  assert.match(blueprint, /healthCheckPath: \/api\/health/);
  assert.match(blueprint, /buildCommand: cd server && npm ci/);
  assert.match(blueprint, /startCommand: cd server && npm start/);
  assert.doesNotMatch(blueprint, /(?:CLIENT_SECRET|SECRET_KEY|API_SECRET):\s+\S/);
});

test("네이버 커머스 sync 비활성은 credential 없이 허용하고 활성 설정은 안전하게 검증한다", () => {
  assert.deepEqual(naverCommerceConfigErrors({ NODE_ENV: "production", NAVER_COMMERCE_SYNC_ENABLED: "false" }), []);
  const base = {
    NODE_ENV: "production",
    NAVER_COMMERCE_SYNC_ENABLED: "true",
    NAVER_COMMERCE_CLIENT_ID: "client-fixture",
    NAVER_COMMERCE_CLIENT_SECRET: "$2a$10$abcdefghijklmnopqrstuv",
  };
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_CLIENT_SECRET: "" }).map((item) => item.code).join(), /NAVER_CLIENT_SECRET_MISSING/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_AUTH_TYPE: "SELLER" }).map((item) => item.code).join(), /NAVER_ACCOUNT_ID_MISSING/);
  assert.match(naverCommerceConfigErrors({ ...base, NAVER_COMMERCE_API_BASE_URL: "https://mock.invalid/external" }).map((item) => item.code).join(), /NAVER_API_BASE_URL_INVALID/);
});

test("readiness 출력에는 네이버 credential 원문이 포함되지 않고 외부 연결 코드가 없다", () => {
  const secret = "never-output-naver-client-secret";
  const env = validProductionEnv({
    NAVER_COMMERCE_SYNC_ENABLED: "true",
    NAVER_COMMERCE_CLIENT_ID: "your-client-id",
    NAVER_COMMERCE_CLIENT_SECRET: secret,
  });
  const report = productionReadinessReport(env);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.match(report.errors.map((item) => item.code).join(), /NAVER_CONFIGURATION_PLACEHOLDER/);
  const preflight = fs.readFileSync(path.join(root, "server/scripts/deployment-preflight.js"), "utf8");
  assert.doesNotMatch(preflight, /fetch\s*\(|oauth2\/token/);
});
