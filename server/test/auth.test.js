// 테스트 전용 환경변수 (실제 .env 값을 덮어쓰지 않도록 앱을 불러오기 전에 설정)
process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-auth-tests-only";
process.env.NOTIFICATION_MODE = "none";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const app = require("../index");

test("올바른 ADMIN_CODE로 로그인하면 JWT가 발급된다", async () => {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ code: "test-admin-code" });

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, "string");
  assert.ok(res.body.token.length > 0);

  const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(payload.role, "admin");
});

test("잘못된 관리자 코드로 로그인하면 401이 반환된다", async () => {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ code: "wrong-code" });

  assert.equal(res.status, 401);
  assert.ok(res.body.error);
});

test("JWT 없이 보호된 관리자 API에 접근하면 401이 반환된다", async () => {
  const res = await request(app).get("/api/activity-logs");

  assert.equal(res.status, 401);
  assert.ok(res.body.error);
});

test("잘못된(위조된) 토큰으로 접근하면 401이 반환된다", async () => {
  const res = await request(app)
    .get("/api/activity-logs")
    .set("Authorization", "Bearer this-is-not-a-valid-jwt");

  assert.equal(res.status, 401);
  assert.ok(res.body.error);
});

test("정상 관리자 토큰으로 보호된 API에 접근하면 통과한다", async () => {
  const login = await request(app).post("/api/auth/login").send({ code: "test-admin-code" });
  const res = await request(app)
    .get("/api/activity-logs")
    .set("Authorization", `Bearer ${login.body.token}`);

  assert.equal(res.status, 200);
});

test("role이 customer인 정상 서명 토큰은 관리자 API에서 403으로 거부된다", async () => {
  const customerToken = jwt.sign({ sub: "u1", role: "customer" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const res = await request(app)
    .get("/api/activity-logs")
    .set("Authorization", `Bearer ${customerToken}`);

  assert.equal(res.status, 403);
  assert.ok(res.body.error);
});

test("role 클레임이 없는 정상 서명 토큰은 관리자 API에서 403으로 거부된다", async () => {
  const noRoleToken = jwt.sign({ sub: "u1" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const res = await request(app)
    .get("/api/activity-logs")
    .set("Authorization", `Bearer ${noRoleToken}`);

  assert.equal(res.status, 403);
  assert.ok(res.body.error);
});
