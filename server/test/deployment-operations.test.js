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
const { productionConfigErrors } = require("../config");
const { runMigrations, migrations } = require("../migrations");

const root = path.resolve(__dirname, "../..");

test("운영 필수 환경변수가 누락되면 시작 검증이 실패한다", () => {
  const errors = productionConfigErrors({ NODE_ENV: "production" });
  assert.ok(errors.some((message) => message.startsWith("JWT_SECRET")));
  assert.ok(errors.some((message) => message.startsWith("DB_PATH")));
  assert.ok(errors.some((message) => message.startsWith("ALLOWED_ORIGIN")));
});

test("완전한 운영 환경변수는 시작 검증을 통과한다", () => {
  const env = {
    NODE_ENV: "production", ADMIN_CODE: "strong-admin-code-2026",
    JWT_SECRET: "j".repeat(40), AUTH_CODE_PEPPER: "p".repeat(40),
    ALLOWED_ORIGIN: "https://shop.example.com", PUBLIC_BASE_URL: "https://shop.example.com",
    DB_PATH: "/data/tteokjip.db", NOTIFICATION_MODE: "none",
  };
  assert.deepEqual(productionConfigErrors(env), []);
});

test("운영 환경에서 모의 결제 모드를 차단한다", () => {
  const env = {
    NODE_ENV: "production", ADMIN_CODE: "strong-admin-code-2026",
    JWT_SECRET: "j".repeat(40), AUTH_CODE_PEPPER: "p".repeat(40),
    ALLOWED_ORIGIN: "https://shop.example.com", PUBLIC_BASE_URL: "https://shop.example.com",
    DB_PATH: "/data/tteokjip.db", NOTIFICATION_MODE: "none", TOSS_MOCK_MODE: "true",
  };
  assert.match(productionConfigErrors(env).join(" "), /TOSS_MOCK_MODE/);
});

test("운영 환경은 공개 데모 관리자 코드와 출처 불일치를 거부한다", () => {
  const env = {
    NODE_ENV: "production", ADMIN_CODE: "portfolio-admin",
    JWT_SECRET: "j".repeat(40), AUTH_CODE_PEPPER: "p".repeat(40),
    ALLOWED_ORIGIN: "https://shop.example.com", PUBLIC_BASE_URL: "https://other.example.com",
    DB_PATH: "/data/tteokjip.db", NOTIFICATION_MODE: "none",
  };
  const messages = productionConfigErrors(env).join(" ");
  assert.match(messages, /ADMIN_CODE/);
  assert.match(messages, /PUBLIC_BASE_URL/);
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
  ["railway.json", "render.yaml", "docs/DEPLOYMENT_OPERATIONS.md", "privacy.html", "terms.html", "404.html", "server/scripts/backup-db.js", "server/scripts/restore-db.js"].forEach((file) => {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  });
  assert.match(fs.readFileSync(path.join(root, "sw.js"), "utf8"), /networkFirst/);
});

test("SQLite 백업을 생성하고 별도 DB로 무결하게 복원한다", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tteokjip-backup-test-"));
  const source = path.join(temp, "source.db");
  const restored = path.join(temp, "restored.db");
  const backupDir = path.join(temp, "backups");
  const seed = new DatabaseSync(source);
  seed.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('verified')");
  seed.close();
  const backup = spawnSync(process.execPath, [path.join(root, "server/scripts/backup-db.js")], {
    env: { ...process.env, DB_PATH: source, BACKUP_DIR: backupDir }, encoding: "utf8",
  });
  assert.equal(backup.status, 0, backup.stderr);
  const backupFile = path.join(backupDir, fs.readdirSync(backupDir).find((name) => name.endsWith(".db")));
  const restore = spawnSync(process.execPath, [path.join(root, "server/scripts/restore-db.js"), backupFile, "--confirm"], {
    env: { ...process.env, DB_PATH: restored }, encoding: "utf8",
  });
  assert.equal(restore.status, 0, restore.stderr);
  const verified = new DatabaseSync(restored, { readOnly: true });
  assert.equal(verified.prepare("SELECT value FROM sample").get().value, "verified");
  verified.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
