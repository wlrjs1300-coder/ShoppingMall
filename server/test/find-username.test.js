process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-find-username";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const app = require("../index");
const db = require("../db");

const now = new Date();
db.prepare(`
  INSERT INTO user_accounts
    (id, username, email, password_hash, name, phone, terms_agreed_at, privacy_agreed_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "find-user",
  "find_my_id",
  "find@example.com",
  bcrypt.hashSync("password123", 4),
  "아이디찾기회원",
  "01098765432",
  now.toISOString(),
  now.toISOString(),
  now.toISOString(),
  now.toISOString(),
);

test("휴대폰 인증 전에는 아이디를 확인할 수 없다", async () => {
  const response = await request(app).post("/api/users/find-username").send({
    name: "아이디찾기회원",
    phone: "01098765432",
  });
  assert.equal(response.status, 403);
});

test("휴대폰 인증 후 아이디를 한 번만 확인할 수 있다", async () => {
  const verificationId = "find-verification";
  db.prepare(`
    INSERT INTO phone_verifications
      (id, phone, code, code_hash, expires_at, attempts, verified_at, created_at)
    VALUES (?, ?, 'hashed', 'test-hash', ?, 0, ?, ?)
  `).run(
    verificationId,
    "01098765432",
    new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    now.toISOString(),
    now.toISOString(),
  );

  const found = await request(app).post("/api/users/find-username").send({
    name: "아이디찾기회원",
    phone: "01098765432",
  });
  assert.equal(found.status, 200);
  assert.equal(found.body.username, "find_my_id");

  const reused = await request(app).post("/api/users/find-username").send({
    name: "아이디찾기회원",
    phone: "01098765432",
  });
  assert.equal(reused.status, 403);
});
