process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-identity-tests-only";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "";
process.env.GOOGLE_CLIENT_SECRET = "";
process.env.KAKAO_CLIENT_ID = "";
process.env.KAKAO_CLIENT_SECRET = "";
process.env.NAVER_CLIENT_ID = "";
process.env.NAVER_CLIENT_SECRET = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const app = require("../index");
const db = require("../db");

test("회원 테이블에 고유 아이디와 소셜 계정 연결 구조가 존재한다", () => {
  const columns = db.prepare("PRAGMA table_info(user_accounts)").all();
  assert.ok(columns.some((column) => column.name === "username"));
  assert.ok(columns.some((column) => column.name === "role"));
  const socialColumns = db.prepare("PRAGMA table_info(social_identities)").all();
  assert.ok(socialColumns.some((column) => column.name === "provider_user_id"));
});

test("관리자 회원은 일반 로그인 후 관리자 세션을 발급받을 수 있다", async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_accounts
      (id, username, email, password_hash, name, phone, role, terms_agreed_at, privacy_agreed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?, ?)
  `).run("role-admin-user", "role_admin", "role-admin@example.com", bcrypt.hashSync("password123", 4), "관리자", "01022223333", now, now, now, now);

  const agent = request.agent(app);
  const login = await agent.post("/api/users/login").send({ identifier: "role_admin", password: "password123" });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "admin");

  const session = await agent.post("/api/users/admin-session");
  assert.equal(session.status, 200);
  assert.equal(typeof session.body.token, "string");
});

test("일반 회원은 관리자 세션을 발급받을 수 없다", async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_accounts
      (id, username, email, password_hash, name, phone, terms_agreed_at, privacy_agreed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("role-customer-user", "role_customer", "role-customer@example.com", bcrypt.hashSync("password123", 4), "일반 회원", "01044445555", now, now, now, now);
  const agent = request.agent(app);
  const login = await agent.post("/api/users/login").send({ identifier: "role_customer", password: "password123" });
  assert.equal(login.status, 200);
  const session = await agent.post("/api/users/admin-session");
  assert.equal(session.status, 403);
});

test("아이디와 기존 이메일 모두로 로그인할 수 있다", async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_accounts
      (id, username, email, password_hash, name, phone, terms_agreed_at, privacy_agreed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("identity-user", "tteok_user", "identity@example.com", bcrypt.hashSync("password123", 4), "테스트", "01012345678", now, now, now, now);

  const byUsername = await request(app).post("/api/users/login").send({ identifier: "TTEOK_USER", password: "password123" });
  assert.equal(byUsername.status, 200);
  assert.equal(byUsername.body.user.username, "tteok_user");

  const byEmail = await request(app).post("/api/users/login").send({ identifier: "IDENTITY@EXAMPLE.COM", password: "password123" });
  assert.equal(byEmail.status, 200);
});

test("아이디 중복 확인은 사용 중인 아이디와 사용 가능한 아이디를 구분한다", async () => {
  const existing = await request(app).post("/api/users/check-username").send({ username: "TTEOK_USER" });
  assert.equal(existing.status, 200);
  assert.equal(existing.body.available, false);

  const available = await request(app).post("/api/users/check-username").send({ username: "new_tteok_user" });
  assert.equal(available.status, 200);
  assert.equal(available.body.available, true);
});

test("형식이 잘못된 아이디는 중복 확인 전에 거부한다", async () => {
  const response = await request(app).post("/api/users/check-username").send({ username: "한글 아이디" });
  assert.equal(response.status, 400);
});

test("이미 사용 중인 아이디로 회원가입할 수 없다", async () => {
  const response = await request(app).post("/api/users/signup").send({
    username: "tteok_user",
    email: "another@example.com",
    password: "password123",
    name: "다른 사용자",
    phone: "01099990000",
    address: "테스트 주소",
    agreeTerms: true,
    agreePrivacy: true,
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /아이디/);
});

test("설정되지 않은 소셜 제공업체 목록은 비어 있다", async () => {
  const response = await request(app).get("/api/auth/social/providers");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.providers, []);
});
