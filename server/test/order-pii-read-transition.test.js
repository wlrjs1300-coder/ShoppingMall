process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.ADMIN_CODE = "pii-read-admin";
process.env.JWT_SECRET = "pii-read-test-secret";
process.env.NOTIFICATION_MODE = "none";
process.env.TOSS_MOCK_MODE = "true";
process.env.TOSS_CLIENT_KEY = "test_ck_pii_read";
process.env.TOSS_SECRET_KEY = "test_sk_pii_read";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const keyV1 = Buffer.alloc(32, 31).toString("base64");
const keyV2 = Buffer.alloc(32, 32).toString("base64");
process.env.ORDER_PII_PROTECTION_ENABLED = "true";
process.env.ORDER_PII_KEYS_JSON = JSON.stringify([
  { version: "v1", key: keyV1 },
  { version: "v2", key: keyV2 },
]);
process.env.ORDER_PII_ACTIVE_KEY_VERSION = "v2";

const app = require("../index");
const db = require("../db");
const { COOKIE_NAME, issueCustomerToken } = require("../middleware/customerAuth");
const { parsePiiKeyring, resetOrderPiiKeyringForTest } = require("../lib/pii-keyring");
const {
  OrderPiiError,
  buildOrderPiiColumns,
  readOrderPiiForOperation,
} = require("../services/order-pii-service");
const { notifyPickupReminders } = require("../services/notify");

const keyring = parsePiiKeyring(process.env.ORDER_PII_KEYS_JSON, "v2");
const rawPii = {
  customerName: "Fixture Customer",
  customerPhone: "01012345678",
  deliveryAddress: "Fixture delivery address 42",
  guestAddress: "Fixture guest address 7",
};

async function adminToken() {
  const response = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE });
  assert.equal(response.status, 200);
  return response.body.token;
}

function insertUser(id) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user_accounts
    (id, username, email, password_hash, name, phone, status, terms_agreed_at,
     privacy_agreed_at, marketing_consent, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Fixture member', '01000000000', 'active', ?, ?, 0, ?, ?)`)
    .run(id, id, `${id}@example.test`, bcrypt.hashSync("member-password", 4), now, now, now, now);
}

function insertEncryptedOrder(id, options = {}) {
  const now = new Date().toISOString();
  const encrypted = buildOrderPiiColumns(rawPii, keyring, now);
  db.prepare(`INSERT INTO orders (
    id, user_id, customer_name, customer_phone, fulfillment_type, delivery_address,
    pickup_date, pickup_time, subtotal, delivery_fee, total_amount, cost, status,
    payment_status, amount_status, guest_password_hash, guest_address, created_at, updated_at,
    pii_ciphertext, pii_iv, pii_auth_tag, pii_key_version, customer_name_masked,
    customer_phone_masked, delivery_region_masked, pii_migrated_at
  ) VALUES (?, ?, '[protected]', '[protected]', 'delivery', NULL, '2099-12-31', '14:00',
    3500, 0, 3500, 0, '접수대기', '결제대기', 'confirmed', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      options.userId || null,
      options.guestPassword ? bcrypt.hashSync(options.guestPassword, 4) : null,
      now,
      now,
      encrypted.piiCiphertext,
      encrypted.piiIv,
      encrypted.piiAuthTag,
      encrypted.piiKeyVersion,
      encrypted.customerNameMasked,
      encrypted.customerPhoneMasked,
      encrypted.deliveryRegionMasked,
      encrypted.piiMigratedAt,
    );
  db.prepare(`INSERT INTO order_items
    (id, order_id, product_id, product_name, unit_price, quantity, line_total)
    VALUES (?, ?, 'injeolmi', 'Fixture product', 3500, 1, 3500)`)
    .run(`item-${id}`, id);
  return encrypted;
}

function insertLegacyOrder(id, options = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO orders (
    id, user_id, customer_name, customer_phone, fulfillment_type, delivery_address,
    pickup_date, pickup_time, subtotal, delivery_fee, total_amount, cost, status,
    payment_status, amount_status, guest_password_hash, guest_address, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'delivery', ?, '2099-12-31', '14:00', 3500, 0, 3500, 0,
    '접수대기', '결제대기', 'confirmed', ?, ?, ?, ?)`)
    .run(
      id,
      options.userId || null,
      rawPii.customerName,
      rawPii.customerPhone,
      rawPii.deliveryAddress,
      options.guestPassword ? bcrypt.hashSync(options.guestPassword, 4) : null,
      rawPii.guestAddress,
      now,
      now,
    );
  db.prepare(`INSERT INTO order_items
    (id, order_id, product_id, product_name, unit_price, quantity, line_total)
    VALUES (?, ?, 'injeolmi', 'Fixture product', 3500, 1, 3500)`)
    .run(`item-${id}`, id);
}

function setProtectionEnabled(enabled) {
  process.env.ORDER_PII_PROTECTION_ENABLED = enabled ? "true" : "false";
  resetOrderPiiKeyringForTest();
}

function serialized(value) {
  return JSON.stringify(value);
}

function assertMaskedAndSafe(body) {
  const text = serialized(body);
  assert.equal(text.includes(rawPii.customerName), false);
  assert.equal(text.includes(rawPii.customerPhone), false);
  assert.equal(text.includes(rawPii.deliveryAddress), false);
  assert.equal(text.includes(rawPii.guestAddress), false);
  for (const field of ["pii_ciphertext", "pii_iv", "pii_auth_tag", "pii_key_version"]) {
    assert.equal(text.includes(field), false);
  }
}

test("flag OFF preserves legacy admin and member response contracts", async () => {
  setProtectionEnabled(false);
  const memberId = "pii-read-off-member";
  const orderId = "pii-read-off-legacy";
  insertUser(memberId);
  insertLegacyOrder(orderId, { userId: memberId });

  const token = await adminToken();
  const adminList = await request(app).get("/api/orders")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(adminList.status, 200);
  const adminOrder = adminList.body.find((order) => order.id === orderId);
  assert.equal(adminOrder.customer, rawPii.customerName);
  assert.equal(adminOrder.phone, rawPii.customerPhone);
  assert.equal(adminOrder.deliveryAddress, rawPii.deliveryAddress);
  assert.equal(adminOrder.customerNameMasked, undefined);

  const cookie = `${COOKIE_NAME}=${issueCustomerToken(memberId)}`;
  const detail = await request(app).get(`/api/users/me/orders/${orderId}`).set("Cookie", cookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.order.customer, rawPii.customerName);
  assert.equal(detail.body.order.phone, rawPii.customerPhone);
  assert.equal(detail.body.order.deliveryAddress, rawPii.deliveryAddress);
});

test("flag OFF and ON preserve or mask ordinary order and checkout responses", async () => {
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const orderPayload = {
    productId: "injeolmi",
    quantity: 1,
    customer: rawPii.customerName,
    phone: "010-1234-5678",
    pickupDate: future,
    pickupTime: "14:00",
    fulfillmentType: "delivery",
    deliveryAddress: rawPii.deliveryAddress,
  };
  const checkoutPayload = {
    items: [{ productId: "injeolmi", quantity: 1 }],
    customer: rawPii.customerName,
    phone: "010-1234-5678",
    pickupDate: future,
    pickupTime: "14:00",
    fulfillmentType: "delivery",
    deliveryAddress: rawPii.deliveryAddress,
  };

  setProtectionEnabled(false);
  const offOrder = await request(app).post("/api/orders")
    .set("Idempotency-Key", "pii-read-off-order-create")
    .send(orderPayload);
  assert.equal(offOrder.status, 201);
  assert.equal(offOrder.body.customer, rawPii.customerName);
  assert.equal(offOrder.body.phone, rawPii.customerPhone);
  assert.equal(offOrder.body.deliveryAddress, rawPii.deliveryAddress);

  const offCheckout = await request(app).post("/api/orders/checkout")
    .set("Idempotency-Key", "pii-read-off-checkout-create")
    .send(checkoutPayload);
  assert.equal(offCheckout.status, 201);
  assert.equal(offCheckout.body.order.customer, rawPii.customerName);
  assert.equal(offCheckout.body.order.deliveryAddress, rawPii.deliveryAddress);

  setProtectionEnabled(true);
  const onOrder = await request(app).post("/api/orders")
    .set("Idempotency-Key", "pii-read-on-order-create")
    .send(orderPayload);
  assert.equal(onOrder.status, 201);
  assert.ok(onOrder.body.customer.includes("*"));
  assert.equal(onOrder.body.deliveryAddress, null);
  assertMaskedAndSafe(onOrder.body);

  const onCheckout = await request(app).post("/api/orders/checkout")
    .set("Idempotency-Key", "pii-read-on-checkout-create")
    .send(checkoutPayload);
  assert.equal(onCheckout.status, 201);
  assert.ok(onCheckout.body.order.customer.includes("*"));
  assert.equal(onCheckout.body.order.deliveryAddress, null);
  assertMaskedAndSafe(onCheckout.body);
});

test("encrypted orders are masked in admin and member APIs without exposing crypto fields", async () => {
  setProtectionEnabled(true);
  const memberId = "pii-read-member";
  const orderId = "pii-read-member-order";
  insertUser(memberId);
  insertEncryptedOrder(orderId, { userId: memberId });

  const token = await adminToken();
  const adminList = await request(app).get("/api/orders")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(adminList.status, 200);
  const adminOrder = adminList.body.find((order) => order.id === orderId);
  assert.ok(adminOrder);
  assert.equal(adminOrder.deliveryAddress, null);
  assert.ok(adminOrder.customerNameMasked.includes("*"));
  assert.ok(adminOrder.customerPhoneMasked.includes("*"));
  assertMaskedAndSafe(adminOrder);
  const legacyOrder = adminList.body.find((order) => order.id === "pii-read-off-legacy");
  assert.ok(legacyOrder.customer.includes("*"));
  assert.equal(legacyOrder.deliveryAddress, null);
  assertMaskedAndSafe(legacyOrder);

  const cookie = `${COOKIE_NAME}=${issueCustomerToken(memberId)}`;
  const memberList = await request(app).get("/api/users/me/orders").set("Cookie", cookie);
  assert.equal(memberList.status, 200);
  const memberOrder = memberList.body.orders.find((order) => order.id === orderId);
  assert.ok(memberOrder);
  assertMaskedAndSafe(memberOrder);

  const detail = await request(app).get(`/api/users/me/orders/${orderId}`).set("Cookie", cookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.order.deliveryAddress, null);
  assertMaskedAndSafe(detail.body);
});

test("flag OFF never falls back for an encrypted row without an enabled keyring", async () => {
  setProtectionEnabled(false);
  const token = await adminToken();
  const response = await request(app).get("/api/orders")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(response.status, 503);
  assert.equal(response.body.reason, "ORDER_PII_ACCESS_FAILED");
  assertMaskedAndSafe(response.body);
  setProtectionEnabled(true);
});

test("guest lookup verifies decrypted phone after ID lookup and returns only masked PII", async () => {
  const orderId = "pii-read-guest-order";
  const password = "fixture-guest-password";
  insertEncryptedOrder(orderId, { guestPassword: password });

  const success = await request(app).post("/api/orders/guest/lookup")
    .send({ orderId, phone: "010-1234-5678", password });
  assert.equal(success.status, 200);
  assert.equal(success.body.id, orderId);
  assert.equal(success.body.deliveryAddress, null);
  assertMaskedAndSafe(success.body);

  const badPhone = await request(app).post("/api/orders/guest/lookup")
    .send({ orderId, phone: "010-9999-9999", password });
  const badPassword = await request(app).post("/api/orders/guest/lookup")
    .send({ orderId, phone: "010-1234-5678", password: "wrong-password" });
  assert.equal(badPhone.status, 401);
  assert.equal(badPassword.status, 401);
  assert.deepEqual(badPhone.body, badPassword.body);

  const source = fs.readFileSync(path.join(__dirname, "../routes/orders.js"), "utf8");
  const guestRoute = source.slice(source.indexOf('router.post("/guest/lookup"'), source.indexOf('router.post("/admin"'));
  assert.equal(/customer_phone\s*=\s*\?/i.test(guestRoute), false);
});

test("guest lookup keeps the legacy response contract only while protection is disabled", async () => {
  const orderId = "pii-read-guest-legacy";
  const password = "fixture-legacy-password";
  insertLegacyOrder(orderId, { guestPassword: password });
  setProtectionEnabled(false);
  const response = await request(app).post("/api/orders/guest/lookup")
    .send({ orderId, phone: "010-1234-5678", password });
  assert.equal(response.status, 200);
  assert.equal(response.body.customer, rawPii.customerName);
  assert.equal(response.body.phone, rawPii.customerPhone);
  assert.equal(response.body.deliveryAddress, rawPii.deliveryAddress);
  setProtectionEnabled(true);
});

test("admin updates preserve masked PII, allow non-PII changes and reject explicit protected PII writes", async () => {
  setProtectionEnabled(true);
  const orderId = "pii-read-admin-update";
  const encrypted = insertEncryptedOrder(orderId);
  const token = await adminToken();

  const updated = await request(app).put(`/api/orders/${orderId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      customer: "F****** C*******",
      phone: "010-****-5678",
      deliveryAddress: null,
      workflowStatus: "접수완료",
      memo: "safe status-side update",
    });
  assert.equal(updated.status, 200);
  const stored = db.prepare(`SELECT customer_name, customer_phone, delivery_address,
    pii_ciphertext, pii_iv, pii_auth_tag, pii_key_version, memo FROM orders WHERE id=?`)
    .get(orderId);
  assert.equal(stored.customer_name, "[protected]");
  assert.equal(stored.customer_phone, "[protected]");
  assert.equal(stored.delivery_address, null);
  assert.equal(stored.pii_ciphertext, encrypted.piiCiphertext);
  assert.equal(stored.pii_iv, encrypted.piiIv);
  assert.equal(stored.pii_auth_tag, encrypted.piiAuthTag);
  assert.equal(stored.pii_key_version, encrypted.piiKeyVersion);
  assert.equal(stored.memo, "safe status-side update");
  assert.equal(db.prepare("SELECT workflow_status FROM orders WHERE id=?").get(orderId).workflow_status, "접수완료");

  const rejected = await request(app).put(`/api/orders/${orderId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ customer: "Replacement Fixture" });
  assert.equal(rejected.status, 400);
  assert.equal(
    db.prepare("SELECT pii_ciphertext FROM orders WHERE id=?").get(orderId).pii_ciphertext,
    encrypted.piiCiphertext,
  );
});

test("bad encrypted tuples fail closed without consuming a payment link or leaking details", async () => {
  const orderId = "pii-read-bad-tag-order";
  insertEncryptedOrder(orderId);
  db.prepare("UPDATE orders SET pii_auth_tag=? WHERE id=?")
    .run(Buffer.alloc(16, 99).toString("base64"), orderId);

  const token = await adminToken();
  const createPayment = await request(app).post("/api/payments")
    .set("Authorization", `Bearer ${token}`)
    .send({ orderId });
  assert.equal(createPayment.status, 503);
  assert.equal(createPayment.body.reason, "ORDER_PII_ACCESS_FAILED");
  assertMaskedAndSafe(createPayment.body);

  const linkToken = "fixture-payment-link-token";
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO payments
    (id, order_id, amount, order_name, customer_name, customer_phone, status,
     requested_at, link_token_hash, link_token_expires_at)
    VALUES (?, ?, 3500, 'Fixture order', 'legacy fallback forbidden', '01000000000',
      'READY', ?, ?, ?)`)
    .run(
      `payment-${orderId}`,
      orderId,
      now,
      crypto.createHash("sha256").update(linkToken).digest("hex"),
      new Date(Date.now() + 60000).toISOString(),
    );
  const info = await request(app).get(`/api/payments/info/${orderId}`).query({ token: linkToken });
  assert.equal(info.status, 503);
  assert.equal(info.body.reason, "ORDER_PII_ACCESS_FAILED");
  assertMaskedAndSafe(info.body);
  const payment = db.prepare("SELECT link_token_used_at, session_token_hash FROM payments WHERE order_id=?")
    .get(orderId);
  assert.equal(payment.link_token_used_at, null);
  assert.equal(payment.session_token_hash, null);
});

test("legacy rows remain readable while encrypted rows require a configured keyring", () => {
  const legacy = {
    customer_name: "Legacy Fixture",
    customer_phone: "010-1111-2222",
    delivery_address: null,
    guest_address: null,
    pii_ciphertext: null,
    pii_iv: null,
    pii_auth_tag: null,
    pii_key_version: null,
  };
  const encrypted = buildOrderPiiColumns(rawPii, keyring);
  const encryptedRow = {
    pii_ciphertext: encrypted.piiCiphertext,
    pii_iv: encrypted.piiIv,
    pii_auth_tag: encrypted.piiAuthTag,
    pii_key_version: encrypted.piiKeyVersion,
  };

  const previousEnabled = process.env.ORDER_PII_PROTECTION_ENABLED;
  delete process.env.ORDER_PII_PROTECTION_ENABLED;
  resetOrderPiiKeyringForTest();
  assert.equal(readOrderPiiForOperation(legacy).customerName, "Legacy Fixture");
  assert.throws(
    () => readOrderPiiForOperation(encryptedRow),
    (error) => error instanceof OrderPiiError && error.code === "ORDER_PII_NOT_CONFIGURED",
  );
  process.env.ORDER_PII_PROTECTION_ENABLED = previousEnabled;
  resetOrderPiiKeyringForTest();
});

test("partial tuples, unknown versions and bad tags never fall back to plaintext", () => {
  assert.throws(
    () => readOrderPiiForOperation({
      customer_name: "must not be used",
      customer_phone: "01012345678",
      pii_ciphertext: "partial",
      pii_iv: null,
      pii_auth_tag: null,
      pii_key_version: null,
    }, keyring),
    (error) => error instanceof OrderPiiError && error.code === "ORDER_PII_ENCRYPTED_DATA_INVALID",
  );

  const encrypted = buildOrderPiiColumns(rawPii, keyring);
  const row = {
    customer_name: "must not be used",
    customer_phone: "01012345678",
    pii_ciphertext: encrypted.piiCiphertext,
    pii_iv: encrypted.piiIv,
    pii_auth_tag: encrypted.piiAuthTag,
    pii_key_version: "unknown",
  };
  assert.throws(
    () => readOrderPiiForOperation(row, keyring),
    (error) => error instanceof OrderPiiError && error.code === "ORDER_PII_DECRYPTION_FAILED",
  );
  row.pii_key_version = encrypted.piiKeyVersion;
  row.pii_auth_tag = Buffer.alloc(16, 77).toString("base64");
  assert.throws(
    () => readOrderPiiForOperation(row, keyring),
    (error) => error instanceof OrderPiiError && error.code === "ORDER_PII_DECRYPTION_FAILED",
  );
});

test("encrypted payment-link reads use the order adapter and return a masked name", async () => {
  const orderId = "pii-read-payment-order";
  insertEncryptedOrder(orderId);
  const token = await adminToken();
  const created = await request(app).post("/api/payments")
    .set("Authorization", `Bearer ${token}`)
    .send({ orderId });
  assert.equal(created.status, 201);
  const info = await request(app).get(`/api/payments/info/${orderId}`)
    .query({ token: created.body.linkToken });
  assert.equal(info.status, 200);
  assert.ok(info.body.customerName.includes("*"));
  assert.equal(info.body.customerPhone, undefined);
  assertMaskedAndSafe(info.body);
});

test("reminders read encrypted and legacy PII, and log only safe identifiers on decryption failure", async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const pickupDate = tomorrow.toISOString().slice(0, 10);
  const encryptedId = "pii-read-reminder-encrypted";
  const legacyId = "pii-read-reminder-legacy";
  const unknownId = "pii-read-reminder-unknown";
  const badTagId = "pii-read-reminder-bad-tag";
  insertEncryptedOrder(encryptedId);
  insertEncryptedOrder(legacyId);
  insertEncryptedOrder(unknownId);
  insertEncryptedOrder(badTagId);
  db.prepare(`UPDATE orders SET customer_name='Legacy reminder', customer_phone='01011112222',
    pii_ciphertext=NULL, pii_iv=NULL, pii_auth_tag=NULL, pii_key_version=NULL,
    customer_name_masked=NULL, customer_phone_masked=NULL, pii_migrated_at=NULL
    WHERE id=?`).run(legacyId);
  db.prepare("UPDATE orders SET pickup_date=? WHERE id IN (?, ?, ?, ?)")
    .run(pickupDate, encryptedId, legacyId, unknownId, badTagId);
  db.prepare("UPDATE orders SET pii_key_version='unknown' WHERE id=?").run(unknownId);
  db.prepare("UPDATE orders SET pii_auth_tag=? WHERE id=?")
    .run(Buffer.alloc(16, 55).toString("base64"), badTagId);

  const warnings = [];
  const calls = [];
  const logger = {
    warn: (message) => warnings.push(String(message)),
    log: () => {},
  };
  const notifyFn = async (phone, text, templateId, variables) => {
    calls.push({ phone, text, templateId, variables });
    return { ok: true };
  };
  assert.equal(await notifyPickupReminders(db, { notifyFn, logger }), 2);
  assert.deepEqual(calls.map((call) => call.phone).sort(), ["01011112222", rawPii.customerPhone].sort());
  assert.ok(calls.some((call) => call.variables.customer === rawPii.customerName));
  assert.ok(calls.some((call) => call.variables.customer === "Legacy reminder"));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((warning) => warning.includes(unknownId)));
  assert.ok(warnings.some((warning) => warning.includes(badTagId)));
  assert.ok(warnings.every((warning) => warning.includes("ORDER_PII_DECRYPTION_FAILED")));
  const logs = serialized(warnings);
  assert.equal(logs.includes(rawPii.customerName), false);
  assert.equal(logs.includes(rawPii.customerPhone), false);
  assert.equal(logs.includes(rawPii.deliveryAddress), false);
});
