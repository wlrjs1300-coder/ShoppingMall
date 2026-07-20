// 테스트 전용 환경변수 (실제 .env 값을 덮어쓰지 않도록 앱을 불러오기 전에 설정)
process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-phone-tests-only";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";
process.env.PHONE_TEST_CODE = "123456";
// Solapi 키를 일부러 비워 두고 테스트 전용 고정 코드로 검증한다.
delete process.env.SOLAPI_API_KEY;
delete process.env.SOLAPI_API_SECRET;
delete process.env.SOLAPI_SENDER_PHONE;

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../index");
const db = require("../db");

function validSignupPayload(overrides = {}) {
  const payload = {
    email: "phone.signup@example.com",
    username: "phone_signup",
    password: "password123",
    name: "홍길동",
    phone: "010-1234-5678",
    address: "경기도 화성시 동탄대로 00",
    agreeTerms: true,
    agreePrivacy: true,
    ...overrides,
  };
  if (!overrides.username && overrides.email) {
    payload.username = overrides.email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20);
  }
  return payload;
}

async function requestAndReadCode(phone) {
  const res = await request(app).post("/api/phone/send-code").send({ phone });
  return res;
}

// ─── 스키마 ──────────────────────────────────────────────────

test("phone_verifications 테이블과 인덱스가 존재한다", () => {
  const cols = db.prepare("PRAGMA table_info(phone_verifications)").all().map((c) => c.name);
  for (const col of ["id", "phone", "code", "expires_at", "attempts", "verified_at", "consumed_at", "created_at"]) {
    assert.ok(cols.includes(col), `${col} 컬럼 누락`);
  }
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_phone_verifications_phone'").all();
  assert.equal(idx.length, 1);
});

// ─── send-code ───────────────────────────────────────────────

test("정상 번호로 인증번호를 요청해도 원문 코드를 응답하지 않는다", async () => {
  const res = await requestAndReadCode("01011112222");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.devMode, true);
  assert.equal(res.body.devCode, undefined);
});

test("잘못된 전화번호 형식은 400을 반환한다", async () => {
  const res = await request(app).post("/api/phone/send-code").send({ phone: "not-a-phone" });
  assert.equal(res.status, 400);
});

test("같은 번호로 너무 빨리 재요청하면 429를 반환한다", async () => {
  const phone = "01033334444";
  const first = await requestAndReadCode(phone);
  assert.equal(first.status, 200);
  const second = await requestAndReadCode(phone);
  assert.equal(second.status, 429);
});

// ─── verify-code ─────────────────────────────────────────────

test("올바른 코드로 인증하면 verified:true를 반환한다", async () => {
  const phone = "01055556666";
  const sendRes = await requestAndReadCode(phone);
  const verifyRes = await request(app).post("/api/phone/verify-code").send({ phone, code: process.env.PHONE_TEST_CODE });
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.body.verified, true);
});

test("틀린 코드는 400을 반환하고 시도 횟수가 증가한다", async () => {
  const phone = "01077778888";
  await requestAndReadCode(phone);
  const res = await request(app).post("/api/phone/verify-code").send({ phone, code: "000000" });
  assert.equal(res.status, 400);
  const row = db.prepare("SELECT attempts FROM phone_verifications WHERE phone = ? ORDER BY created_at DESC LIMIT 1").get(phone);
  assert.equal(row.attempts, 1);
});

test("인증번호를 요청하지 않은 번호는 400을 반환한다", async () => {
  const res = await request(app).post("/api/phone/verify-code").send({ phone: "01099990000", code: "123456" });
  assert.equal(res.status, 400);
});

test("만료된 코드는 400을 반환한다", async () => {
  const phone = "01012120000";
  const sendRes = await requestAndReadCode(phone);
  db.prepare("UPDATE phone_verifications SET expires_at = ? WHERE phone = ?").run(
    new Date(Date.now() - 1000).toISOString(), phone,
  );
  const res = await request(app).post("/api/phone/verify-code").send({ phone, code: process.env.PHONE_TEST_CODE });
  assert.equal(res.status, 400);
});

test("5회 틀리면 시도 횟수 초과로 거부된다", async () => {
  const phone = "01034340000";
  await requestAndReadCode(phone);
  for (let i = 0; i < 5; i++) {
    await request(app).post("/api/phone/verify-code").send({ phone, code: "000000" });
  }
  const res = await request(app).post("/api/phone/verify-code").send({ phone, code: "000000" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /시도 횟수/);
});

// ─── 회원가입 연동 ────────────────────────────────────────────

test("휴대폰 인증 없이 회원가입하면 400을 반환한다", async () => {
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "no.phone.verify@example.com", phone: "010-6060-7070" }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /휴대폰 인증/);
});

test("휴대폰 인증을 완료한 뒤 가입하면 성공한다", async () => {
  const phone = "01099998877";
  const sendRes = await requestAndReadCode(phone);
  await request(app).post("/api/phone/verify-code").send({ phone, code: process.env.PHONE_TEST_CODE });

  const res = await request(app).post("/api/users/signup").send(
    validSignupPayload({ email: "phone.verified@example.com", phone }),
  );
  assert.equal(res.status, 201);
});

test("가입에 사용된 인증 기록은 다른 가입에 재사용할 수 없다", async () => {
  const phone = "01088887766";
  const sendRes = await requestAndReadCode(phone);
  await request(app).post("/api/phone/verify-code").send({ phone, code: process.env.PHONE_TEST_CODE });

  const first = await request(app).post("/api/users/signup").send(
    validSignupPayload({ email: "reuse.first@example.com", phone }),
  );
  assert.equal(first.status, 201);

  const second = await request(app).post("/api/users/signup").send(
    validSignupPayload({ email: "reuse.second@example.com", phone }),
  );
  assert.equal(second.status, 400);
  assert.match(second.body.error, /휴대폰 인증/);
});
