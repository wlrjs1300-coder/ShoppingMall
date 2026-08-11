process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "admin-order-pii-access-test-secret";
process.env.ADMIN_JWT_ISSUER = "test-admin-issuer";
process.env.ADMIN_JWT_AUDIENCE = "test-admin-audience";
process.env.ORDER_PII_PROTECTION_ENABLED = "true";
process.env.ORDER_PII_KEYS_JSON = JSON.stringify([
  { version: "v1", key: Buffer.alloc(32, 41).toString("base64") },
]);
process.env.ORDER_PII_ACTIVE_KEY_VERSION = "v1";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const { issueAdminToken } = require("../middleware/auth");
const { buildOrderPiiColumns } = require("../services/order-pii-service");
const { getDefaultOrderPiiKeyring } = require("../lib/pii-keyring");
const {
  MAX_REQUESTS,
  WINDOW_MS,
  resetOrderPiiAccessLimiterForTest,
  setOrderPiiAccessNowForTest,
} = require("../lib/order-pii-access");

const fixturePii = {
  customerName: "Access Fixture",
  customerPhone: "01098765432",
  deliveryAddress: "Fixture delivery address",
  guestAddress: "Fixture guest address",
};

function createAdmin(id, role) {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO user_accounts
    (id,username,email,password_hash,name,phone,role,status,terms_agreed_at,privacy_agreed_at,
     marketing_consent,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'admin','active',?,?,0,?,?)`)
    .run(id, id, `${id}@admin.test`, bcrypt.hashSync("StrongPassword1!", 4), id, "01000000000", now, now, now, now);
  db.prepare(`INSERT OR REPLACE INTO admin_accounts
    (user_id,role,is_active,token_version,created_at,updated_at) VALUES (?,?,1,0,?,?)`)
    .run(id, role, now, now);
  return issueAdminToken({ id, role, tokenVersion: 0 });
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function insertOrder(id, { encrypted = false } = {}) {
  const now = new Date().toISOString();
  const protectedColumns = encrypted
    ? buildOrderPiiColumns(fixturePii, getDefaultOrderPiiKeyring(), now)
    : null;
  db.prepare(`INSERT INTO orders (
    id, customer_name, customer_phone, fulfillment_type, delivery_address,
    pickup_date, pickup_time, subtotal, delivery_fee, total_amount, cost, status,
    payment_status, amount_status, guest_address, created_at, updated_at,
    pii_ciphertext, pii_iv, pii_auth_tag, pii_key_version, customer_name_masked,
    customer_phone_masked, delivery_region_masked, pii_migrated_at
  ) VALUES (?, ?, ?, 'delivery', ?, '2099-12-31', '14:00', 1000, 0, 1000, 0,
    '접수대기', '결제대기', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      encrypted ? "[protected]" : fixturePii.customerName,
      encrypted ? "[protected]" : fixturePii.customerPhone,
      encrypted ? null : fixturePii.deliveryAddress,
      encrypted ? null : fixturePii.guestAddress,
      now,
      now,
      protectedColumns?.piiCiphertext || null,
      protectedColumns?.piiIv || null,
      protectedColumns?.piiAuthTag || null,
      protectedColumns?.piiKeyVersion || null,
      protectedColumns?.customerNameMasked || null,
      protectedColumns?.customerPhoneMasked || null,
      protectedColumns?.deliveryRegionMasked || null,
      protectedColumns?.piiMigratedAt || null,
    );
}

function assertNoStore(response) {
  assert.equal(response.headers["cache-control"], "no-store, private");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
}

test.beforeEach(() => {
  resetOrderPiiAccessLimiterForTest();
  db.prepare("DELETE FROM activity_logs WHERE action LIKE 'order_pii_access%'").run();
});

test("migration 16 adds constrained nullable audit columns and the access index", () => {
  assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 28);
  const columns = new Map(db.prepare("PRAGMA table_info(activity_logs)").all().map((column) => [column.name, column]));
  for (const name of ["reason", "outcome", "failure_code", "actor_role", "request_ip"]) {
    assert.ok(columns.has(name));
    assert.equal(columns.get(name).notnull, 0);
  }
  assert.ok(db.prepare("PRAGMA index_list(activity_logs)").all()
    .some((index) => index.name === "idx_activity_logs_action_entity_created"));
  assert.throws(() => db.prepare(`INSERT INTO activity_logs
    (id, created_at, actor, reason, outcome) VALUES ('bad-audit', ?, 'test', ?, 'success')`)
    .run(new Date().toISOString(), "x".repeat(51)), /ACTIVITY_LOG_STRUCTURED_AUDIT_INVALID/);
  assert.throws(() => db.prepare(`INSERT INTO activity_logs
    (id, created_at, actor, outcome) VALUES ('bad-outcome', ?, 'test', 'unknown')`)
    .run(new Date().toISOString()), /ACTIVITY_LOG_STRUCTURED_AUDIT_INVALID/);
});

test("super_admin and operations can access one legacy or encrypted order with strict safe audit", async () => {
  insertOrder("pii-access-legacy");
  insertOrder("pii-access-encrypted", { encrypted: true });
  for (const [id, role, orderId] of [
    ["pii-super", "super_admin", "pii-access-encrypted"],
    ["pii-operations", "operations", "pii-access-legacy"],
  ]) {
    const response = await request(app).post(`/api/orders/${orderId}/pii-access`)
      .set(auth(createAdmin(id, role))).send({ reason: " delivery_contact " }).expect(200);
    assert.deepEqual(Object.keys(response.body).sort(), ["customer", "deliveryAddress", "orderId", "phone"]);
    assert.equal(response.body.customer, fixturePii.customerName);
    assert.equal(response.body.phone, fixturePii.customerPhone);
    assert.equal(response.body.deliveryAddress, fixturePii.deliveryAddress);
    assert.equal("guestAddress" in response.body, false);
    assertNoStore(response);
    const log = db.prepare("SELECT * FROM activity_logs WHERE action='order_pii_accessed' AND entity_id=? ORDER BY created_at DESC").get(orderId);
    assert.equal(log.actor, id);
    assert.equal(log.actor_role, role);
    assert.equal(log.reason, "delivery_contact");
    assert.equal(log.outcome, "success");
    assert.equal(log.failure_code, null);
    const serialized = JSON.stringify(log);
    for (const secret of Object.values(fixturePii)) assert.equal(serialized.includes(secret), false);
  }
});

test("structured PII audit fields are available to authorized audit readers without protected values", async () => {
  insertOrder("pii-audit-read");
  const token = createAdmin("pii-audit-reader", "operations");
  await request(app).post("/api/orders/pii-audit-read/pii-access")
    .set(auth(token)).send({ reason: "address_verification" }).expect(200);
  const response = await request(app).get("/api/activity-logs?limit=20")
    .set(auth(token)).expect(200);
  const log = response.body.find((entry) => entry.action === "order_pii_accessed"
    && entry.entityId === "pii-audit-read");
  assert.equal(log.reason, "address_verification");
  assert.equal(log.outcome, "success");
  assert.equal(log.failureCode, null);
  assert.equal(log.actorRole, "operations");
  const serialized = JSON.stringify(log);
  for (const secret of Object.values(fixturePii)) assert.equal(serialized.includes(secret), false);
});

test("authentication, role permission and reason validation fail closed", async () => {
  insertOrder("pii-access-permission");
  const unauthenticated = await request(app).post("/api/orders/pii-access-permission/pii-access")
    .send({ reason: "order_issue" }).expect(401);
  assertNoStore(unauthenticated);
  for (const role of ["finance", "viewer"]) {
    const denied = await request(app).post("/api/orders/pii-access-permission/pii-access")
      .set(auth(createAdmin(`pii-${role}`, role))).send({ reason: "order_issue" }).expect(403);
    assert.equal(denied.body.reason, "ORDER_PII_PERMISSION_DENIED");
    assertNoStore(denied);
  }
  const operations = createAdmin("pii-invalid-reason", "operations");
  for (const reason of ["", "free text", null]) {
    const invalid = await request(app).post("/api/orders/pii-access-permission/pii-access")
      .set(auth(operations)).send({ reason }).expect(400);
    assert.equal(invalid.body.reason, "ORDER_PII_REASON_INVALID");
    assertNoStore(invalid);
  }
  const logs = db.prepare("SELECT * FROM activity_logs WHERE action='order_pii_access_failed'").all();
  assert.equal(logs.length, 3);
  assert.ok(logs.every((log) => log.failure_code === "ORDER_PII_REASON_INVALID" && log.outcome === "failure"));
});

test("missing and unreadable orders expose no protected values and create safe failure audits", async () => {
  const token = createAdmin("pii-failure", "operations");
  const missing = await request(app).post("/api/orders/missing-pii-order/pii-access")
    .set(auth(token)).send({ reason: "order_issue" }).expect(404);
  assert.equal(missing.body.reason, "ORDER_PII_ACCESS_FAILED");

  insertOrder("pii-bad-tag", { encrypted: true });
  db.prepare("UPDATE orders SET pii_auth_tag=? WHERE id='pii-bad-tag'").run(Buffer.alloc(16, 9).toString("base64"));
  const unreadable = await request(app).post("/api/orders/pii-bad-tag/pii-access")
    .set(auth(token)).send({ reason: "order_issue" }).expect(503);
  assert.equal(unreadable.body.reason, "ORDER_PII_ACCESS_FAILED");
  for (const response of [missing, unreadable]) {
    assertNoStore(response);
    const serialized = JSON.stringify(response.body);
    for (const secret of Object.values(fixturePii)) assert.equal(serialized.includes(secret), false);
    assert.doesNotMatch(serialized, /pii_ciphertext|pii_auth_tag|pii_key_version|SQLITE|stack/i);
  }
});

test("audit insertion failure rolls back and blocks the PII response", async () => {
  insertOrder("pii-audit-failure");
  const token = createAdmin("pii-audit-admin", "operations");
  db.exec(`CREATE TEMP TRIGGER fail_pii_access_audit
    BEFORE INSERT ON activity_logs WHEN NEW.action='order_pii_accessed'
    BEGIN SELECT RAISE(FAIL, 'forced strict audit failure'); END`);
  try {
    const response = await request(app).post("/api/orders/pii-audit-failure/pii-access")
      .set(auth(token)).send({ reason: "customer_request" }).expect(503);
    assert.equal(response.body.reason, "ORDER_PII_AUDIT_FAILED");
    assert.equal(JSON.stringify(response.body).includes(fixturePii.customerName), false);
    assertNoStore(response);
  } finally {
    db.exec("DROP TRIGGER fail_pii_access_audit");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM activity_logs WHERE action='order_pii_accessed' AND entity_id='pii-audit-failure'").get().count, 0);
});

test("the in-memory limiter allows 30 requests, isolates admins and resets after its window", async () => {
  insertOrder("pii-rate-limit");
  let now = 1_000_000;
  setOrderPiiAccessNowForTest(() => now);
  const tokenA = createAdmin("pii-rate-a", "operations");
  const tokenB = createAdmin("pii-rate-b", "operations");
  for (let index = 0; index < MAX_REQUESTS; index += 1) {
    await request(app).post("/api/orders/pii-rate-limit/pii-access")
      .set(auth(tokenA)).send({ reason: "order_issue" }).expect(200);
  }
  const limited = await request(app).post("/api/orders/pii-rate-limit/pii-access")
    .set(auth(tokenA)).send({ reason: "order_issue" }).expect(429);
  assert.equal(limited.body.reason, "ORDER_PII_RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  await request(app).post("/api/orders/pii-rate-limit/pii-access")
    .set(auth(tokenB)).send({ reason: "order_issue" }).expect(200);
  now += WINDOW_MS;
  await request(app).post("/api/orders/pii-rate-limit/pii-access")
    .set(auth(tokenA)).send({ reason: "order_issue" }).expect(200);
});

test("directory and customer batches stay masked for every read role including PII readers", async () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO user_accounts
    (id,username,email,password_hash,name,phone,role,status,terms_agreed_at,privacy_agreed_at,
     marketing_consent,created_at,updated_at)
    VALUES ('pii-directory-user','pii-directory-user','directory@example.test',?,'Directory Person',
      '01012344321','customer','active',?,?,0,?,?)`)
    .run(bcrypt.hashSync("Password1!", 4), now, now, now, now);
  db.prepare(`INSERT OR REPLACE INTO customers
    (id,name,phone,type,memo,created_at,updated_at)
    VALUES ('pii-customer-master','Customer Master','01055556666','normal','safe memo',?,?)`)
    .run(now, now);
  for (const role of ["super_admin", "operations", "finance", "viewer"]) {
    const token = createAdmin(`pii-batch-${role}`, role);
    const directory = await request(app).get("/api/users/admin/directory").set(auth(token)).expect(200);
    const customers = await request(app).get("/api/customers").set(auth(token)).expect(200);
    const serialized = JSON.stringify({ directory: directory.body, customers: customers.body });
    assert.equal(serialized.includes("Directory Person"), false);
    assert.equal(serialized.includes("01012344321"), false);
    assert.equal(serialized.includes("Customer Master"), false);
    assert.equal(serialized.includes("01055556666"), false);
    assert.match(serialized, /\*/);
  }
});

test("customer writes require orders:write and return only a masked record", async () => {
  const viewer = createAdmin("pii-customer-viewer", "viewer");
  await request(app).post("/api/customers").set(auth(viewer))
    .send({ name: "Blocked Person", phone: "01011112222" }).expect(403);

  const operations = createAdmin("pii-customer-writer", "operations");
  const created = await request(app).post("/api/customers").set(auth(operations))
    .send({ id: "pii-customer-write", name: "Writable Person", phone: "01022223333" }).expect(201);
  assert.notEqual(created.body.name, "Writable Person");
  assert.notEqual(created.body.phone, "01022223333");
  assert.match(created.body.name, /\*/);
  assert.match(created.body.phone, /\*/);
});

test("administrator UI keeps revealed PII in dialog-local memory and out of caches and exports", () => {
  const root = path.resolve(__dirname, "../..");
  const orders = fs.readFileSync(path.join(root, "js/admin/orders.js"), "utf8");
  const events = fs.readFileSync(path.join(root, "js/admin/events.js"), "utf8");
  const api = fs.readFileSync(path.join(root, "js/api.js"), "utf8");
  assert.match(orders, /hasAdminPermission\("orders:pii:read"\)/);
  assert.match(orders, /activeAdminOrderPii/);
  assert.match(orders, /ADMIN_ORDER_PII_TIMEOUT_MS = 3 \* 60 \* 1000/);
  assert.match(events, /\/pii-access/);
  assert.match(events, /body: \{ reason \}/);
  assert.match(events, /clearActiveAdminOrderPii\(\)/);
  assert.doesNotMatch(`${orders}\n${events}`, /localStorage\.(?:setItem|getItem)[^\n]*activeAdminOrderPii/);
  assert.doesNotMatch(`${orders}\n${events}`, /sessionStorage\.(?:setItem|getItem)[^\n]*activeAdminOrderPii/);
  assert.doesNotMatch(api, /pii-access/);
  assert.doesNotMatch(`${orders}\n${events}`, /console\.(?:log|error)[^\n]*pii/i);
});

test("PII access UI always restores its button and stores only a successful response", async () => {
  const root = path.resolve(__dirname, "../..");
  const events = fs.readFileSync(path.join(root, "js/admin/events.js"), "utf8");
  const helperStart = events.indexOf("async function requestAdminOrderPii");
  const helperEnd = events.indexOf("\ndocument.querySelector", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperSource = events.slice(helperStart, helperEnd);

  const successfulButton = { disabled: false };
  const successfulContext = {
    apiFetch: async () => ({ orderId: "success-order", customer: "Fixture" }),
    encodeURIComponent,
  };
  vm.runInNewContext(`${helperSource}; globalThis.requestAdminOrderPii = requestAdminOrderPii;`, successfulContext);
  const successfulPii = await successfulContext.requestAdminOrderPii(
    successfulButton,
    "success-order",
    "order_issue",
  );
  assert.equal(successfulButton.disabled, false);
  assert.equal(successfulPii.orderId, "success-order");

  const rejectedButton = { disabled: false };
  const rejectedContext = {
    apiFetch: async () => { throw new Error("network failure"); },
    encodeURIComponent,
  };
  vm.runInNewContext(`${helperSource}; globalThis.requestAdminOrderPii = requestAdminOrderPii;`, rejectedContext);
  await assert.rejects(
    rejectedContext.requestAdminOrderPii(rejectedButton, "failed-order", "order_issue"),
    /network failure/,
  );
  assert.equal(rejectedButton.disabled, false);

  const accessBranch = events.slice(
    events.indexOf('if (action === "access-pii")'),
    events.indexOf('if (action === "hide-pii")'),
  );
  assert.match(accessBranch, /if \(!pii \|\| pii\.orderId !== orderId\) return;\s*setActiveAdminOrderPii\(pii\)/);
  assert.equal((accessBranch.match(/setActiveAdminOrderPii\(/g) || []).length, 1);
});
