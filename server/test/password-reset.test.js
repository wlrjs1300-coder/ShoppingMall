process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-password-reset";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";
process.env.PASSWORD_RESET_TEST_TOKEN = "fixed-password-reset-token-for-tests";
process.env.PUBLIC_BASE_URL = "http://localhost:3000";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const app = require("../index");
const db = require("../db");

function createUser() {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_accounts
      (id, username, email, password_hash, name, phone, terms_agreed_at, privacy_agreed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("reset-user", "reset_user", "reset@example.com", bcrypt.hashSync("oldpassword1", 4), "테스트", "01012345678", now, now, now, now);
}

test("비밀번호 재설정 링크는 15분 유효한 일회용 링크다", async () => {
  createUser();
  const requested = await request(app).post("/api/users/password-reset/request").send({ identifier: "reset_user" });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.demoResetUrl, undefined);
  const token = process.env.PASSWORD_RESET_TEST_TOKEN;

  const validated = await request(app).get("/api/users/password-reset/validate").query({ token });
  assert.equal(validated.status, 200);

  const changed = await request(app).post("/api/users/password-reset/confirm").send({ token, password: "newpassword1" });
  assert.equal(changed.status, 200);

  const reused = await request(app).post("/api/users/password-reset/confirm").send({ token, password: "anotherpass1" });
  assert.equal(reused.status, 400);

  const login = await request(app).post("/api/users/login").send({ identifier: "reset_user", password: "newpassword1" });
  assert.equal(login.status, 200);
});

test("존재하지 않는 계정도 동일한 일반 응답을 반환한다", async () => {
  const response = await request(app).post("/api/users/password-reset/request").send({ identifier: "nobody" });
  assert.equal(response.status, 200);
  assert.equal(response.body.demoResetUrl, undefined);
  assert.match(response.body.message, /계정이 있다면/);
});
