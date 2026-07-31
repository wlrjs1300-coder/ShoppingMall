process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "admin-order-pii-update-test-secret";
process.env.ADMIN_JWT_ISSUER = "test-admin-issuer";
process.env.ADMIN_JWT_AUDIENCE = "test-admin-audience";
process.env.ORDER_PII_PROTECTION_ENABLED = "true";
process.env.ORDER_PII_KEYS_JSON = JSON.stringify([
  { version: "v1", key: Buffer.alloc(32, 51).toString("base64") },
  { version: "v2", key: Buffer.alloc(32, 52).toString("base64") },
]);
process.env.ORDER_PII_ACTIVE_KEY_VERSION = "v2";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const { issueAdminToken } = require("../middleware/auth");
const {
  buildOrderPiiColumns,
  readOrderPiiForOperation,
} = require("../services/order-pii-service");
const {
  getDefaultOrderPiiKeyring,
  parsePiiKeyring,
  resetOrderPiiKeyringForTest,
} = require("../lib/pii-keyring");
const {
  UPDATE_MAX_REQUESTS,
  resetOrderPiiAccessLimiterForTest,
} = require("../lib/order-pii-access");

const originalPii = {
  customerName: "홍길동",
  customerPhone: "01012345678",
  deliveryAddress: "서울시 기존 배송지",
  guestAddress: "비회원 기존 주소",
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

function insertOrder(id, { encrypted = true, fulfillmentType = "delivery", keyVersion = "v2" } = {}) {
  const now = new Date(Date.now() - 1000).toISOString();
  let columns = null;
  if (encrypted) {
    const keyring = getDefaultOrderPiiKeyring();
    const selectedKeyring = keyVersion === keyring.activeVersion
      ? keyring
      : parsePiiKeyring(process.env.ORDER_PII_KEYS_JSON, keyVersion);
    columns = buildOrderPiiColumns(originalPii, selectedKeyring, now);
  }
  db.prepare(`INSERT INTO orders (
    id, customer_name, customer_phone, fulfillment_type, delivery_address,
    pickup_date, pickup_time, subtotal, delivery_fee, total_amount, cost, status,
    payment_status, amount_status, guest_address, created_at, updated_at,
    pii_ciphertext, pii_iv, pii_auth_tag, pii_key_version, customer_name_masked,
    customer_phone_masked, delivery_region_masked, pii_migrated_at
  ) VALUES (?, ?, ?, ?, ?, '2099-12-31', '14:00', 1000, 0, 1000, 0,
    '접수대기', '결제대기', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      encrypted ? "[protected]" : originalPii.customerName,
      encrypted ? "[protected]" : originalPii.customerPhone,
      fulfillmentType,
      encrypted ? null : originalPii.deliveryAddress,
      encrypted ? null : originalPii.guestAddress,
      now,
      now,
      columns?.piiCiphertext || null,
      columns?.piiIv || null,
      columns?.piiAuthTag || null,
      columns?.piiKeyVersion || null,
      columns?.customerNameMasked || null,
      columns?.customerPhoneMasked || null,
      columns?.deliveryRegionMasked || null,
      columns?.piiMigratedAt || null,
    );
  return db.prepare("SELECT * FROM orders WHERE id=?").get(id);
}

function setProtection(enabled) {
  process.env.ORDER_PII_PROTECTION_ENABLED = enabled ? "true" : "false";
}

function assertNoStore(response) {
  assert.equal(response.headers["cache-control"], "no-store, private");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
}

test.beforeEach(() => {
  setProtection(true);
  resetOrderPiiKeyringForTest();
  resetOrderPiiAccessLimiterForTest();
  db.prepare("DELETE FROM activity_logs WHERE action LIKE 'order_pii_update%'").run();
});

test("only super_admin can update PII and every response uses no-store headers", async () => {
  insertOrder("pii-update-permission");
  const unauthenticated = await request(app).patch("/api/orders/pii-update-permission/pii")
    .send({ phone: "01099998888", reason: "phone_correction" }).expect(401);
  assertNoStore(unauthenticated);
  for (const role of ["operations", "finance", "viewer"]) {
    const denied = await request(app).patch("/api/orders/pii-update-permission/pii")
      .set(auth(createAdmin(`update-${role}`, role)))
      .send({ phone: "01099998888", reason: "phone_correction" }).expect(403);
    assert.equal(denied.body.reason, "ORDER_PII_UPDATE_FORBIDDEN");
    assertNoStore(denied);
  }
});

test("encrypted partial update rotates to active key, preserves other fields and returns masks only", async () => {
  const before = insertOrder("pii-update-encrypted", { keyVersion: "v1" });
  const response = await request(app).patch("/api/orders/pii-update-encrypted/pii")
    .set(auth(createAdmin("update-super", "super_admin")))
    .send({
      phone: "010-9999-8888",
      reason: "phone_correction",
      expectedUpdatedAt: before.updated_at,
    }).expect(200);
  assertNoStore(response);
  assert.deepEqual(response.body.updatedFields, ["phone"]);
  assert.equal(response.body.phone, "010-****-8888");
  assert.equal(JSON.stringify(response.body).includes("01099998888"), false);
  assert.equal("guestAddress" in response.body, false);

  const stored = db.prepare("SELECT * FROM orders WHERE id='pii-update-encrypted'").get();
  assert.equal(stored.pii_key_version, "v2");
  assert.notEqual(stored.pii_ciphertext, before.pii_ciphertext);
  assert.notEqual(stored.pii_iv, before.pii_iv);
  assert.equal(stored.customer_name, "[protected]");
  assert.equal(stored.customer_phone, "[protected]");
  assert.equal(stored.delivery_address, null);
  assert.equal(stored.guest_address, null);
  const decrypted = readOrderPiiForOperation(stored);
  assert.deepEqual(decrypted, { ...originalPii, customerPhone: "01099998888" });

  const audit = db.prepare("SELECT * FROM activity_logs WHERE action='order_pii_updated' AND entity_id=?")
    .get(stored.id);
  assert.equal(audit.reason, "phone_correction");
  assert.equal(audit.outcome, "success");
  assert.deepEqual(JSON.parse(audit.next_value), { changedFields: ["phone"] });
  const serializedAudit = JSON.stringify(audit);
  for (const value of Object.values(originalPii)) assert.equal(serializedAudit.includes(value), false);
  assert.equal(serializedAudit.includes("01099998888"), false);
});

test("legacy rows follow flag policy without downgrade", async () => {
  insertOrder("pii-update-legacy-on", { encrypted: false });
  await request(app).patch("/api/orders/pii-update-legacy-on/pii")
    .set(auth(createAdmin("legacy-on-super", "super_admin")))
    .send({ customer: "김수정", reason: "name_correction" }).expect(200);
  const elevated = db.prepare("SELECT * FROM orders WHERE id='pii-update-legacy-on'").get();
  assert.equal(elevated.customer_name, "[protected]");
  assert.equal(elevated.pii_key_version, "v2");
  assert.equal(readOrderPiiForOperation(elevated).customerName, "김수정");

  setProtection(false);
  insertOrder("pii-update-legacy-off", { encrypted: false, fulfillmentType: "pickup" });
  await request(app).patch("/api/orders/pii-update-legacy-off/pii")
    .set(auth(createAdmin("legacy-off-super", "super_admin")))
    .send({ deliveryAddress: null, guestAddress: "새 비회원 주소", reason: "address_correction" })
    .expect(200);
  const legacy = db.prepare("SELECT * FROM orders WHERE id='pii-update-legacy-off'").get();
  assert.equal(legacy.pii_ciphertext, null);
  assert.equal(legacy.delivery_address, null);
  assert.equal(legacy.guest_address, "새 비회원 주소");

  setProtection(true);
  insertOrder("pii-update-encrypted-off");
  setProtection(false);
  const forbidden = await request(app).patch("/api/orders/pii-update-encrypted-off/pii")
    .set(auth(createAdmin("encrypted-off-super", "super_admin")))
    .send({ phone: "01077776666", reason: "phone_correction" }).expect(403);
  assert.equal(forbidden.body.reason, "ORDER_PII_UPDATE_FORBIDDEN");
});

test("validation rejects unsafe, unknown, no-op and stale updates", async () => {
  const row = insertOrder("pii-update-validation");
  const token = createAdmin("validation-super", "super_admin");
  const cases = [
    [{ reason: "customer_request" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ phone: "01012345678", reason: "phone_correction" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ customer: "홍*동", reason: "name_correction" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ phone: "[protected]", reason: "phone_correction" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ deliveryAddress: " ".repeat(3), reason: "address_correction" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ phone: "123", reason: "phone_correction" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ phone: "01099998888", reason: "free text" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ phone: "01099998888", unknown: true, reason: "phone_correction" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ deliveryAddress: null, reason: "address_correction" }, 400, "ORDER_PII_UPDATE_INVALID"],
    [{ phone: "01099998888", reason: "phone_correction", expectedUpdatedAt: `${row.updated_at}-stale` }, 409, "ORDER_PII_UPDATE_CONFLICT"],
  ];
  for (const [body, status, reason] of cases) {
    const response = await request(app).patch("/api/orders/pii-update-validation/pii")
      .set(auth(token)).send(body).expect(status);
    assert.equal(response.body.reason, reason);
  }
});

test("audit failure rolls back the update", async () => {
  const before = insertOrder("pii-update-audit-rollback");
  db.exec(`CREATE TEMP TRIGGER fail_pii_update_audit
    BEFORE INSERT ON activity_logs WHEN NEW.action='order_pii_updated'
    BEGIN SELECT RAISE(FAIL, 'forced strict update audit failure'); END`);
  try {
    const response = await request(app).patch("/api/orders/pii-update-audit-rollback/pii")
      .set(auth(createAdmin("audit-super", "super_admin")))
      .send({ phone: "01077776666", reason: "phone_correction" }).expect(503);
    assert.equal(response.body.reason, "ORDER_PII_AUDIT_FAILED");
  } finally {
    db.exec("DROP TRIGGER fail_pii_update_audit");
  }
  const after = db.prepare("SELECT * FROM orders WHERE id='pii-update-audit-rollback'").get();
  assert.equal(after.pii_ciphertext, before.pii_ciphertext);
  assert.equal(after.updated_at, before.updated_at);
});

test("existing PUT blocks real PII but continues non-PII updates", async () => {
  setProtection(false);
  insertOrder("pii-update-put", { encrypted: false });
  const token = createAdmin("put-super", "super_admin");
  const rejected = await request(app).put("/api/orders/pii-update-put")
    .set(auth(token)).send({ customer: "우회 변경" }).expect(400);
  assert.equal(rejected.body.reason, "ORDER_PII_UPDATE_FORBIDDEN");
  await request(app).put("/api/orders/pii-update-put")
    .set(auth(token)).send({ customer: "홍*동", phone: "010-****-5678", memo: "안전한 메모" })
    .expect(200);
  const stored = db.prepare("SELECT customer_name, customer_phone, memo FROM orders WHERE id='pii-update-put'").get();
  assert.equal(stored.customer_name, originalPii.customerName);
  assert.equal(stored.customer_phone, originalPii.customerPhone);
  assert.equal(stored.memo, "안전한 메모");
});

test("write limiter is isolated from read and blocks request 11 with Retry-After", async () => {
  insertOrder("pii-update-rate");
  const token = createAdmin("rate-super", "super_admin");
  for (let index = 0; index < UPDATE_MAX_REQUESTS; index += 1) {
    await request(app).patch("/api/orders/pii-update-rate/pii")
      .set(auth(token))
      .send({ phone: `010${String(10000000 + index).slice(-8)}`, reason: "phone_correction" })
      .expect(200);
  }
  const limited = await request(app).patch("/api/orders/pii-update-rate/pii")
    .set(auth(token)).send({ phone: "01088887777", reason: "phone_correction" }).expect(429);
  assert.equal(limited.body.reason, "ORDER_PII_UPDATE_RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  await request(app).post("/api/orders/pii-update-rate/pii-access")
    .set(auth(token)).send({ reason: "order_issue" }).expect(200);
});

test("UI creates a permission-gated empty update form and never sends PII through general PUT", () => {
  const ordersSource = fs.readFileSync(path.join(__dirname, "../../js/admin/orders.js"), "utf8");
  const eventsSource = fs.readFileSync(path.join(__dirname, "../../js/admin/events.js"), "utf8");
  assert.match(ordersSource, /hasAdminPermission\("orders:pii:write"\)/);
  assert.match(ordersSource, /data-admin-order-pii-update-form[^>]*autocomplete="off"/);
  assert.doesNotMatch(ordersSource, /data-inline-(customer|phone|address)/);
  assert.match(eventsSource, /method:\s*"PATCH"[\s\S]*body:\s*patch/);
  assert.doesNotMatch(eventsSource, /body:\s*JSON\.stringify\(patch\)/);
  assert.match(eventsSource, /finally\s*\{/);
  const editSave = eventsSource.slice(
    eventsSource.indexOf('if (action === "edit-save")'),
    eventsSource.indexOf('if (action === "delete")'),
  );
  assert.doesNotMatch(editSave, /\bcustomer\b|\bphone\b|\bdeliveryAddress\b/);
  assert.doesNotMatch(eventsSource, /console\.(log|info|debug).*pii/i);
});

test("PII update passes an object body and restores its button on success and rejection", async () => {
  const eventsSource = fs.readFileSync(
    path.join(__dirname, "../../js/admin/events.js"),
    "utf8",
  );
  const helperStart = eventsSource.indexOf("async function requestAdminOrderPiiUpdate");
  const helperEnd = eventsSource.indexOf("\ndocument.querySelector", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperSource = eventsSource.slice(helperStart, helperEnd);
  const patch = {
    reason: "phone_correction",
    phone: "01099998888",
    expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
  };
  let captured;
  const successfulButton = {
    disabled: false,
    isConnected: true,
    setAttribute() {},
    removeAttribute() {},
  };
  const successfulContext = {
    apiFetch: async (url, options) => {
      captured = { url, options };
      return { orderId: "object-body-order" };
    },
    encodeURIComponent,
  };
  require("node:vm").runInNewContext(
    `${helperSource}; globalThis.requestAdminOrderPiiUpdate = requestAdminOrderPiiUpdate;`,
    successfulContext,
  );
  await successfulContext.requestAdminOrderPiiUpdate(
    successfulButton,
    "object-body-order",
    patch,
  );
  assert.equal(successfulButton.disabled, false);
  assert.equal(captured.options.method, "PATCH");
  assert.equal(typeof captured.options.body, "object");
  assert.deepEqual(
    JSON.parse(JSON.stringify(captured.options.body)),
    patch,
  );
  assert.deepEqual(Object.keys(captured.options.body).sort(), [
    "expectedUpdatedAt",
    "phone",
    "reason",
  ]);
  assert.equal("customer" in captured.options.body, false);
  assert.equal("deliveryAddress" in captured.options.body, false);

  const rejectedButton = {
    disabled: false,
    isConnected: true,
    setAttribute() {},
    removeAttribute() {},
  };
  const rejectedContext = {
    apiFetch: async () => { throw new Error("network failure"); },
    encodeURIComponent,
  };
  require("node:vm").runInNewContext(
    `${helperSource}; globalThis.requestAdminOrderPiiUpdate = requestAdminOrderPiiUpdate;`,
    rejectedContext,
  );
  await assert.rejects(
    rejectedContext.requestAdminOrderPiiUpdate(rejectedButton, "failed-order", patch),
    /network failure/,
  );
  assert.equal(rejectedButton.disabled, false);
});
