process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "order-pii-write-encryption-test-secret";
process.env.ADMIN_JWT_ISSUER = "test-admin-issuer";
process.env.ADMIN_JWT_AUDIENCE = "test-admin-audience";
process.env.ORDER_PII_PROTECTION_ENABLED = "true";
const VALID_ORDER_PII_KEYS_JSON = JSON.stringify([
  { version: "v1", key: Buffer.alloc(32, 61).toString("base64") },
  { version: "v2", key: Buffer.alloc(32, 62).toString("base64") },
]);
process.env.ORDER_PII_KEYS_JSON = VALID_ORDER_PII_KEYS_JSON;
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
const { resetOrderPiiKeyringForTest } = require("../lib/pii-keyring");
const { readOrderPiiForOperation } = require("../services/order-pii-service");

const fixture = {
  customer: "암호화고객",
  phone: "01024681357",
  deliveryAddress: "서울시 암호화구 안전로 1",
};

function product() {
  return db.prepare(`SELECT id, price FROM products
    WHERE status='active' AND purchase_type='direct' ORDER BY display_order LIMIT 1`).get();
}

function futureDate() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date.toISOString().slice(0, 10);
}

function orderBody(overrides = {}) {
  const selected = product();
  return {
    productId: selected.id,
    quantity: 1,
    pickupDate: futureDate(),
    pickupTime: "14:00",
    fulfillmentType: "delivery",
    paymentMethod: "onsite",
    ...fixture,
    ...overrides,
  };
}

function checkoutBody(overrides = {}) {
  const selected = product();
  const source = orderBody(overrides);
  delete source.productId;
  delete source.quantity;
  return {
    ...source,
    items: [{ productId: selected.id, quantity: 1 }],
  };
}

function adminToken(id = "pii-write-admin", role = "operations") {
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

function assertEncryptedRow(row) {
  assert.equal(row.customer_name, "[protected]");
  assert.equal(row.customer_phone, "[protected]");
  assert.equal(row.delivery_address, null);
  assert.equal(row.guest_address, null);
  for (const field of ["pii_ciphertext", "pii_iv", "pii_auth_tag", "pii_key_version"]) {
    assert.equal(typeof row[field], "string");
    assert.ok(row[field]);
  }
  assert.equal(row.pii_key_version, "v2");
  assert.equal(row.pii_migrated_at, null);
  const serialized = JSON.stringify(row);
  for (const value of Object.values(fixture)) assert.equal(serialized.includes(value), false);
}

function assertPlaintextRow(row) {
  assert.equal(row.customer_name, fixture.customer);
  assert.equal(row.customer_phone, fixture.phone);
  assert.equal(row.delivery_address, fixture.deliveryAddress);
  for (const field of [
    "pii_ciphertext",
    "pii_iv",
    "pii_auth_tag",
    "pii_key_version",
    "customer_name_masked",
    "customer_phone_masked",
    "delivery_region_masked",
  ]) {
    assert.equal(row[field], null);
  }
}

async function createReplayCheckout(key) {
  const response = await request(app).post("/api/orders/checkout")
    .set("Idempotency-Key", key)
    .send(checkoutBody({ paymentMethod: "card" })).expect(201);
  return {
    body: checkoutBody({ paymentMethod: "card" }),
    order: db.prepare("SELECT * FROM orders WHERE id=?").get(response.body.checkoutId),
    payment: db.prepare("SELECT * FROM payments WHERE order_id=?").get(response.body.checkoutId),
  };
}

async function assertBlockedCheckoutReplay({ key, body, order, payment }) {
  const replay = await request(app).post("/api/orders/checkout")
    .set("Idempotency-Key", key).send(body).expect(200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(replay.body.checkoutId, order.id);
  assert.equal(replay.body.paymentUrl, null);
  const payments = db.prepare("SELECT * FROM payments WHERE order_id=?").all(order.id);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].id, payment.id);
  assert.equal(payments[0].link_token_hash, payment.link_token_hash);
  const after = db.prepare("SELECT * FROM orders WHERE id=?").get(order.id);
  assert.equal(after.pii_ciphertext, order.pii_ciphertext);
  assert.equal(after.pii_iv, order.pii_iv);
}

test.beforeEach(() => {
  process.env.ORDER_PII_PROTECTION_ENABLED = "true";
  process.env.ORDER_PII_KEYS_JSON = VALID_ORDER_PII_KEYS_JSON;
  process.env.ORDER_PII_ACTIVE_KEY_VERSION = "v2";
  resetOrderPiiKeyringForTest();
});

test("general order keeps the complete legacy plaintext contract while protection is OFF", async () => {
  process.env.ORDER_PII_PROTECTION_ENABLED = "false";
  resetOrderPiiKeyringForTest();
  try {
    const created = await request(app).post("/api/orders")
      .set("Idempotency-Key", "pii-general-flag-off-0001")
      .send(orderBody({ phone: "010-2468-1357" })).expect(201);
    const row = db.prepare("SELECT * FROM orders WHERE id=?").get(created.body.id);
    assertPlaintextRow(row);
    assert.equal(created.body.customer, fixture.customer);
    assert.equal(created.body.phone, fixture.phone);
    assert.equal(created.body.deliveryAddress, fixture.deliveryAddress);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM order_items WHERE order_id=?").get(row.id).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM order_status_history WHERE order_id=?").get(row.id).count, 1);
  } finally {
    process.env.ORDER_PII_PROTECTION_ENABLED = "true";
    resetOrderPiiKeyringForTest();
  }
});

test("checkout keeps order plaintext while payment PII remains absent with protection OFF", async () => {
  process.env.ORDER_PII_PROTECTION_ENABLED = "false";
  resetOrderPiiKeyringForTest();
  try {
    const key = "pii-checkout-flag-off-0001";
    const created = await request(app).post("/api/orders/checkout")
      .set("Idempotency-Key", key)
      .send(checkoutBody({ paymentMethod: "card", phone: "010-2468-1357" })).expect(201);
    const row = db.prepare("SELECT * FROM orders WHERE id=?").get(created.body.checkoutId);
    assertPlaintextRow(row);
    const payment = db.prepare("SELECT * FROM payments WHERE order_id=?").get(row.id);
    assert.ok(payment);
    assert.equal(payment.customer_name, null);
    assert.equal(payment.customer_phone, null);
    assert.ok(db.prepare("SELECT 1 FROM checkout_idempotency WHERE idempotency_key=?").get(key));
    assert.match(created.body.paymentUrl, /^pay\.html\?/);
    assert.equal(created.body.order.customer, fixture.customer);
    assert.equal(created.body.order.phone, fixture.phone);
    assert.equal(created.body.order.deliveryAddress, fixture.deliveryAddress);
  } finally {
    process.env.ORDER_PII_PROTECTION_ENABLED = "true";
    resetOrderPiiKeyringForTest();
  }
});

test("general order writes encrypted PII once and idempotency replay preserves ciphertext", async () => {
  const key = "pii-general-idempotency-0001";
  const created = await request(app).post("/api/orders")
    .set("Idempotency-Key", key).send(orderBody()).expect(201);
  assert.match(created.body.customer, /\*/);
  assert.equal(created.body.deliveryAddress, null);
  const before = db.prepare("SELECT * FROM orders WHERE id=?").get(created.body.id);
  assertEncryptedRow(before);
  assert.deepEqual(readOrderPiiForOperation(before), {
    customerName: fixture.customer,
    customerPhone: fixture.phone,
    deliveryAddress: fixture.deliveryAddress,
    guestAddress: null,
  });

  const replay = await request(app).post("/api/orders")
    .set("Idempotency-Key", key).send(orderBody()).expect(200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  const after = db.prepare("SELECT * FROM orders WHERE id=?").get(created.body.id);
  assert.equal(after.pii_ciphertext, before.pii_ciphertext);
  assert.equal(after.pii_iv, before.pii_iv);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE id=?").get(created.body.id).count, 1);
});

test("checkout atomically creates an encrypted order and payment without payment PII", async () => {
  const response = await request(app).post("/api/orders/checkout")
    .set("Idempotency-Key", "pii-checkout-atomic-0001")
    .send(checkoutBody({ paymentMethod: "card" })).expect(201);
  const row = db.prepare("SELECT * FROM orders WHERE id=?").get(response.body.checkoutId);
  assertEncryptedRow(row);
  const payment = db.prepare("SELECT * FROM payments WHERE order_id=?").get(row.id);
  assert.ok(payment);
  assert.equal(payment.customer_name, null);
  assert.equal(payment.customer_phone, null);
  assert.match(response.body.paymentUrl, /^pay\.html\?/);

  const replay = await request(app).post("/api/orders/checkout")
    .set("Idempotency-Key", "pii-checkout-atomic-0001")
    .send(checkoutBody({ paymentMethod: "card" })).expect(200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.match(replay.body.paymentUrl, /^pay\.html\?/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payments WHERE order_id=?").get(row.id).count, 1);
  assert.equal(db.prepare("SELECT id FROM payments WHERE order_id=?").get(row.id).id, payment.id);
  const after = db.prepare("SELECT * FROM orders WHERE id=?").get(row.id);
  assert.equal(after.pii_ciphertext, row.pii_ciphertext);
  assert.equal(after.pii_iv, row.pii_iv);
});

test("checkout replay does not reissue a used payment link or consume verification again", async () => {
  const now = new Date().toISOString();
  const verificationId = "pii-replay-used-verification";
  db.prepare(`INSERT INTO phone_verifications
    (id,phone,code,code_hash,expires_at,verified_at,attempts,created_at)
    VALUES (?,?, 'hashed','hash',?,?,0,?)`)
    .run(verificationId, fixture.phone, new Date(Date.now() + 300000).toISOString(), now, now);
  const key = "pii-checkout-replay-used-0001";
  const body = checkoutBody({
    paymentMethod: "card",
    guestPassword: "guest-password-123",
    guestAddress: "guest replay address 2",
  });
  const created = await request(app).post("/api/orders/checkout")
    .set("Idempotency-Key", key).send(body).expect(201);
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(created.body.checkoutId);
  db.prepare("UPDATE payments SET link_token_used_at=? WHERE order_id=?").run(now, order.id);
  const payment = db.prepare("SELECT * FROM payments WHERE order_id=?").get(order.id);
  const consumedAt = db.prepare("SELECT consumed_at FROM phone_verifications WHERE id=?").get(verificationId).consumed_at;

  await assertBlockedCheckoutReplay({ key, body, order, payment });
  assert.equal(
    db.prepare("SELECT consumed_at FROM phone_verifications WHERE id=?").get(verificationId).consumed_at,
    consumedAt,
  );
});

test("checkout replay does not reissue a link after a payment session exists", async () => {
  const key = "pii-checkout-replay-session-0001";
  const state = await createReplayCheckout(key);
  db.prepare("UPDATE payments SET session_token_hash=? WHERE id=?")
    .run("session-token-hash-fixture", state.payment.id);
  state.payment = db.prepare("SELECT * FROM payments WHERE id=?").get(state.payment.id);
  await assertBlockedCheckoutReplay({ key, ...state });
});

for (const status of ["DONE", "CANCELED"]) {
  test(`checkout replay does not reissue a link for ${status} payments`, async () => {
    const key = `pii-checkout-replay-${status.toLowerCase()}-0001`;
    const state = await createReplayCheckout(key);
    db.prepare("UPDATE payments SET status=? WHERE id=?").run(status, state.payment.id);
    state.payment = db.prepare("SELECT * FROM payments WHERE id=?").get(state.payment.id);
    await assertBlockedCheckoutReplay({ key, ...state });
  });
}

test("checkout payment insertion failure rolls back every order-side row", async () => {
  const before = {
    orders: db.prepare("SELECT COUNT(*) count FROM orders").get().count,
    items: db.prepare("SELECT COUNT(*) count FROM order_items").get().count,
    history: db.prepare("SELECT COUNT(*) count FROM order_status_history").get().count,
    payments: db.prepare("SELECT COUNT(*) count FROM payments").get().count,
  };
  db.exec(`CREATE TEMP TRIGGER fail_checkout_payment
    BEFORE INSERT ON payments
    BEGIN SELECT RAISE(FAIL, 'forced payment insert failure'); END`);
  try {
    await request(app).post("/api/orders/checkout")
      .set("Idempotency-Key", "pii-checkout-rollback-0001")
      .send(checkoutBody({ paymentMethod: "card" })).expect(500);
  } finally {
    db.exec("DROP TRIGGER fail_checkout_payment");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders").get().count, before.orders);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_items").get().count, before.items);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_status_history").get().count, before.history);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM checkout_idempotency WHERE idempotency_key='pii-checkout-rollback-0001'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payments").get().count, before.payments);
});

test("invalid keyring fails safely before any order-side row is committed", async () => {
  const before = db.prepare("SELECT COUNT(*) count FROM orders").get().count;
  process.env.ORDER_PII_KEYS_JSON = JSON.stringify([
    { version: "v2", key: "not-a-valid-key" },
  ]);
  resetOrderPiiKeyringForTest();
  const response = await request(app).post("/api/orders")
    .set("Idempotency-Key", "pii-invalid-keyring-0001")
    .send(orderBody()).expect(500);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders").get().count, before);
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM order_idempotency WHERE idempotency_key='pii-invalid-keyring-0001'").get().count,
    0,
  );
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes("not-a-valid-key"), false);
  for (const value of Object.values(fixture)) assert.equal(serialized.includes(value), false);
});

test("guest verification consumption rolls back when checkout payment fails", async () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO phone_verifications
    (id,phone,code,code_hash,expires_at,verified_at,attempts,created_at)
    VALUES ('pii-write-verification',?,'hashed','hash',?,?,0,?)`)
    .run(fixture.phone, new Date(Date.now() + 300000).toISOString(), now, now);
  db.exec(`CREATE TEMP TRIGGER fail_guest_checkout_payment
    BEFORE INSERT ON payments
    BEGIN SELECT RAISE(FAIL, 'forced guest payment insert failure'); END`);
  try {
    await request(app).post("/api/orders/checkout")
      .set("Idempotency-Key", "pii-guest-rollback-0001")
      .send(checkoutBody({
        paymentMethod: "card",
        guestPassword: "guest-password-123",
        guestAddress: "경기도 비회원 안전로 2",
      })).expect(500);
  } finally {
    db.exec("DROP TRIGGER fail_guest_checkout_payment");
  }
  assert.equal(
    db.prepare("SELECT consumed_at FROM phone_verifications WHERE id='pii-write-verification'").get().consumed_at,
    null,
  );
});

test("admin creation shares validation and encrypted storage while flag OFF remains legacy", async () => {
  const token = adminToken();
  const invalid = await request(app).post("/api/orders/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({ product: "관리자 상품", customer: "", phone: "" }).expect(400);
  assert.match(invalid.body.error, /이름/);

  const created = await request(app).post("/api/orders/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({
      product: "관리자 상품",
      quantity: 1,
      unitPrice: 1000,
      pickupDate: futureDate(),
      pickupTime: "15:00",
      fulfillmentType: "delivery",
      ...fixture,
    }).expect(201);
  assertEncryptedRow(db.prepare("SELECT * FROM orders WHERE id=?").get(created.body.id));
  assert.match(created.body.customer, /\*/);

  process.env.ORDER_PII_PROTECTION_ENABLED = "false";
  resetOrderPiiKeyringForTest();
  const legacy = await request(app).post("/api/orders/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({
      product: "Legacy 관리자 상품",
      quantity: 1,
      unitPrice: 1000,
      pickupDate: futureDate(),
      pickupTime: "16:00",
      fulfillmentType: "delivery",
      ...fixture,
    }).expect(201);
  const legacyRow = db.prepare("SELECT * FROM orders WHERE id=?").get(legacy.body.id);
  assert.equal(legacyRow.customer_name, fixture.customer);
  assert.equal(legacyRow.customer_phone, fixture.phone);
  assert.equal(legacyRow.pii_ciphertext, null);
  assert.equal(legacy.body.customer, fixture.customer);
});

test("admin payment creation and reissue clear payment PII", async () => {
  const token = adminToken("pii-payment-admin", "super_admin");
  const order = await request(app).post("/api/orders/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({
      product: "결제 상품",
      quantity: 1,
      unitPrice: 2000,
      pickupDate: futureDate(),
      pickupTime: "16:00",
      fulfillmentType: "delivery",
      ...fixture,
    }).expect(201);
  await request(app).post("/api/payments")
    .set("Authorization", `Bearer ${token}`).send({ orderId: order.body.id }).expect(201);
  let payment = db.prepare("SELECT * FROM payments WHERE order_id=?").get(order.body.id);
  assert.equal(payment.customer_name, null);
  assert.equal(payment.customer_phone, null);
  db.prepare("UPDATE payments SET customer_name='legacy name', customer_phone='01000000000' WHERE id=?")
    .run(payment.id);
  await request(app).post("/api/payments")
    .set("Authorization", `Bearer ${token}`).send({ orderId: order.body.id }).expect(200);
  payment = db.prepare("SELECT * FROM payments WHERE id=?").get(payment.id);
  assert.equal(payment.customer_name, null);
  assert.equal(payment.customer_phone, null);
});

test("admin creation UI posts directly and never places plaintext order data in writeOrders", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../js/admin/dashboard.js"), "utf8");
  const start = source.indexOf('adminOrderCreateForm?.addEventListener("submit"');
  const section = source.slice(start, source.indexOf("\n});", start) + 4);
  assert.match(section, /apiFetch\([\s\S]*"\/orders\/admin"/);
  assert.match(section, /await loadFromApi\(\)/);
  assert.match(section, /finally\s*\{/);
  assert.doesNotMatch(section, /writeOrders\(/);
  assert.doesNotMatch(section, /localStorage|sessionStorage|pendingSync/);
  assert.doesNotMatch(section, /addActivityLog\([^)]*(customer|phone|deliveryAddress)/);
});

test("order creation logging emits only safe codes", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/orders.js"), "utf8");
  assert.doesNotMatch(source, /console\.error\(\s*"\[orders(?:\.checkout)?\][^"]*"\s*,\s*error/);
  assert.match(source, /ORDER_CREATE_FAILED/);
  assert.match(source, /CHECKOUT_CREATE_FAILED/);
});
