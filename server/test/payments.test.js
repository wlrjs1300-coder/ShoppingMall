process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "payment-admin-code";
process.env.JWT_SECRET = "payment-test-jwt-secret";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";
process.env.TOSS_MOCK_MODE = "true";
process.env.TOSS_CLIENT_KEY = "test_ck_mock";
process.env.TOSS_SECRET_KEY = "test_sk_mock";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../index");
const db = require("../db");

async function adminToken() {
  const response = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE });
  return response.body.token;
}

async function createOrder() {
  const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const response = await request(app).post("/api/orders/checkout").set("Idempotency-Key", `payment-test-${Date.now()}-${Math.random()}`).send({
    items: [{ productId: "injeolmi", quantity: 2 }, { productId: "yaksik", quantity: 1 }],
    customer: "홍길동", phone: "010-1234-5678", pickupDate: date, pickupTime: "14:00", fulfillmentType: "pickup",
  });
  assert.equal(response.status, 201);
  return response.body.order;
}

test("서버 주문 금액, 일회성 링크, 개인정보 마스킹, 중복 승인을 보장한다", async () => {
  const order = await createOrder();
  const token = await adminToken();
  const created = await request(app).post("/api/payments").set("Authorization", `Bearer ${token}`).send({ orderId: order.id, amount: 1 });
  assert.equal(created.status, 201);
  assert.equal(created.body.amount, order.totalAmount);
  assert.ok(created.body.linkToken);
  const stored = db.prepare("SELECT * FROM payments WHERE order_id=?").get(order.id);
  assert.notEqual(stored.link_token_hash, created.body.linkToken);

  assert.equal((await request(app).get(`/api/payments/info/${order.id}`)).status, 401);
  const info = await request(app).get(`/api/payments/info/${order.id}`).query({ token: created.body.linkToken });
  assert.equal(info.status, 200);
  assert.equal(info.body.customerName, "홍*동");
  assert.equal(info.body.customerPhone, undefined);
  assert.ok(info.body.sessionToken);
  assert.equal((await request(app).get(`/api/payments/info/${order.id}`).query({ token: created.body.linkToken })).status, 410);

  const wrong = await request(app).post("/api/payments/confirm").set("X-Payment-Session", info.body.sessionToken)
    .send({ paymentKey: "payment-key-001", orderId: order.id, amount: 1 });
  assert.equal(wrong.status, 400);

  const confirmed = await request(app).post("/api/payments/confirm").set("X-Payment-Session", info.body.sessionToken)
    .send({ paymentKey: "payment-key-001", orderId: order.id, amount: order.totalAmount });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.ok, true);
  assert.deepEqual(confirmed.body.productIds.sort(), ["injeolmi", "yaksik"]);
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(order.id).status, "DONE");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(order.id).status, "접수대기");
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "결제완료");
  assert.equal(db.prepare("SELECT workflow_status FROM orders WHERE id=?").get(order.id).workflow_status, "접수대기");

  for (const workflowStatus of ["접수완료", "픽업준비완료", "픽업완료"]) {
    const moved = await request(app).put(`/api/orders/${order.id}`).set("Authorization", `Bearer ${token}`).send({ workflowStatus });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.workflowStatus, workflowStatus);
  }

  const replay = await request(app).post("/api/payments/confirm").set("X-Payment-Session", info.body.sessionToken)
    .send({ paymentKey: "payment-key-001", orderId: order.id, amount: order.totalAmount });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.alreadyPaid, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM order_status_history WHERE order_id=? AND next_status='결제완료'").get(order.id).count, 0);

  const webhook = await request(app).post("/api/payments/webhook").send({ eventType: "PAYMENT_STATUS_CHANGED", data: { paymentKey: "payment-key-001" } });
  assert.equal(webhook.status, 200);
});

test("결제 실패 후 재시도할 수 있고 관리자가 실제 결제를 취소한다", async () => {
  const order = await createOrder();
  const token = await adminToken();
  const created = await request(app).post("/api/payments").set("Authorization", `Bearer ${token}`).send({ orderId: order.id });
  const info = await request(app).get(`/api/payments/info/${order.id}`).query({ token: created.body.linkToken });

  const failed = await request(app).post("/api/payments/confirm").set("X-Payment-Session", info.body.sessionToken)
    .send({ paymentKey: "fail-payment-key", orderId: order.id, amount: order.totalAmount });
  assert.equal(failed.status, 400);
  assert.equal(failed.body.retryable, true);
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(order.id).status, "FAILED");

  const retried = await request(app).post("/api/payments/confirm").set("X-Payment-Session", info.body.sessionToken)
    .send({ paymentKey: "payment-key-002", orderId: order.id, amount: order.totalAmount });
  assert.equal(retried.status, 200);
  assert.equal(db.prepare("SELECT retry_count FROM payments WHERE order_id=?").get(order.id).retry_count, 1);

  const partial = await request(app).post(`/api/payments/${order.id}/cancel`).set("Authorization", `Bearer ${token}`)
    .send({ cancelReason: "일부 상품 취소", cancelAmount: 1000 });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.remainingAmount, order.totalAmount - 1000);
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(order.id).status, "PARTIAL_CANCELED");
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "부분환불");

  const canceled = await request(app).post(`/api/payments/${order.id}/cancel`).set("Authorization", `Bearer ${token}`)
    .send({ cancelReason: "자동 테스트 취소" });
  assert.equal(canceled.status, 200);
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(order.id).status, "CANCELED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(order.id).status, "접수대기");
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "결제취소");
  const replay = await request(app).post(`/api/payments/${order.id}/cancel`).set("Authorization", `Bearer ${token}`).send({});
  assert.equal(replay.body.alreadyCanceled, true);
});
