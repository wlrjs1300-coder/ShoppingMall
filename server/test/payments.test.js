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
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const toss = require("../services/toss-payments");

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

async function createReconciliationCase(status = "CONFIRMING", providerOverrides = {}) {
  const order = await createOrder();
  const token = await adminToken();
  await request(app).post("/api/payments").set("Authorization", `Bearer ${token}`).send({ orderId: order.id }).expect(201);
  const paymentKey = `reconcile-key-${Date.now()}-${Math.random()}`;
  db.prepare("UPDATE payments SET status=?, payment_key=? WHERE order_id=?").run(status, paymentKey, order.id);
  toss.mockPayments.set(paymentKey, {
    paymentKey,
    orderId: order.id,
    totalAmount: order.totalAmount,
    status: "DONE",
    method: "카드",
    approvedAt: new Date().toISOString(),
    secret: `provider-secret-${order.id}`,
    ...providerOverrides,
  });
  return { order, token, paymentKey };
}

async function reconcile(orderId, token) {
  return request(app).post(`/api/payments/${orderId}/reconcile`).set("Authorization", `Bearer ${token}`).send({});
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

test("CONFIRMING과 RECONCILE_REQUIRED 결제를 Toss DONE 기준으로 복구한다", async () => {
  for (const status of ["CONFIRMING", "RECONCILE_REQUIRED"]) {
    const { order, token } = await createReconciliationCase(status);
    const response = await reconcile(order.id, token);
    assert.equal(response.status, 200);
    assert.equal(response.body.reconciled, true);
    assert.equal(response.body.paymentStatus, "DONE");
    assert.equal(response.body.orderPaymentStatus, "결제완료");
    assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(order.id).status, "DONE");
    assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "결제완료");
    assert.equal(db.prepare("SELECT workflow_status FROM orders WHERE id=?").get(order.id).workflow_status, "접수대기");
    const log = db.prepare("SELECT * FROM activity_logs WHERE entity_id=? AND action='payment_reconciled'").get(order.id);
    assert.equal(log.previous_value, status);
    assert.equal(log.next_value, "DONE");
  }
});

test("이미 DONE이거나 webhook 처리된 결제의 관리자 재조정은 멱등하다", async () => {
  const doneCase = await createReconciliationCase("DONE");
  db.prepare("UPDATE orders SET payment_status='결제완료' WHERE id=?").run(doneCase.order.id);
  const doneResponse = await reconcile(doneCase.order.id, doneCase.token);
  assert.equal(doneResponse.status, 200);
  assert.equal(doneResponse.body.reconciled, false);
  assert.equal(doneResponse.body.alreadyDone, true);

  const webhookCase = await createReconciliationCase("CONFIRMING");
  const webhook = await request(app).post("/api/payments/webhook").send({ data: { paymentKey: webhookCase.paymentKey } });
  assert.equal(webhook.status, 200);
  const replay = await reconcile(webhookCase.order.id, webhookCase.token);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.alreadyDone, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE entity_id=? AND action='payment_reconciled'").get(webhookCase.order.id).count, 1);
});

test("금액·주문번호·paymentKey 불일치는 자동 복구하지 않는다", async () => {
  const amountCase = await createReconciliationCase("CONFIRMING", { totalAmount: 1 });
  assert.equal((await reconcile(amountCase.order.id, amountCase.token)).body.reason, "AMOUNT_MISMATCH");
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(amountCase.order.id).status, "RECONCILE_REQUIRED");

  const orderCase = await createReconciliationCase("RECONCILE_REQUIRED", { orderId: "different-order" });
  assert.equal((await reconcile(orderCase.order.id, orderCase.token)).body.reason, "ORDER_ID_MISMATCH");
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(orderCase.order.id).status, "RECONCILE_REQUIRED");

  const collisionCase = await createReconciliationCase("CONFIRMING");
  const other = await createOrder();
  db.prepare(`INSERT INTO payments (id, order_id, amount, status, requested_at, payment_key)
    VALUES (?, ?, ?, 'CONFIRMING', ?, ?)`)
    .run(`collision-${Date.now()}`, other.id, other.totalAmount, new Date().toISOString(), collisionCase.paymentKey);
  assert.equal((await reconcile(collisionCase.order.id, collisionCase.token)).body.reason, "PAYMENT_KEY_CONFLICT");
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(collisionCase.order.id).status, "RECONCILE_REQUIRED");
});

test("취소 또는 미승인 Toss 상태를 DONE으로 복구하지 않는다", async () => {
  for (const providerStatus of ["CANCELED", "PARTIAL_CANCELED", "WAITING_FOR_DEPOSIT"]) {
    const sample = await createReconciliationCase("RECONCILE_REQUIRED", { status: providerStatus });
    const response = await reconcile(sample.order.id, sample.token);
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, providerStatus === "WAITING_FOR_DEPOSIT" ? "PROVIDER_NOT_DONE" : "PROVIDER_CANCELED");
    assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(sample.order.id).status, "RECONCILE_REQUIRED");
    assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(sample.order.id).payment_status, "결제대기");
  }
});

test("없는 주문과 결제 레코드를 명확히 구분한다", async () => {
  const token = await adminToken();
  const missingOrder = await reconcile("missing-order", token);
  assert.equal(missingOrder.status, 404);
  assert.equal(missingOrder.body.reason, "ORDER_NOT_FOUND");

  const order = await createOrder();
  const missingPayment = await reconcile(order.id, token);
  assert.equal(missingPayment.status, 404);
  assert.equal(missingPayment.body.reason, "PAYMENT_NOT_FOUND");
});

test("관리자 재조정 API는 관리자 인증을 강제한다", async () => {
  const sample = await createReconciliationCase("CONFIRMING");
  assert.equal((await request(app).post(`/api/payments/${sample.order.id}/reconcile`).send({})).status, 401);
  const customerToken = jwt.sign({ sub: "customer-1", role: "customer" }, process.env.JWT_SECRET);
  assert.equal((await reconcile(sample.order.id, customerToken)).status, 403);
  assert.equal((await reconcile(sample.order.id, sample.token)).status, 200);
});

test("Toss 조회 timeout과 5xx는 재조정 필요 상태를 유지한다", async () => {
  const originalGetPayment = toss.getPayment;
  try {
    const timeoutCase = await createReconciliationCase("CONFIRMING");
    toss.getPayment = async () => {
      const error = new Error("sensitive provider detail");
      error.code = "ETIMEDOUT";
      throw error;
    };
    const timeout = await reconcile(timeoutCase.order.id, timeoutCase.token);
    assert.equal(timeout.status, 502);
    assert.equal(timeout.body.reason, "PROVIDER_TIMEOUT");
    assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(timeoutCase.order.id).status, "RECONCILE_REQUIRED");

    const unavailableCase = await createReconciliationCase("CONFIRMING");
    toss.getPayment = async () => ({ status: 503, data: { message: "provider internal detail" } });
    const unavailable = await reconcile(unavailableCase.order.id, unavailableCase.token);
    assert.equal(unavailable.status, 502);
    assert.equal(unavailable.body.reason, "PROVIDER_UNAVAILABLE");
    assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(unavailableCase.order.id).status, "RECONCILE_REQUIRED");
  } finally {
    toss.getPayment = originalGetPayment;
  }
});

test("DB 반영 실패는 전체 rollback 후 RECONCILE_REQUIRED로 남긴다", async () => {
  const sample = await createReconciliationCase("RECONCILE_REQUIRED");
  db.exec(`CREATE TEMP TRIGGER fail_payment_reconcile_log
    BEFORE INSERT ON activity_logs
    WHEN NEW.action = 'payment_reconciled'
    BEGIN SELECT RAISE(ABORT, 'forced reconciliation failure'); END;`);
  try {
    const response = await reconcile(sample.order.id, sample.token);
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, "DB_RECONCILIATION_FAILED");
    assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(sample.order.id).status, "RECONCILE_REQUIRED");
    assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(sample.order.id).payment_status, "결제대기");
  } finally {
    db.exec("DROP TRIGGER fail_payment_reconcile_log");
  }
});

test("Toss 승인 성공 후 DB 반영 실패는 FAILED가 아닌 재조정 필요 상태로 남는다", async () => {
  const order = await createOrder();
  const token = await adminToken();
  const created = await request(app).post("/api/payments").set("Authorization", `Bearer ${token}`).send({ orderId: order.id });
  const info = await request(app).get(`/api/payments/info/${order.id}`).query({ token: created.body.linkToken });
  db.exec(`CREATE TEMP TRIGGER fail_normal_payment_completion
    BEFORE INSERT ON activity_logs
    WHEN NEW.action = 'payment_status_change'
    BEGIN SELECT RAISE(ABORT, 'forced post-confirm failure'); END;`);
  try {
    const confirmed = await request(app).post("/api/payments/confirm").set("X-Payment-Session", info.body.sessionToken)
      .send({ paymentKey: `post-confirm-${order.id}`, orderId: order.id, amount: order.totalAmount });
    assert.equal(confirmed.status, 502);
    assert.equal(confirmed.body.reconcileRequired, true);
    assert.equal(confirmed.body.retryable, undefined);
    assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(order.id).status, "RECONCILE_REQUIRED");
    assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "결제대기");
  } finally {
    db.exec("DROP TRIGGER fail_normal_payment_completion");
  }
  const recovered = await reconcile(order.id, token);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.paymentStatus, "DONE");
});

test("관리자 workflow 변경만으로 주문을 결제완료 처리하지 않는다", async () => {
  const order = await createOrder();
  const token = await adminToken();
  const moved = await request(app).put(`/api/orders/${order.id}`).set("Authorization", `Bearer ${token}`)
    .send({ workflowStatus: "접수대기" });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.paymentStatus, "결제대기");
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "결제대기");
});

test("온라인 결제 주문의 paymentStatus를 관리자 주문 수정 API에서 직접 변경할 수 없다", async () => {
  for (const paymentStatus of ["결제완료", "부분환불", "결제취소"]) {
    const order = await createOrder();
    const token = await adminToken();
    await request(app).post("/api/payments").set("Authorization", `Bearer ${token}`).send({ orderId: order.id }).expect(201);
    const response = await request(app).put(`/api/orders/${order.id}`).set("Authorization", `Bearer ${token}`)
      .send({ paymentStatus });
    assert.equal(response.status, 409);
    assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "결제대기");
  }
});

test("payments 레코드가 없는 관리자 수기 주문은 수동 결제 상태 변경을 유지한다", async () => {
  const token = await adminToken();
  const pickupDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const created = await request(app).post("/api/orders/admin").set("Authorization", `Bearer ${token}`).send({
    customer: "수기 주문 고객",
    phone: "010-2222-3333",
    product: "수기 등록 상품",
    quantity: 1,
    unitPrice: 10000,
    pickupDate,
    paymentStatus: "결제대기",
  });
  assert.equal(created.status, 201);
  assert.equal(db.prepare("SELECT 1 FROM payments WHERE order_id=?").get(created.body.id), undefined);

  const updated = await request(app).put(`/api/orders/${created.body.id}`).set("Authorization", `Bearer ${token}`)
    .send({ paymentStatus: "결제완료" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.paymentStatus, "결제완료");
});

test("미결제 온라인 주문은 생산·배송 진행을 막고 취소 전환은 허용한다", async () => {
  const productionCase = await createOrder();
  const productionToken = await adminToken();
  await request(app).post("/api/payments").set("Authorization", `Bearer ${productionToken}`)
    .send({ orderId: productionCase.id }).expect(201);
  const productionItem = db.prepare("SELECT product_name FROM order_items WHERE order_id=? LIMIT 1")
    .get(productionCase.id);
  const productionResponse = await request(app).post("/api/orders/production/complete")
    .set("Authorization", `Bearer ${productionToken}`)
    .send({ orderIds: [productionCase.id], productName: productionItem.product_name });
  assert.equal(productionResponse.status, 409);

  const attempts = [
    { workflowStatus: "접수완료" },
    { status: "준비중" },
    { productionStatus: "생산 중" },
    { logisticsStatus: "배송중" },
  ];
  for (const body of attempts) {
    const order = await createOrder();
    const token = await adminToken();
    await request(app).post("/api/payments").set("Authorization", `Bearer ${token}`).send({ orderId: order.id }).expect(201);
    const response = await request(app).put(`/api/orders/${order.id}`).set("Authorization", `Bearer ${token}`).send(body);
    assert.equal(response.status, 409);
    const stored = db.prepare("SELECT workflow_status, status, production_status FROM orders WHERE id=?").get(order.id);
    assert.equal(stored.workflow_status, "결제대기");
    assert.equal(stored.status, "접수대기");
    assert.equal(stored.production_status, "생산 대기");
  }

  const cancelCase = await createOrder();
  const token = await adminToken();
  await request(app).post("/api/payments").set("Authorization", `Bearer ${token}`).send({ orderId: cancelCase.id }).expect(201);
  const canceled = await request(app).put(`/api/orders/${cancelCase.id}`).set("Authorization", `Bearer ${token}`)
    .send({ workflowStatus: "취소", changeReason: "고객 요청" });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.workflowStatus, "취소");
});

test("재조정 성공은 이미 진행된 workflow와 주문 status를 후퇴시키지 않는다", async () => {
  const cases = [
    { workflowStatus: "접수완료", status: "준비중" },
    { workflowStatus: "배송중", status: "배송중" },
    { workflowStatus: "픽업준비완료", status: "준비완료" },
  ];
  for (const advanced of cases) {
    const sample = await createReconciliationCase("RECONCILE_REQUIRED");
    db.prepare("UPDATE orders SET workflow_status=?, status=? WHERE id=?")
      .run(advanced.workflowStatus, advanced.status, sample.order.id);
    const response = await reconcile(sample.order.id, sample.token);
    assert.equal(response.status, 200);
    const stored = db.prepare("SELECT workflow_status, status, payment_status FROM orders WHERE id=?").get(sample.order.id);
    assert.equal(stored.workflow_status, advanced.workflowStatus);
    assert.equal(stored.status, advanced.status);
    assert.equal(stored.payment_status, "결제완료");
  }
});

test("동일 재조정 동시 요청은 한 번만 반영한다", async () => {
  const sample = await createReconciliationCase("CONFIRMING");
  const [first, second] = await Promise.all([
    reconcile(sample.order.id, sample.token),
    reconcile(sample.order.id, sample.token),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal([first.body.reconciled, second.body.reconciled].filter(Boolean).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE entity_id=? AND action='payment_reconciled'").get(sample.order.id).count, 1);
});

test("webhook과 관리자 재조정이 동시에 실행돼도 한 번만 반영한다", async () => {
  const sample = await createReconciliationCase("CONFIRMING");
  const [webhook, admin] = await Promise.all([
    request(app).post("/api/payments/webhook").send({ data: { paymentKey: sample.paymentKey } }),
    reconcile(sample.order.id, sample.token),
  ]);
  assert.equal(webhook.status, 200);
  assert.equal(admin.status, 200);
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(sample.order.id).status, "DONE");
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(sample.order.id).payment_status, "결제완료");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE entity_id=? AND action='payment_reconciled'").get(sample.order.id).count, 1);
});

test("재조정 오류 응답과 감사 로그에 paymentKey나 provider secret을 노출하지 않는다", async () => {
  const sample = await createReconciliationCase("CONFIRMING", { totalAmount: 1 });
  const response = await reconcile(sample.order.id, sample.token);
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, new RegExp(sample.paymentKey));
  assert.doesNotMatch(serialized, new RegExp(`provider-secret-${sample.order.id}`));
  const logs = db.prepare("SELECT message FROM activity_logs WHERE entity_id=?").all(sample.order.id);
  for (const log of logs) {
    assert.doesNotMatch(log.message, new RegExp(sample.paymentKey));
    assert.doesNotMatch(log.message, new RegExp(`provider-secret-${sample.order.id}`));
  }
});

test("concurrent admin cancellations acquire one CANCELING lock and call Toss once", async () => {
  const sample = await createReconciliationCase("DONE");
  db.prepare("UPDATE orders SET payment_status='결제완료' WHERE id=?").run(sample.order.id);
  const originalCancel = toss.cancelPayment;
  let calls = 0;
  toss.cancelPayment = async (options) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return originalCancel(options);
  };
  try {
    const requests = [1, 2].map(() => request(app)
      .post(`/api/payments/${sample.order.id}/cancel`)
      .set("Authorization", `Bearer ${sample.token}`)
      .send({ cancelAmount: 1000, cancelReason: "concurrency test" }));
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(calls, 1);
    const payment = db.prepare("SELECT status, canceled_amount FROM payments WHERE order_id=?").get(sample.order.id);
    assert.equal(payment.status, "PARTIAL_CANCELED");
    assert.equal(payment.canceled_amount, 1000);
  } finally {
    toss.cancelPayment = originalCancel;
  }
});

test("Toss cancels history is authoritative and repeated webhooks are idempotent", async () => {
  const sample = await createReconciliationCase("DONE");
  db.prepare("UPDATE orders SET payment_status='결제완료' WHERE id=?").run(sample.order.id);
  const first = await request(app).post(`/api/payments/${sample.order.id}/cancel`)
    .set("Authorization", `Bearer ${sample.token}`).send({ cancelAmount: 1000, cancelReason: "first" });
  assert.equal(first.status, 200);
  const second = await request(app).post(`/api/payments/${sample.order.id}/cancel`)
    .set("Authorization", `Bearer ${sample.token}`).send({ cancelAmount: 2000, cancelReason: "second" });
  assert.equal(second.status, 200);
  assert.equal(second.body.canceledAmount, 3000);

  const beforeLogs = db.prepare(
    "SELECT COUNT(*) AS count FROM activity_logs WHERE entity_id=? AND action='payment_status_change'"
  ).get(sample.order.id).count;
  for (let index = 0; index < 2; index += 1) {
    const webhook = await request(app).post("/api/payments/webhook").send({ data: { paymentKey: sample.paymentKey } });
    assert.equal(webhook.status, 200);
  }
  const stored = db.prepare("SELECT canceled_amount FROM payments WHERE order_id=?").get(sample.order.id);
  assert.equal(stored.canceled_amount, 3000);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM activity_logs WHERE entity_id=? AND action='payment_status_change'"
  ).get(sample.order.id).count, beforeLogs);
});

test("provider cancellation success followed by DB failure remains reconcilable", async () => {
  const sample = await createReconciliationCase("DONE");
  db.prepare("UPDATE orders SET payment_status='결제완료' WHERE id=?").run(sample.order.id);
  db.exec(`CREATE TEMP TRIGGER fail_cancel_log
    BEFORE INSERT ON activity_logs
    WHEN NEW.action = 'payment_status_change'
    BEGIN SELECT RAISE(ABORT, 'forced cancellation failure'); END;`);
  try {
    const response = await request(app).post(`/api/payments/${sample.order.id}/cancel`)
      .set("Authorization", `Bearer ${sample.token}`).send({ cancelAmount: 1000 });
    assert.equal(response.status, 502);
    assert.equal(response.body.reconcileRequired, true);
    const payment = db.prepare(
      "SELECT status, canceled_amount, last_error, cancel_idempotency_key FROM payments WHERE order_id=?"
    ).get(sample.order.id);
    assert.equal(payment.status, "RECONCILE_REQUIRED");
    assert.equal(payment.canceled_amount, 0);
    assert.equal(payment.last_error, "CANCEL_POST_PROVIDER_RECONCILIATION_REQUIRED");
    assert.ok(payment.cancel_idempotency_key);
  } finally {
    db.exec("DROP TRIGGER fail_cancel_log");
  }
  const webhook = await request(app).post("/api/payments/webhook").send({ data: { paymentKey: sample.paymentKey } });
  assert.equal(webhook.status, 200);
  assert.equal(db.prepare("SELECT status FROM payments WHERE order_id=?").get(sample.order.id).status, "PARTIAL_CANCELED");
});

test("explicit Toss 4xx rejection restores state, clears the key, and a retry gets a new key", async () => {
  const originalCancel = toss.cancelPayment;
  try {
    for (const previousStatus of ["DONE", "PARTIAL_CANCELED"]) {
      const sample = await createReconciliationCase("DONE");
      const previousCanceled = previousStatus === "PARTIAL_CANCELED" ? 1000 : 0;
      db.prepare("UPDATE payments SET status=?, canceled_amount=? WHERE order_id=?")
        .run(previousStatus, previousCanceled, sample.order.id);
      db.prepare("UPDATE orders SET payment_status=? WHERE id=?")
        .run(previousStatus === "DONE" ? "결제완료" : "부분환불", sample.order.id);

      const keys = [];
      toss.cancelPayment = async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        if (keys.length === 1) {
          return { status: 400, data: { code: "REJECTED", message: "explicit rejection" } };
        }
        return {
          status: 200,
          data: {
            paymentKey: sample.paymentKey,
            orderId: sample.order.id,
            totalAmount: sample.order.totalAmount,
            status: "PARTIAL_CANCELED",
            balanceAmount: sample.order.totalAmount - previousCanceled - 1000,
            cancels: [
              ...(previousCanceled ? [{ cancelAmount: previousCanceled }] : []),
              { cancelAmount: 1000 },
            ],
          },
        };
      };

      const rejected = await request(app).post(`/api/payments/${sample.order.id}/cancel`)
        .set("Authorization", `Bearer ${sample.token}`).send({ cancelAmount: 1000 });
      assert.equal(rejected.status, 400);
      assert.doesNotMatch(JSON.stringify(rejected.body), new RegExp(keys[0]));
      let stored = db.prepare(
        "SELECT status, last_error, cancel_idempotency_key FROM payments WHERE order_id=?"
      ).get(sample.order.id);
      assert.equal(stored.status, previousStatus);
      assert.equal(stored.last_error, "CANCEL_PROVIDER_REJECTED");
      assert.equal(stored.cancel_idempotency_key, null);

      const retried = await request(app).post(`/api/payments/${sample.order.id}/cancel`)
        .set("Authorization", `Bearer ${sample.token}`).send({ cancelAmount: 1000 });
      assert.equal(retried.status, 200);
      assert.equal(keys.length, 2);
      assert.notEqual(keys[0], keys[1]);
      const logs = db.prepare("SELECT message FROM activity_logs WHERE entity_id=?").all(sample.order.id);
      assert.equal(logs.some((log) => log.message.includes(keys[0]) || log.message.includes(keys[1])), false);
    }
  } finally {
    toss.cancelPayment = originalCancel;
  }
});

test("mock cancellation rejects invalid amounts without mutating provider data", async () => {
  const paymentKey = `mock-validation-${Date.now()}`;
  const initial = {
    paymentKey,
    orderId: "mock-order",
    totalAmount: 10000,
    status: "PARTIAL_CANCELED",
    balanceAmount: 8000,
    cancels: [{ cancelAmount: 2000, cancelReason: "existing" }],
  };
  toss.mockPayments.set(paymentKey, structuredClone(initial));

  for (const invalid of [8001, 0, -1, 1.5, Number.NaN]) {
    const before = structuredClone(toss.mockPayments.get(paymentKey));
    const result = await toss.cancelPayment({ paymentKey, cancelReason: "invalid", cancelAmount: invalid });
    assert.equal(result.status, 400);
    assert.equal(result.data.code, "INVALID_CANCEL_AMOUNT");
    assert.deepEqual(toss.mockPayments.get(paymentKey), before);
  }

  const partial = await toss.cancelPayment({ paymentKey, cancelReason: "partial", cancelAmount: 3000 });
  assert.equal(partial.status, 200);
  assert.equal(partial.data.status, "PARTIAL_CANCELED");
  assert.equal(partial.data.balanceAmount, 5000);
  assert.equal(partial.data.cancels.reduce((sum, item) => sum + item.cancelAmount, 0), 5000);

  const full = await toss.cancelPayment({ paymentKey, cancelReason: "full" });
  assert.equal(full.status, 200);
  assert.equal(full.data.status, "CANCELED");
  assert.equal(full.data.balanceAmount, 0);
  assert.equal(full.data.cancels.reduce((sum, item) => sum + item.cancelAmount, 0), 10000);
});
