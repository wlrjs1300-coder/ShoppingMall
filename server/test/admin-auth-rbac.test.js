process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "admin-rbac-test-secret-at-least-32-bytes";
process.env.ADMIN_CODE = "development-admin-code";
process.env.NODE_ENV = "test";
process.env.ADMIN_JWT_ISSUER = "test-admin-issuer";
process.env.ADMIN_JWT_AUDIENCE = "test-admin-audience";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const { issueAdminToken } = require("../middleware/auth");
const { issueCustomerToken } = require("../middleware/customerAuth");

function createAdmin(id, role, { active = true, password = "StrongAdminPassword1!" } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO user_accounts
    (id,username,email,password_hash,name,phone,role,status,terms_agreed_at,privacy_agreed_at,marketing_consent,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'admin','active',?,?,0,?,?)`)
    .run(id, id, `${id}@admin.test`, bcrypt.hashSync(password, 4), id, "01012345678", now, now, now, now);
  db.prepare(`INSERT OR REPLACE INTO admin_accounts
    (user_id,role,is_active,token_version,created_at,updated_at) VALUES (?,?,?,0,?,?)`)
    .run(id, role, active ? 1 : 0, now, now);
  return { id, role, password };
}

function tokenFor(id) {
  const admin = db.prepare("SELECT role, token_version FROM admin_accounts WHERE user_id=?").get(id);
  return issueAdminToken({ id, role: admin.role, tokenVersion: admin.token_version });
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function memberAgent(identifier, password) {
  const agent = request.agent(app);
  await agent.post("/api/users/login").send({ identifier, password }).expect(200);
  return agent;
}

test("production blocks legacy ADMIN_CODE while test compatibility remains available", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const blocked = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE }).expect(403);
  assert.equal(blocked.body.reason, "LEGACY_ADMIN_LOGIN_DISABLED");
  process.env.NODE_ENV = "test";
  const compatible = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE }).expect(200);
  assert.equal(compatible.body.admin.role, "super_admin");
  process.env.NODE_ENV = previous;
});

test("database administrator login is generic, rejects inactive accounts and returns permissions", async () => {
  const account = createAdmin("admin-login", "operations");
  const success = await request(app).post("/api/auth/login")
    .send({ identifier: account.id, password: account.password }).expect(200);
  assert.equal(success.body.admin.role, "operations");
  assert.ok(success.body.admin.permissions.includes("inventory:write"));
  const wrong = await request(app).post("/api/auth/login").send({ identifier: account.id, password: "wrong" }).expect(401);
  const missing = await request(app).post("/api/auth/login").send({ identifier: "missing-admin", password: "wrong" }).expect(401);
  assert.equal(wrong.body.error, missing.body.error);
  createAdmin("inactive-admin", "viewer", { active: false });
  const inactive = await request(app).post("/api/auth/login")
    .send({ identifier: "inactive-admin", password: "StrongAdminPassword1!" }).expect(401);
  assert.equal(inactive.body.error, missing.body.error);
});

test("administrator JWT validates issuer, audience, expiry, algorithm and current token version", async () => {
  createAdmin("admin-token", "viewer");
  const valid = tokenFor("admin-token");
  await request(app).get("/api/auth/me").set(auth(valid)).expect(200);
  const base = { sub: "admin-token", role: "viewer", tokenVersion: 0 };
  const options = { algorithm: "HS256", expiresIn: "1h", issuer: "test-admin-issuer", audience: "test-admin-audience" };
  const wrongIssuer = jwt.sign(base, process.env.JWT_SECRET, { ...options, issuer: "wrong" });
  const wrongAudience = jwt.sign(base, process.env.JWT_SECRET, { ...options, audience: "wrong" });
  const expired = jwt.sign(base, process.env.JWT_SECRET, { ...options, expiresIn: -1 });
  const wrongAlgorithm = jwt.sign(base, process.env.JWT_SECRET, { ...options, algorithm: "HS384" });
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  for (const token of [wrongIssuer, wrongAudience, expired, wrongAlgorithm]) {
    await request(app).get("/api/auth/me").set(auth(token)).expect(401);
  }
  process.env.NODE_ENV = previous;
  db.prepare("UPDATE admin_accounts SET token_version=token_version+1 WHERE user_id='admin-token'").run();
  await request(app).get("/api/auth/me").set(auth(valid)).expect(401);
});

test("viewer, operations, finance and super_admin receive least-privilege API access", async () => {
  for (const [id, role] of [["rbac-viewer", "viewer"], ["rbac-ops", "operations"], ["rbac-finance", "finance"], ["rbac-super", "super_admin"]]) {
    createAdmin(id, role);
  }
  const viewer = tokenFor("rbac-viewer");
  await request(app).get("/api/orders").set(auth(viewer)).expect(200);
  const viewerWrite = await request(app).post("/api/orders/admin").set(auth(viewer)).send({}).expect(403);
  assert.equal(viewerWrite.body.reason, "INSUFFICIENT_PERMISSION");

  const operations = tokenFor("rbac-ops");
  await request(app).put("/api/inventory/missing").set(auth(operations)).send({ name: "x" }).expect((response) => {
    assert.notEqual(response.status, 403);
  });
  await request(app).post("/api/payments/missing/cancel").set(auth(operations)).send({}).expect(403);

  const finance = tokenFor("rbac-finance");
  await request(app).post("/api/payments/missing/reconcile").set(auth(finance)).send({}).expect((response) => {
    assert.notEqual(response.status, 403);
  });
  await request(app).post("/api/payments/missing/cancel").set(auth(finance)).send({}).expect((response) => {
    assert.notEqual(response.status, 403);
  });
  await request(app).put("/api/inventory/missing").set(auth(finance)).send({}).expect(403);
  await request(app).delete("/api/activity-logs").set(auth(finance)).expect(405);

  const superAdmin = tokenFor("rbac-super");
  await request(app).put("/api/inventory/missing").set(auth(superAdmin)).send({}).expect((response) => {
    assert.notEqual(response.status, 403);
  });
});

test("administrator management revokes tokens and protects the last active super_admin", async () => {
  createAdmin("manage-super", "super_admin");
  createAdmin("manage-viewer", "viewer");
  const superToken = tokenFor("manage-super");
  const viewerToken = tokenFor("manage-viewer");
  await request(app).get("/api/admin-users").set(auth(viewerToken)).expect(403);
  await request(app).get("/api/admin-users").set(auth(superToken)).expect(200);
  await request(app).patch("/api/admin-users/manage-viewer").set(auth(superToken))
    .send({ role: "finance" }).expect(200);
  await request(app).get("/api/auth/me").set(auth(viewerToken)).expect(401);
  await request(app).post("/api/admin-users/manage-viewer/revoke-sessions").set(auth(superToken)).expect(200);

  db.prepare("UPDATE admin_accounts SET is_active=0 WHERE role='super_admin' AND user_id != 'manage-super'").run();
  const protectedResponse = await request(app).patch("/api/admin-users/manage-super").set(auth(superToken))
    .send({ role: "viewer" }).expect(409);
  assert.equal(protectedResponse.body.reason, "SELF_ROLE_CHANGE_BLOCKED");
  const audits = db.prepare("SELECT action FROM activity_logs WHERE entity_id='manage-viewer'").all().map((row) => row.action);
  assert.ok(audits.includes("admin_role_changed"));
  assert.ok(audits.includes("admin_sessions_revoked"));
});

test("self protection permits idempotent role requests but blocks self role changes and deactivation", async () => {
  createAdmin("self-super", "super_admin");
  const token = tokenFor("self-super");
  await request(app).patch("/api/admin-users/self-super").set(auth(token))
    .send({ role: "super_admin" }).expect(200);
  const role = await request(app).patch("/api/admin-users/self-super").set(auth(token))
    .send({ role: "viewer" }).expect(409);
  assert.equal(role.body.reason, "SELF_ROLE_CHANGE_BLOCKED");
  const inactive = await request(app).patch("/api/admin-users/self-super").set(auth(token))
    .send({ active: false }).expect(409);
  assert.equal(inactive.body.reason, "SELF_DEACTIVATION_BLOCKED");
});

test("last active super_admin checks and concurrent demotions keep at least one active", async () => {
  db.prepare("UPDATE admin_accounts SET is_active=0 WHERE role='super_admin'").run();
  createAdmin("race-super-a", "super_admin");
  createAdmin("race-super-b", "super_admin");
  const tokenA = tokenFor("race-super-a");
  const tokenB = tokenFor("race-super-b");
  const [changeA, changeB] = await Promise.all([
    request(app).patch("/api/admin-users/race-super-b").set(auth(tokenA)).send({ role: "viewer" }),
    request(app).patch("/api/admin-users/race-super-a").set(auth(tokenB)).send({ role: "viewer" }),
  ]);
  assert.ok([changeA.status, changeB.status].some((status) => status === 200));
  assert.ok([changeA.status, changeB.status].some((status) => status === 401 || status === 409));
  const remaining = db.prepare("SELECT COUNT(*) AS count FROM admin_accounts WHERE role='super_admin' AND is_active=1").get().count;
  assert.equal(remaining, 1);
  const last = db.prepare("SELECT user_id FROM admin_accounts WHERE role='super_admin' AND is_active=1").get();
  const lastToken = tokenFor(last.user_id);
  const deactivate = await request(app).patch(`/api/admin-users/${last.user_id}`).set(auth(lastToken)).send({ active: false }).expect(409);
  assert.equal(deactivate.body.reason, "SELF_DEACTIVATION_BLOCKED");
  const legacyActor = jwt.sign({ sub: "legacy-test-actor", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const demoteLast = await request(app).patch(`/api/admin-users/${last.user_id}`).set(auth(legacyActor)).send({ role: "viewer" }).expect(409);
  assert.equal(demoteLast.body.reason, "LAST_ACTIVE_SUPER_ADMIN");
});

test("administrator list omits session versions, password material and tokens", async () => {
  createAdmin("list-super", "super_admin");
  const response = await request(app).get("/api/admin-users").set(auth(tokenFor("list-super"))).expect(200);
  const serialized = JSON.stringify(response.body);
  for (const forbidden of ["password_hash", "passwordHash", "tokenVersion", "token_version", "jwt", "JWT_SECRET"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("legacy role token fallbacks are test-only while development requires a contracted DB token", async () => {
  createAdmin("development-admin", "viewer");
  const legacy = jwt.sign({ sub: "missing-development-admin", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const valid = tokenFor("development-admin");
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  await request(app).get("/api/auth/me").set(auth(legacy)).expect(401);
  await request(app).get("/api/auth/me").set(auth(valid)).expect(200);
  process.env.NODE_ENV = "test";
  await request(app).get("/api/auth/me").set(auth(legacy)).expect(200);
  process.env.NODE_ENV = previous;
});

test("administrator password change atomically updates password, token version and audit", async () => {
  const account = createAdmin("password-admin", "super_admin");
  const oldAdminToken = tokenFor(account.id);
  const customerToken = issueCustomerToken(account.id, "admin");
  const before = db.prepare("SELECT token_version FROM admin_accounts WHERE user_id=?").get(account.id).token_version;
  await request(app).post("/api/users/me/password")
    .set("Cookie", `tteok_customer_token=${customerToken}`)
    .send({ currentPassword: account.password, newPassword: "NewStrongAdminPassword2!" }).expect(200);
  const after = db.prepare("SELECT token_version FROM admin_accounts WHERE user_id=?").get(account.id).token_version;
  assert.equal(after, before + 1);
  await request(app).get("/api/auth/me").set(auth(oldAdminToken)).expect(401);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE action='admin_password_changed' AND entity_id=?").get(account.id).count, 1);
});

test("administrator password change rolls back when token version update fails, while customer changes still work", async () => {
  const admin = createAdmin("password-rollback-admin", "viewer");
  const cookie = issueCustomerToken(admin.id, "admin");
  const before = db.prepare("SELECT password_hash FROM user_accounts WHERE id=?").get(admin.id).password_hash;
  db.exec(`CREATE TEMP TRIGGER fail_admin_token_update BEFORE UPDATE ON admin_accounts
    WHEN OLD.user_id='password-rollback-admin'
    BEGIN SELECT RAISE(FAIL, 'forced token failure'); END`);
  try {
    await request(app).post("/api/users/me/password").set("Cookie", `tteok_customer_token=${cookie}`)
      .send({ currentPassword: admin.password, newPassword: "NeverCommittedPassword3!" }).expect(500);
  } finally {
    db.exec("DROP TRIGGER fail_admin_token_update");
  }
  assert.equal(db.prepare("SELECT password_hash FROM user_accounts WHERE id=?").get(admin.id).password_hash, before);

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user_accounts
    (id,username,email,password_hash,name,phone,role,status,terms_agreed_at,privacy_agreed_at,marketing_consent,created_at,updated_at)
    VALUES ('password-customer','password_customer','password-customer@test.local',?,'customer','01012345678','customer','active',?,?,0,?,?)`)
    .run(bcrypt.hashSync("CustomerPassword1!", 4), now, now, now, now);
  const customerCookie = issueCustomerToken("password-customer");
  await request(app).post("/api/users/me/password").set("Cookie", `tteok_customer_token=${customerCookie}`)
    .send({ currentPassword: "CustomerPassword1!", newPassword: "CustomerPassword2!" }).expect(200);
});

test("administrator changes and audit records rollback together on audit failure", async () => {
  createAdmin("atomic-actor", "super_admin");
  createAdmin("atomic-target", "viewer");
  const actorToken = tokenFor("atomic-actor");
  const before = db.prepare("SELECT role,is_active,token_version FROM admin_accounts WHERE user_id='atomic-target'").get();
  db.exec(`CREATE TEMP TRIGGER fail_admin_change_audit BEFORE INSERT ON activity_logs
    WHEN NEW.action IN ('admin_role_changed','admin_account_deactivated','admin_sessions_revoked')
    BEGIN SELECT RAISE(FAIL, 'forced admin audit failure'); END`);
  try {
    await request(app).patch("/api/admin-users/atomic-target").set(auth(actorToken)).send({ role: "finance" }).expect(500);
    assert.deepEqual(db.prepare("SELECT role,is_active,token_version FROM admin_accounts WHERE user_id='atomic-target'").get(), before);
    await request(app).patch("/api/admin-users/atomic-target").set(auth(actorToken)).send({ active: false }).expect(500);
    assert.deepEqual(db.prepare("SELECT role,is_active,token_version FROM admin_accounts WHERE user_id='atomic-target'").get(), before);
    await request(app).post("/api/admin-users/atomic-target/revoke-sessions").set(auth(actorToken)).expect(500);
    assert.deepEqual(db.prepare("SELECT role,is_active,token_version FROM admin_accounts WHERE user_id='atomic-target'").get(), before);
  } finally {
    db.exec("DROP TRIGGER fail_admin_change_audit");
  }
});

test("administrator update row-count mismatch rolls back account and token version", async () => {
  createAdmin("rowcount-actor", "super_admin");
  createAdmin("rowcount-target", "viewer");
  const before = db.prepare("SELECT role,is_active,token_version FROM admin_accounts WHERE user_id='rowcount-target'").get();
  db.exec(`CREATE TEMP TRIGGER ignore_admin_update BEFORE UPDATE ON admin_accounts
    WHEN OLD.user_id='rowcount-target' BEGIN SELECT RAISE(IGNORE); END`);
  try {
    await request(app).patch("/api/admin-users/rowcount-target").set(auth(tokenFor("rowcount-actor")))
      .send({ role: "finance" }).expect(500);
  } finally {
    db.exec("DROP TRIGGER ignore_admin_update");
  }
  assert.deepEqual(db.prepare("SELECT role,is_active,token_version FROM admin_accounts WHERE user_id='rowcount-target'").get(), before);
});

test("admin account mutation validates and updates inside BEGIN IMMEDIATE", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/admin-users.js"), "utf8");
  const patchBody = source.slice(source.indexOf('router.patch("/:id"'), source.indexOf('router.post("/:id/revoke-sessions"'));
  assert.ok(patchBody.indexOf('db.exec("BEGIN IMMEDIATE")') < patchBody.indexOf("SELECT user_id, role, is_active, token_version"));
  assert.ok(patchBody.indexOf("activeSuperAdminCount()") < patchBody.indexOf("UPDATE admin_accounts"));
  assert.match(patchBody, /updated\.changes !== 1/);
});

test("admin session exchange requires a DB admin account in production, development and test", async () => {
  const account = createAdmin("session-missing", "viewer");
  db.prepare("DELETE FROM admin_accounts WHERE user_id=?").run(account.id);
  const agent = await memberAgent(account.id, account.password);
  const previous = process.env.NODE_ENV;
  for (const environment of ["production", "development", "test"]) {
    process.env.NODE_ENV = environment;
    const response = await agent.post("/api/users/admin-session").expect(403);
    assert.equal(response.body.reason, "ADMIN_ACCOUNT_REQUIRED");
  }
  process.env.NODE_ENV = previous;
});

test("admin session exchange rejects inactive and invalid DB administrator records", async () => {
  const inactive = createAdmin("session-inactive", "viewer", { active: false });
  const inactiveAgent = await memberAgent(inactive.id, inactive.password);
  const inactiveResponse = await inactiveAgent.post("/api/users/admin-session").expect(403);
  assert.equal(inactiveResponse.body.reason, "ADMIN_ACCOUNT_INACTIVE");

  const invalid = createAdmin("session-invalid-role", "viewer");
  db.exec("PRAGMA ignore_check_constraints=ON");
  db.prepare("UPDATE admin_accounts SET role='invalid-role' WHERE user_id=?").run(invalid.id);
  db.exec("PRAGMA ignore_check_constraints=OFF");
  const invalidAgent = await memberAgent(invalid.id, invalid.password);
  const invalidResponse = await invalidAgent.post("/api/users/admin-session").expect(403);
  assert.equal(invalidResponse.body.reason, "INVALID_ADMIN_ROLE");
});

test("admin session exchange uses only current DB role and token version without exposing internals", async () => {
  const account = createAdmin("session-current", "finance");
  const agent = await memberAgent(account.id, account.password);
  const first = await agent.post("/api/users/admin-session").expect(200);
  const firstPayload = jwt.verify(first.body.token, process.env.JWT_SECRET);
  assert.equal(first.body.admin.role, "finance");
  assert.equal(firstPayload.role, "finance");
  assert.equal(firstPayload.tokenVersion, 0);
  assert.equal("tokenVersion" in first.body.admin, false);

  db.prepare("UPDATE admin_accounts SET role='operations', token_version=token_version+1 WHERE user_id=?").run(account.id);
  const second = await agent.post("/api/users/admin-session").expect(200);
  const secondPayload = jwt.verify(second.body.token, process.env.JWT_SECRET);
  assert.equal(second.body.admin.role, "operations");
  assert.equal(secondPayload.role, "operations");
  assert.equal(secondPayload.tokenVersion, 1);
});

test("withdrawn members and ordinary customers cannot exchange administrator sessions", async () => {
  const withdrawn = createAdmin("session-withdrawn", "viewer");
  const withdrawnAgent = await memberAgent(withdrawn.id, withdrawn.password);
  db.prepare("UPDATE user_accounts SET status='withdrawn' WHERE id=?").run(withdrawn.id);
  await withdrawnAgent.post("/api/users/admin-session").expect(401);

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user_accounts
    (id,username,email,password_hash,name,phone,role,status,terms_agreed_at,privacy_agreed_at,marketing_consent,created_at,updated_at)
    VALUES ('session-customer','session_customer','session-customer@test.local',?,'customer','01012345678','customer','active',?,?,0,?,?)`)
    .run(bcrypt.hashSync("CustomerSession1!", 4), now, now, now, now);
  const customerAgent = await memberAgent("session_customer", "CustomerSession1!");
  await customerAgent.post("/api/users/admin-session").expect(403);
});

test("admin session route contains no automatic super_admin or token-version fallback", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/users.js"), "utf8");
  const body = source.slice(source.indexOf('router.post("/admin-session"'), source.indexOf("function getMemberOrderStatusHistory"));
  assert.doesNotMatch(body, /admin\?\.role\s*\|\|\s*["']super_admin["']/);
  assert.doesNotMatch(body, /token_version\s*\|\|\s*0|tokenVersion:\s*[^,]*\|\|\s*0/);
  assert.match(body, /ADMIN_ACCOUNT_REQUIRED/);
  assert.match(body, /ADMIN_ACCOUNT_INACTIVE/);
  assert.match(body, /INVALID_ADMIN_ROLE/);
});

test("administrator login limiter blocks repeated failures outside test mode", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    last = await request(app).post("/api/auth/login").send({ code: "wrong-code" });
  }
  assert.equal(last.status, 429);
  process.env.NODE_ENV = previous;
});

test("permission denial remains enforced when security audit insertion fails", async () => {
  createAdmin("audit-failure-viewer", "viewer");
  db.exec(`CREATE TEMP TRIGGER fail_permission_audit BEFORE INSERT ON activity_logs
    WHEN NEW.action='admin_permission_denied'
    BEGIN SELECT RAISE(FAIL, 'forced audit failure'); END`);
  try {
    const response = await request(app).put("/api/inventory/missing")
      .set(auth(tokenFor("audit-failure-viewer"))).send({}).expect(403);
    assert.equal(response.body.reason, "INSUFFICIENT_PERMISSION");
  } finally {
    db.exec("DROP TRIGGER fail_permission_audit");
  }
});

test("administrator UI consumes server permissions and hides unauthorized sensitive controls", () => {
  const dashboard = fs.readFileSync(path.join(__dirname, "../../js/admin/dashboard.js"), "utf8");
  assert.match(dashboard, /currentAdminPermissions = new Set/);
  assert.match(dashboard, /"payments:cancel"/);
  assert.match(dashboard, /"payments:reconcile"/);
  assert.match(dashboard, /"inventory:write"/);
  assert.match(dashboard, /element\.hidden = !currentAdminPermissions\.has\(permission\)/);
  assert.doesNotMatch(dashboard, /오프라인.*로컬 코드|code !== adminAccessCode/);
});
