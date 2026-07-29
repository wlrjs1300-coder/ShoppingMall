process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "payment-summary-admin-code";
process.env.JWT_SECRET = "payment-summary-test-secret";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../index");
const db = require("../db");

async function adminToken() {
  const response = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE });
  return response.body.token;
}

function insertOrder(id, createdAt) {
  db.prepare(`INSERT INTO orders
    (id, customer_name, customer_phone, fulfillment_type, subtotal, delivery_fee, total_amount, cost,
     status, payment_status, amount_status, workflow_status, created_at, updated_at)
    VALUES (?, '관리자 테스트', '01012345678', 'pickup', 10000, 0, 10000, 0,
      '접수대기', '결제대기', 'confirmed', '결제대기', ?, ?)`)
    .run(id, createdAt, createdAt);
  db.prepare(`INSERT INTO order_items
    (id, order_id, product_id, product_name, unit_price, quantity, quantity_unit, line_total)
    VALUES (?, ?, NULL, '테스트 상품', 10000, 1, 'pack', 10000)`)
    .run(`item-${id}`, id);
}

function insertPayment(orderId, status, lastError, requestedAt, overrides = {}) {
  db.prepare(`INSERT INTO payments
    (id, order_id, amount, status, requested_at, paid_at, canceled_at, last_error, payment_key,
     confirm_idempotency_key, cancel_idempotency_key, link_token_hash, session_token_hash, toss_secret)
    VALUES (?, ?, 10000, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `payment-${orderId}`, orderId, status, requestedAt, overrides.paidAt || null,
      overrides.canceledAt || null, lastError, `secret-payment-key-${orderId}`,
      `confirm-key-${orderId}`, `cancel-key-${orderId}`, `link-hash-${orderId}`,
      `session-hash-${orderId}`, `toss-secret-${orderId}`
    );
}

test("관리자 주문 목록은 결제 요약을 한 주문당 한 건으로 반환하고 비밀 필드를 제외한다", async () => {
  const base = "2026-07-29T01:00:00.000Z";
  const cases = ["RECONCILE_REQUIRED", "DONE", "CANCELED", "PARTIAL_CANCELED"];
  cases.forEach((status, index) => {
    const id = `summary-${status.toLowerCase()}`;
    insertOrder(id, new Date(Date.parse(base) + index * 1000).toISOString());
    insertPayment(id, status, status === "RECONCILE_REQUIRED" ? "PROVIDER_TIMEOUT" : null, base, {
      paidAt: status === "DONE" ? "2026-07-29T02:00:00.000Z" : null,
      canceledAt: ["CANCELED", "PARTIAL_CANCELED"].includes(status) ? "2026-07-29T03:00:00.000Z" : null,
    });
  });
  insertOrder("summary-none", "2026-07-29T00:00:00.000Z");

  const response = await request(app).get("/api/orders")
    .set("Authorization", `Bearer ${await adminToken()}`);
  assert.equal(response.status, 200);
  for (const status of cases) {
    const matches = response.body.filter((order) => order.id === `summary-${status.toLowerCase()}`);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].paymentInternalStatus, status);
  }
  const reconcile = response.body.find((order) => order.id === "summary-reconcile_required");
  assert.equal(reconcile.paymentLastError, "PROVIDER_TIMEOUT");
  assert.equal(reconcile.paymentUpdatedAt, base);
  const none = response.body.find((order) => order.id === "summary-none");
  assert.equal(none.paymentInternalStatus, "NONE");
  assert.equal(none.paymentLastError, null);
  assert.equal(none.paymentUpdatedAt, null);

  const serialized = JSON.stringify(response.body);
  for (const secret of [
    "paymentKey", "payment_key", "confirm_idempotency_key", "cancel_idempotency_key",
    "link_token_hash", "session_token_hash", "toss-secret-", "secret-payment-key-",
  ]) assert.doesNotMatch(serialized, new RegExp(secret));
  const orderedIds = response.body.filter((order) => order.id.startsWith("summary-")).map((order) => order.id);
  assert.equal(orderedIds[0], "summary-partial_canceled");
});

test("고객 응답과 비관리자 접근은 내부 결제 요약을 노출하지 않는다", async () => {
  insertOrder("customer-summary-hidden", "2026-07-30T01:00:00.000Z");
  insertPayment("customer-summary-hidden", "RECONCILE_REQUIRED", "PROVIDER_TIMEOUT", "2026-07-30T01:00:00.000Z");
  db.prepare("UPDATE orders SET guest_password_hash=? WHERE id=?")
    .run(bcrypt.hashSync("guest-password", 4), "customer-summary-hidden");

  const guest = await request(app).post("/api/orders/guest/lookup")
    .send({ orderId: "customer-summary-hidden", phone: "01012345678", password: "guest-password" });
  assert.equal(guest.status, 200);
  assert.doesNotMatch(JSON.stringify(guest.body), /paymentInternalStatus|paymentLastError|paymentUpdatedAt|PROVIDER_TIMEOUT/);

  assert.equal((await request(app).get("/api/orders")).status, 401);
  const customerToken = jwt.sign({ sub: "customer", role: "customer" }, process.env.JWT_SECRET);
  const customer = await request(app).get("/api/orders").set("Authorization", `Bearer ${customerToken}`);
  assert.equal(customer.status, 403);
  assert.doesNotMatch(JSON.stringify(customer.body), /paymentInternalStatus|paymentLastError|paymentUpdatedAt/);
});

test("관리자 주문 라우트는 필요한 payment 컬럼만 LEFT JOIN하고 주문별 payment 조회를 반복하지 않는다", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "orders.js"), "utf8");
  const route = source.slice(source.indexOf('router.get("/", requireAuth'), source.indexOf('router.get("/:id/history"'));
  assert.match(route, /LEFT JOIN payments p ON p\.order_id = o\.id/);
  assert.match(route, /p\.status AS payment_internal_status/);
  assert.doesNotMatch(route, /SELECT\s+p\.\*|SELECT\s+payments\.\*/i);
  assert.equal((route.match(/JOIN payments/g) || []).length, 1);
});
