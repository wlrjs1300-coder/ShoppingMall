// 테스트 전용 환경변수 (실제 .env 값을 덮어쓰지 않도록 앱을 불러오기 전에 설정)
process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-users-tests-only";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test"; // rate limiter 비활성화 + secure 쿠키 옵션 off
process.env.PHONE_TEST_CODE = "123456";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const app = require("../index");
const db = require("../db");
const { COOKIE_NAME } = require("../middleware/customerAuth");

function validSignupPayload(overrides = {}) {
  const payload = {
    email: "Signup.Test@Example.com",
    username: "signup_test",
    password: "password123",
    name: "홍길동",
    phone: "010-1234-5678",
    postalCode: "18400",
    address: "경기도 화성시 동탄대로 00",
    addressDetail: "101동 101호",
    agreeTerms: true,
    agreePrivacy: true,
    agreeMarketing: false,
    ...overrides,
  };
  if (!overrides.username && overrides.email) {
    payload.username = overrides.email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20);
  }
  return payload;
}

function getSetCookie(res) {
  const raw = res.headers["set-cookie"] || [];
  return raw.find((c) => c.startsWith(`${COOKIE_NAME}=`));
}

let phoneSequence = 10000000;

function nextTestPhone() {
  phoneSequence += 1;
  return `010${String(phoneSequence).padStart(8, "0")}`;
}

async function signupWithVerifiedPhone(overrides = {}) {
  const payload = validSignupPayload({
    phone: overrides.phone || nextTestPhone(),
    ...overrides,
  });
  const sendCode = await request(app).post("/api/phone/send-code").send({ phone: payload.phone });
  assert.equal(sendCode.status, 200, sendCode.body.error);
  assert.equal(sendCode.body.devMode, true);

  const verifyCode = await request(app).post("/api/phone/verify-code").send({
    phone: payload.phone,
    code: process.env.PHONE_TEST_CODE,
  });
  assert.equal(verifyCode.status, 200, verifyCode.body.error);
  assert.equal(verifyCode.body.verified, true);

  return {
    payload,
    response: await request(app).post("/api/users/signup").send(payload),
  };
}

// ─── DB 스키마 ──────────────────────────────────────────────

test("user_accounts / user_addresses 테이블이 생성된다", () => {
  const accountCols = db.prepare("PRAGMA table_info(user_accounts)").all();
  const addressCols = db.prepare("PRAGMA table_info(user_addresses)").all();
  assert.ok(accountCols.some((c) => c.name === "email"));
  assert.ok(accountCols.some((c) => c.name === "password_hash"));
  assert.ok(addressCols.some((c) => c.name === "user_id"));
});

test("orders 테이블에 user_id 컬럼이 존재한다", () => {
  const cols = db.prepare("PRAGMA table_info(orders)").all();
  assert.ok(cols.some((c) => c.name === "user_id"));
});

test("user_accounts.email에 UNIQUE 제약이 걸려 있다", () => {
  const now = new Date().toISOString();
  const insert = () =>
    db.prepare(`
      INSERT INTO user_accounts (id, email, password_hash, name, phone, terms_agreed_at, privacy_agreed_at, created_at, updated_at)
      VALUES (?, 'unique-test@example.com', 'hash', 'a', '01000000000', ?, ?, ?, ?)
    `).run(`u-${Math.random()}`, now, now, now, now);

  insert();
  assert.throws(insert, /UNIQUE constraint failed/);
});

test("회원 삭제 시 배송지가 CASCADE로 함께 삭제된다", () => {
  const now = new Date().toISOString();
  const userId = `cascade-user-${Math.random()}`;
  db.prepare(`
    INSERT INTO user_accounts (id, email, password_hash, name, phone, terms_agreed_at, privacy_agreed_at, created_at, updated_at)
    VALUES (?, ?, 'hash', 'a', '01000000000', ?, ?, ?, ?)
  `).run(userId, `${userId}@example.com`, now, now, now, now);
  db.prepare(`
    INSERT INTO user_addresses (id, user_id, recipient_name, recipient_phone, address, is_default, created_at, updated_at)
    VALUES (?, ?, 'a', '01000000000', 'addr', 1, ?, ?)
  `).run(`addr-${Math.random()}`, userId, now, now);

  const before = db.prepare("SELECT COUNT(*) c FROM user_addresses WHERE user_id = ?").get(userId);
  assert.equal(before.c, 1);

  db.prepare("DELETE FROM user_accounts WHERE id = ?").run(userId);

  const after = db.prepare("SELECT COUNT(*) c FROM user_addresses WHERE user_id = ?").get(userId);
  assert.equal(after.c, 0);
});

// ─── 회원가입 ────────────────────────────────────────────────

test("정상적인 값으로 회원가입하면 201과 사용자 정보를 반환한다", async () => {
  const { response: res, payload } = await signupWithVerifiedPhone();

  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, "signup.test@example.com");
  assert.equal(res.body.user.phone, payload.phone.replace(/\D/g, ""));
  assert.equal(res.body.user.password, undefined);
  assert.equal(res.body.user.password_hash, undefined);
});

test("이메일은 소문자로 정규화되어 저장된다", async () => {
  await signupWithVerifiedPhone({ email: "Lower.Case@Example.com" });
  const row = db.prepare("SELECT email FROM user_accounts WHERE email = ?").get("lower.case@example.com");
  assert.ok(row);
});

test("휴대폰 번호는 숫자만 저장된다", async () => {
  await signupWithVerifiedPhone({ email: "phone.norm@example.com", phone: "010-9999-8888" });
  const row = db.prepare("SELECT phone FROM user_accounts WHERE email = ?").get("phone.norm@example.com");
  assert.equal(row.phone, "01099998888");
});

test("비밀번호는 평문으로 저장되지 않는다", async () => {
  await signupWithVerifiedPhone({ email: "hash.check@example.com", password: "plainpassword1" });
  const row = db.prepare("SELECT password_hash FROM user_accounts WHERE email = ?").get("hash.check@example.com");
  assert.notEqual(row.password_hash, "plainpassword1");
  assert.ok(row.password_hash.length > 20);
});

test("회원가입과 동시에 기본 배송지가 함께 생성된다", async () => {
  const { response: res } = await signupWithVerifiedPhone({ email: "with.address@example.com" });
  const address = db.prepare("SELECT * FROM user_addresses WHERE user_id = ?").get(res.body.user.id);
  assert.ok(address);
  assert.equal(address.is_default, 1);
  assert.equal(address.address, "경기도 화성시 동탄대로 00");
});

test("회원가입 성공 시 고객 쿠키가 발급된다", async () => {
  const { response: res } = await signupWithVerifiedPhone({ email: "cookie.check@example.com" });
  const cookie = getSetCookie(res);
  assert.ok(cookie, "Set-Cookie 헤더에 고객 토큰이 없음");
  assert.match(cookie, /HttpOnly/i);
});

test("필수 약관(이용약관) 미동의 시 거부된다", async () => {
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "no.terms@example.com", agreeTerms: false }));
  assert.equal(res.status, 400);
});

test("필수 약관(개인정보) 미동의 시 거부된다", async () => {
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "no.privacy@example.com", agreePrivacy: false }));
  assert.equal(res.status, 400);
});

test("잘못된 이메일 형식은 거부된다", async () => {
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "not-an-email" }));
  assert.equal(res.status, 400);
});

test("8자 미만 비밀번호는 거부된다", async () => {
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "short.pw@example.com", password: "short1" }));
  assert.equal(res.status, 400);
});

test("문자수는 72자 이하지만 UTF-8 바이트로는 72바이트를 넘는 멀티바이트 비밀번호는 거부된다", async () => {
  const longKoreanPassword = "가".repeat(25); // 25자 = 72자 이하지만 UTF-8로는 75바이트
  assert.ok(longKoreanPassword.length <= 72);
  assert.ok(Buffer.byteLength(longKoreanPassword, "utf8") > 72);
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "byte.limit@example.com", password: longKoreanPassword }));
  assert.equal(res.status, 400);
});

test("72바이트 이내의 멀티바이트(한글) 비밀번호는 정상 가입된다", async () => {
  const koreanPassword = "가".repeat(20); // 20자 = 60바이트, 72바이트 이내
  const { response: res } = await signupWithVerifiedPhone({ email: "byte.ok@example.com", password: koreanPassword });
  assert.equal(res.status, 201);
});

test("휴대폰 번호 누락 시 거부된다", async () => {
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "no.phone@example.com", phone: "" }));
  assert.equal(res.status, 400);
});

test("주소 누락 시 거부된다", async () => {
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "no.address@example.com", address: "" }));
  assert.equal(res.status, 400);
});

test("중복 이메일로 가입하면 409가 반환된다", async () => {
  const first = await signupWithVerifiedPhone({ email: "dup.signup@example.com" });
  assert.equal(first.response.status, 201);
  const res = await request(app).post("/api/users/signup").send(validSignupPayload({ email: "dup.signup@example.com" }));
  assert.equal(res.status, 409);
});

// ─── 로그인 ──────────────────────────────────────────────────

test("가입한 계정으로 정상 로그인한다", async () => {
  await signupWithVerifiedPhone({ email: "login.ok@example.com", password: "loginpass1" });
  const res = await request(app).post("/api/users/login").send({ email: "login.ok@example.com", password: "loginpass1" });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, "login.ok@example.com");
});

test("이메일 대소문자가 달라도 로그인된다", async () => {
  await signupWithVerifiedPhone({ email: "case.login@example.com", password: "loginpass1" });
  const res = await request(app).post("/api/users/login").send({ email: "CASE.Login@Example.com", password: "loginpass1" });
  assert.equal(res.status, 200);
});

test("잘못된 비밀번호는 401을 반환한다", async () => {
  await signupWithVerifiedPhone({ email: "wrong.pw@example.com", password: "loginpass1" });
  const res = await request(app).post("/api/users/login").send({ email: "wrong.pw@example.com", password: "wrongpassword" });
  assert.equal(res.status, 401);
});

test("존재하지 않는 이메일은 401을 반환한다", async () => {
  const res = await request(app).post("/api/users/login").send({ email: "nobody@example.com", password: "whatever1" });
  assert.equal(res.status, 401);
});

test("이메일 미존재와 비밀번호 오류의 응답 메시지가 동일하다", async () => {
  await signupWithVerifiedPhone({ email: "message.compare@example.com", password: "loginpass1" });
  const wrongPassword = await request(app).post("/api/users/login").send({ email: "message.compare@example.com", password: "wrongpassword" });
  const noEmail = await request(app).post("/api/users/login").send({ email: "no-such-account@example.com", password: "whatever1" });
  assert.equal(wrongPassword.body.error, noEmail.body.error);
});

test("탈퇴(withdrawn) 상태 회원은 로그인이 거부된다", async () => {
  await signupWithVerifiedPhone({ email: "withdrawn@example.com", password: "loginpass1" });
  db.prepare("UPDATE user_accounts SET status = 'withdrawn' WHERE email = ?").run("withdrawn@example.com");
  const res = await request(app).post("/api/users/login").send({ email: "withdrawn@example.com", password: "loginpass1" });
  assert.equal(res.status, 401);
});

test("로그인 성공 시 고객 쿠키가 발급된다", async () => {
  await signupWithVerifiedPhone({ email: "login.cookie@example.com", password: "loginpass1" });
  const res = await request(app).post("/api/users/login").send({ email: "login.cookie@example.com", password: "loginpass1" });
  assert.ok(getSetCookie(res));
});

// ─── 권한 분리 (관리자 ↔ 고객) ──────────────────────────────

test("고객 쿠키로 /api/users/me 조회에 성공한다", async () => {
  const agent = request.agent(app);
  const { payload } = await signupWithVerifiedPhone({ email: "me.check@example.com" });
  await agent.post("/api/users/login").send({ email: payload.email, password: payload.password });
  const res = await agent.get("/api/users/me");
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, "me.check@example.com");
  assert.equal(res.body.user.password_hash, undefined);
});

test("쿠키 없이 /api/users/me 요청하면 401을 반환한다", async () => {
  const res = await request(app).get("/api/users/me");
  assert.equal(res.status, 401);
});

test("관리자 JWT를 고객 쿠키 자리에 넣어도 고객 API가 거부한다", async () => {
  const adminToken = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const res = await request(app).get("/api/users/me").set("Cookie", `${COOKIE_NAME}=${adminToken}`);
  assert.equal(res.status, 401);
});

test("고객 role의 정상 서명 JWT를 Bearer로 보내도 관리자 API는 거부한다", async () => {
  const customerToken = jwt.sign({ sub: "u1", role: "customer" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const res = await request(app).get("/api/activity-logs").set("Authorization", `Bearer ${customerToken}`);
  assert.equal(res.status, 403);
});

test("role 없는 정상 서명 JWT는 관리자 API에서 거부된다", async () => {
  const noRoleToken = jwt.sign({ sub: "someone" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const res = await request(app).get("/api/activity-logs").set("Authorization", `Bearer ${noRoleToken}`);
  assert.equal(res.status, 403);
});

// ─── 로그아웃 ────────────────────────────────────────────────

test("로그아웃은 항상 성공 응답을 반환한다", async () => {
  const res = await request(app).post("/api/users/logout");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("로그아웃 응답에 쿠키 제거 헤더가 포함된다", async () => {
  const res = await request(app).post("/api/users/logout");
  const cookie = getSetCookie(res);
  assert.ok(cookie);
  assert.match(cookie, /Expires=Thu, 01 Jan 1970|Max-Age=0/i);
});

test("로그아웃 이후에는 /api/users/me 접근이 실패한다", async () => {
  const agent = request.agent(app);
  const { payload } = await signupWithVerifiedPhone({ email: "logout.flow@example.com" });
  await agent.post("/api/users/login").send({ email: payload.email, password: payload.password });
  const before = await agent.get("/api/users/me");
  assert.equal(before.status, 200);

  await agent.post("/api/users/logout");
  const after = await agent.get("/api/users/me");
  assert.equal(after.status, 401);
});
