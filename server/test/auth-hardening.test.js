process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "hardening-admin-code";
process.env.JWT_SECRET = "hardening-jwt-secret";
process.env.AUTH_CODE_PEPPER = "hardening-phone-code-pepper";
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_MODE = "none";
process.env.PHONE_TEST_CODE = "123456";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../index");
const db = require("../db");

function insertUser() {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user_accounts
    (id,username,email,password_hash,name,phone,status,terms_agreed_at,privacy_agreed_at,created_at,updated_at)
    VALUES ('locked-user','locked_user','locked@example.com',?,'잠금 테스트','01011112222','active',?,?,?,?)`)
    .run(bcrypt.hashSync("correct-password", 4), now, now, now, now);
}

test("휴대폰 인증번호는 원문 대신 HMAC 해시로 저장한다", async () => {
  const response = await request(app).post("/api/phone/send-code").send({ phone: "010-7000-0001" });
  assert.equal(response.status, 200);
  const row = db.prepare("SELECT code, code_hash FROM phone_verifications WHERE phone='01070000001'").get();
  assert.equal(row.code, "hashed");
  assert.ok(/^[a-f0-9]{64}$/.test(row.code_hash));
  assert.equal(response.body.devCode, undefined);
});

test("인증번호 발송 시 만료된 인증 기록을 정리한다", async () => {
  db.prepare(`INSERT INTO phone_verifications (id,phone,code,code_hash,expires_at,attempts,created_at)
    VALUES ('expired-record','01079999999','hashed','unused','2000-01-01T00:00:00.000Z',0,'2000-01-01T00:00:00.000Z')`).run();
  await request(app).post("/api/phone/send-code").send({ phone: "010-7000-0002" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM phone_verifications WHERE id='expired-record'").get().count, 0);
});

test("운영 환경에서 SMS 설정이 없으면 개발 인증번호를 노출하지 않는다", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const response = await request(app).post("/api/phone/send-code").send({ phone: "010-7000-0003" });
  process.env.NODE_ENV = previous;
  assert.equal(response.status, 503);
  assert.equal(response.body.devCode, undefined);
  assert.equal(response.body.devMode, undefined);
});

test("고객 로그인 5회 실패 시 일시 잠금하고 동일한 오류만 반환한다", async () => {
  insertUser();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(app).post("/api/users/login").send({ identifier: "locked_user", password: "wrong-password" });
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "아이디 또는 비밀번호가 올바르지 않습니다.");
  }
  const locked = db.prepare("SELECT login_locked_until FROM user_accounts WHERE id='locked-user'").get();
  assert.ok(Date.parse(locked.login_locked_until) > Date.now());
  const correctWhileLocked = await request(app).post("/api/users/login").send({ identifier: "locked_user", password: "correct-password" });
  const missing = await request(app).post("/api/users/login").send({ identifier: "missing_user", password: "correct-password" });
  assert.equal(correctWhileLocked.status, 401);
  assert.equal(correctWhileLocked.body.error, missing.body.error);
});

test("운영 환경에서는 DEMO_MODE여도 재설정 링크를 응답하지 않는다", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDemoMode = process.env.DEMO_MODE;
  process.env.NODE_ENV = "production";
  process.env.DEMO_MODE = "true";
  const response = await request(app).post("/api/users/password-reset/request").send({ identifier: "locked_user" });
  process.env.NODE_ENV = previousNodeEnv;
  process.env.DEMO_MODE = previousDemoMode;
  assert.equal(response.status, 200);
  assert.equal(response.body.demoResetUrl, undefined);
});
