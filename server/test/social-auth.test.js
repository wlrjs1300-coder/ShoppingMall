process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-social-auth";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";
process.env.PUBLIC_BASE_URL = "http://localhost:3001";
process.env.GOOGLE_CLIENT_ID = "google-client";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.KAKAO_CLIENT_ID = "kakao-client";
process.env.NAVER_CLIENT_ID = "naver-client";
process.env.NAVER_CLIENT_SECRET = "naver-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../index");
const db = require("../db");

function insertUser(id, email, password = null) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user_accounts
    (id, username, email, password_hash, name, phone, role, status, terms_agreed_at, privacy_agreed_at, marketing_consent, created_at, updated_at)
    VALUES (?, ?, ?, 'unused-hash', 'Social test', '01012345678', 'customer', 'active', ?, ?, 0, ?, ?)`)
    .run(id, id, email, now, now, now, now);
  if (password) db.prepare("UPDATE user_accounts SET password_hash=? WHERE id=?").run(bcrypt.hashSync(password, 10), id);
}

test("configured providers start OAuth without a storefront consent checkbox", async () => {
  const providers = await request(app).get("/api/auth/social/providers");
  assert.deepEqual(providers.body.providers.sort(), ["google", "kakao", "naver"]);
  const start = await request(app).get("/api/auth/social/google");
  const location = new URL(start.headers.location);
  assert.equal(location.searchParams.get("redirect_uri"), "http://localhost:3001/api/auth/social/google/callback");
  assert.equal(location.searchParams.get("prompt"), "select_account");
  assert.match(start.headers["set-cookie"][0], /HttpOnly/);
});

test("a new Google identity creates an account only after storefront consent", async () => {
  const agent = request.agent(app);
  const start = await agent.get("/api/auth/social/google");
  const state = new URL(start.headers.location).searchParams.get("state");
  const originalFetch = global.fetch;
  global.fetch = async (url) => String(url).includes("token")
    ? new Response(JSON.stringify({ access_token: "token" }), { status: 200, headers: { "Content-Type": "application/json" } })
    : new Response(JSON.stringify({ sub: "new-google-id", email: "new-google@example.com", email_verified: true, name: "Google User" }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const callback = await agent.get(`/api/auth/social/google/callback?code=code&state=${state}`);
    assert.equal(callback.headers.location, "/social-consent.html");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM social_identities WHERE provider_user_id='new-google-id'").get().count, 0);
    const consent = await agent.post("/api/auth/social/signup-consent").send({ agreeTerms: true, agreePrivacy: true, agreeMarketing: false });
    assert.equal(consent.status, 201);
    assert.match(consent.headers["set-cookie"].join(";"), /tteok_customer_token=/);
    const identity = db.prepare("SELECT user_id FROM social_identities WHERE provider='google' AND provider_user_id='new-google-id'").get();
    const user = db.prepare("SELECT profile_completed, name FROM user_accounts WHERE id=?").get(identity.user_id);
    assert.equal(user.profile_completed, 0);
    assert.equal(user.name, "Google User");
  } finally { global.fetch = originalFetch; }
});

test("an existing email requires password confirmation before linking", async () => {
  insertUser("existing_user", "existing@example.com", "password123");
  const agent = request.agent(app);
  const start = await agent.get("/api/auth/social/google");
  const state = new URL(start.headers.location).searchParams.get("state");
  const originalFetch = global.fetch;
  global.fetch = async (url) => String(url).includes("token")
    ? new Response(JSON.stringify({ access_token: "token" }), { status: 200, headers: { "Content-Type": "application/json" } })
    : new Response(JSON.stringify({ sub: "existing-google-id", email: "existing@example.com", email_verified: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const callback = await agent.get(`/api/auth/social/google/callback?code=code&state=${state}`);
    assert.equal(callback.headers.location, "/login.html?social_link=google");
    const login = await agent.post("/api/users/login").send({ identifier: "existing_user", password: "password123" });
    assert.equal(login.body.socialLinked, "google");
  } finally { global.fetch = originalFetch; }
});

test("Naver sends the verified state during token exchange", async () => {
  const agent = request.agent(app);
  const start = await agent.get("/api/auth/social/naver");
  const state = new URL(start.headers.location).searchParams.get("state");
  let tokenBody = "";
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("oauth2.0/token")) {
      tokenBody = String(options.body);
      return new Response(JSON.stringify({ access_token: "token" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ response: { id: "naver-new-id", name: "Naver User" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const callback = await agent.get(`/api/auth/social/naver/callback?code=code&state=${state}`);
    assert.equal(callback.headers.location, "/social-consent.html");
    assert.equal(new URLSearchParams(tokenBody).get("state"), state);
  } finally { global.fetch = originalFetch; }
});

test("a Kakao identity without email still creates and signs into an account", async () => {
  const agent = request.agent(app);
  const start = await agent.get("/api/auth/social/kakao");
  const state = new URL(start.headers.location).searchParams.get("state");
  const originalFetch = global.fetch;
  global.fetch = async (url) => String(url).includes("oauth/token")
    ? new Response(JSON.stringify({ access_token: "token" }), { status: 200, headers: { "Content-Type": "application/json" } })
    : new Response(JSON.stringify({ id: 987654321, properties: { nickname: "Kakao User" }, kakao_account: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const callback = await agent.get(`/api/auth/social/kakao/callback?code=code&state=${state}`);
    assert.equal(callback.headers.location, "/social-consent.html");
    const consent = await agent.post("/api/auth/social/signup-consent").send({ agreeTerms: true, agreePrivacy: true });
    assert.equal(consent.status, 201);
    const identity = db.prepare("SELECT user_id FROM social_identities WHERE provider='kakao' AND provider_user_id='987654321'").get();
    assert.ok(identity.user_id);
  } finally { global.fetch = originalFetch; }
});
