process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "static-boundary-test-secret";
process.env.AUTH_CODE_PEPPER = "static-boundary-test-pepper";
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_MODE = "none";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../index");

test("공개 화면과 정적 자산 allowlist는 기존 URL로 제공된다", async (t) => {
  const publicPaths = [
    "/",
    "/menu.html",
    "/admin.html",
    "/css/layout.css",
    "/js/api.js",
    "/assets/logo.svg",
    "/sw.js",
    "/manifest.json",
  ];

  for (const publicPath of publicPaths) {
    await t.test(publicPath, async () => {
      const response = await request(app).get(publicPath).expect(200);
      assert.ok(response.body?.length || response.text?.length, `${publicPath} 응답이 비어 있습니다.`);
    });
  }
});

test("서버 소스와 내부 문서, 환경파일, DB 및 백업 경로는 단순 404로 차단된다", async (t) => {
  const privatePaths = [
    "/server/db.js",
    "/server/index.js",
    "/server/config.js",
    "/server/package.json",
    "/server/routes/orders.js",
    "/server/scripts/backup-db.js",
    "/server/test/",
    "/README.md",
    "/.git/config",
    "/.env",
    "/server/.env",
    "/server/tteokjip.db",
    "/server/backups/example.db",
    "/docs/DEPLOYMENT_OPERATIONS.md",
    "/SHOPPINGMALL_QUICK_CHECK.md",
    "/.agents/",
  ];

  for (const privatePath of privatePaths) {
    await t.test(privatePath, async () => {
      const response = await request(app).get(privatePath).expect(404);
      assert.equal(response.type, "text/plain");
      assert.equal(response.text, "Not Found");
      assert.doesNotMatch(response.text, /페이지를 찾을 수 없습니다/);
    });
  }
});

test("정적 파일 경계 적용 후에도 API 라우팅과 JSON 404가 유지된다", async () => {
  const health = await request(app).get("/api/health").expect(200);
  assert.equal(health.type, "application/json");
  assert.equal(health.body.ok, true);

  const missing = await request(app).get("/api/not-existing").expect(404);
  assert.equal(missing.type, "application/json");
  assert.deepEqual(missing.body, { error: "존재하지 않는 API 엔드포인트입니다." });
});
