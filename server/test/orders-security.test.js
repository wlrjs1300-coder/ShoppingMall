process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-orders-security";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");

const app = require("../index");
const db = require("../db");
const { COOKIE_NAME, issueCustomerToken } = require("../middleware/customerAuth");

const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const FUTURE_PICKUP_DATE = new Date(futureDate.getTime() - futureDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function validOrder(overrides = {}) {
  return {
    productId: "injeolmi",
    quantity: 2,
    customer: "홍길동",
    phone: "010-1234-5678",
    pickupDate: FUTURE_PICKUP_DATE,
    pickupTime: "14:30",
    fulfillmentType: "pickup",
    deliveryAddress: "",
    memo: "예쁘게 포장해 주세요.",
    ...overrides,
  };
}

function validCheckout(overrides = {}) {
  return {
    items: [
      { productId: "injeolmi", quantity: 2 },
      { productId: "yaksik", quantity: 3 },
    ],
    customer: "홍길동",
    phone: "010-1234-5678",
    pickupDate: FUTURE_PICKUP_DATE,
    pickupTime: "14:30",
    fulfillmentType: "pickup",
    deliveryAddress: "",
    memo: "장바구니 주문",
    ...overrides,
  };
}

test("주문 보안용 스키마가 생성된다", () => {
  const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
  assert.ok(orderColumns.some((column) => column.name === "user_id"));
  assert.ok(orderColumns.some((column) => column.name === "customer_name"));
  assert.ok(orderColumns.some((column) => column.name === "total_amount"));
  assert.ok(orderColumns.some((column) => column.name === "guest_password_hash"));
  assert.ok(orderColumns.some((column) => column.name === "guest_address"));
  assert.ok(orderColumns.some((column) => column.name === "payment_status"));
  assert.ok(orderColumns.some((column) => column.name === "amount_status"));
  const itemColumns = db.prepare("PRAGMA table_info(order_items)").all();
  for (const column of ["order_id", "product_id", "product_name", "unit_price", "quantity", "line_total"]) {
    assert.ok(itemColumns.some((itemColumn) => itemColumn.name === column), `${column} 컬럼 누락`);
  }
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_idempotency'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkout_idempotency'").get());
});

test("상품명·가격·원가·상태·주문 ID는 클라이언트 값을 무시하고 서버에서 결정한다", async () => {
  const response = await request(app).post("/api/orders").send(validOrder({
    id: "attacker-order-id",
    product: "조작 상품",
    priceText: "1원",
    unitPrice: 1,
    revenue: 1,
    cost: -999999,
    status: "결제완료",
    logisticsStatus: "완료",
  }));

  assert.equal(response.status, 201);
  assert.notEqual(response.body.id, "attacker-order-id");
  assert.match(response.body.id, /^order-/);
  assert.equal(response.body.productId, "injeolmi");
  assert.equal(response.body.product, "인절미");
  assert.equal(response.body.unitPrice, 3500);
  assert.equal(response.body.revenue, 7000);
  assert.equal(response.body.cost, 0);
  assert.equal(response.body.status, "접수대기");
  assert.equal(response.body.paymentStatus, "결제대기");
  assert.equal(response.body.amountStatus, "confirmed");
  assert.equal(response.body.logisticsStatus, "픽업대기");
});

test("존재하지 않거나 판매 중지된 상품은 주문할 수 없다", async () => {
  const missing = await request(app).post("/api/orders").send(validOrder({ productId: "does-not-exist" }));
  assert.equal(missing.status, 404);

  db.prepare("UPDATE products SET status = 'inactive' WHERE id = 'injeolmi'").run();
  const inactive = await request(app).post("/api/orders").send(validOrder());
  assert.equal(inactive.status, 404);
  db.prepare("UPDATE products SET status = 'active' WHERE id = 'injeolmi'").run();
});

test("수량은 1~99 사이의 정수만 허용한다", async () => {
  for (const quantity of [0, 1.5, 100, "두 개"]) {
    const response = await request(app).post("/api/orders").send(validOrder({ quantity }));
    assert.equal(response.status, 400, `quantity=${quantity}`);
  }
});

test("잘못된 연락처와 과도하게 긴 이름·메모를 거부한다", async () => {
  const invalidPhone = await request(app).post("/api/orders").send(validOrder({ phone: "1234" }));
  assert.equal(invalidPhone.status, 400);
  const longName = await request(app).post("/api/orders").send(validOrder({ customer: "가".repeat(51) }));
  assert.equal(longName.status, 400);
  const longMemo = await request(app).post("/api/orders").send(validOrder({ memo: "가".repeat(501) }));
  assert.equal(longMemo.status, 400);
});

test("배송 주문은 주소가 필수이며 픽업 주문의 불필요한 주소는 저장하지 않는다", async () => {
  const noAddress = await request(app).post("/api/orders").send(validOrder({ fulfillmentType: "delivery" }));
  assert.equal(noAddress.status, 400);

  const pickup = await request(app).post("/api/orders").send(validOrder({ deliveryAddress: "공격자가 넣은 주소" }));
  assert.equal(pickup.status, 201);
  assert.equal(pickup.body.deliveryAddress, null);
});

test("로그인 회원의 주문에는 쿠키의 user_id가 자동 연결된다", async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_accounts
      (id, username, email, password_hash, name, phone, terms_agreed_at, privacy_agreed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("order-user", "order_user", "order@example.com", "unused-hash", "회원", "01011112222", now, now, now, now);

  const token = issueCustomerToken("order-user");
  const response = await request(app)
    .post("/api/orders")
    .set("Cookie", `${COOKIE_NAME}=${token}`)
    .send(validOrder());
  assert.equal(response.status, 201);
  assert.equal(response.body.userId, "order-user");
  assert.equal(db.prepare("SELECT user_id FROM orders WHERE id = ?").get(response.body.id).user_id, "order-user");
});

test("같은 Idempotency-Key 요청은 주문을 중복 생성하지 않는다", async () => {
  const key = "portfolio-order-request-0001";
  const first = await request(app).post("/api/orders").set("Idempotency-Key", key).send(validOrder());
  const replay = await request(app).post("/api/orders").set("Idempotency-Key", key).send(validOrder());
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(replay.body.id, first.body.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = ?").get(first.body.id).count, 1);

  const conflict = await request(app).post("/api/orders").set("Idempotency-Key", key).send(validOrder({ quantity: 3 }));
  assert.equal(conflict.status, 409);
});

test("장바구니 여러 상품은 하나의 checkout으로 묶이고 서버 최신 가격으로 합산된다", async () => {
  const response = await request(app)
    .post("/api/orders/checkout")
    .set("Idempotency-Key", "checkout-multiple-products-0001")
    .send(validCheckout({ totalAmount: 1, price: 1 }));
  assert.equal(response.status, 201);
  assert.match(response.body.checkoutId, /^checkout-/);
  assert.equal(response.body.orders.length, 1);
  assert.equal(response.body.order.items.length, 2);
  assert.equal(response.body.totalQuantity, 5);
  assert.equal(response.body.totalAmount, 19000);
  assert.equal(response.body.order.id, response.body.checkoutId);
  assert.deepEqual(response.body.order.items.map((item) => item.unitPrice).sort((a, b) => a - b), [3500, 4000]);
});

test("상품 하나라도 판매중지 상태면 장바구니 주문 전체를 저장하지 않는다", async () => {
  db.prepare("UPDATE products SET status = 'inactive' WHERE id = 'yaksik'").run();
  const before = db.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  const response = await request(app)
    .post("/api/orders/checkout")
    .set("Idempotency-Key", "checkout-inactive-product-0001")
    .send(validCheckout());
  const after = db.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  db.prepare("UPDATE products SET status = 'active' WHERE id = 'yaksik'").run();
  assert.equal(response.status, 409);
  assert.equal(after, before);
});

test("장바구니 주문의 배송 주소와 상품 수량을 검증한다", async () => {
  const noAddress = await request(app)
    .post("/api/orders/checkout")
    .set("Idempotency-Key", "checkout-no-address-0001")
    .send(validCheckout({ fulfillmentType: "delivery" }));
  assert.equal(noAddress.status, 400);

  const invalidQuantity = await request(app)
    .post("/api/orders/checkout")
    .set("Idempotency-Key", "checkout-invalid-quantity-0001")
    .send(validCheckout({ items: [{ productId: "injeolmi", quantity: 100 }] }));
  assert.equal(invalidQuantity.status, 400);
});

test("장바구니 주문의 로그인 회원 ID를 모든 주문 행에 연결한다", async () => {
  const token = issueCustomerToken("order-user");
  const response = await request(app)
    .post("/api/orders/checkout")
    .set("Cookie", `${COOKIE_NAME}=${token}`)
    .set("Idempotency-Key", "checkout-customer-user-0001")
    .send(validCheckout());
  assert.equal(response.status, 201);
  assert.ok(response.body.orders.every((order) => order.userId === "order-user"));
});

test("같은 장바구니 주문 재전송은 기존 checkout을 반환하고 중복 저장하지 않는다", async () => {
  const key = "checkout-idempotency-replay-0001";
  const first = await request(app).post("/api/orders/checkout").set("Idempotency-Key", key).send(validCheckout());
  const replay = await request(app).post("/api/orders/checkout").set("Idempotency-Key", key).send(validCheckout());
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(replay.body.checkoutId, first.body.checkoutId);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = ?").get(first.body.checkoutId).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?").get(first.body.checkoutId).count, 2);
});

test("상품 가격 변경 후에도 주문 당시 order_items 가격과 합계가 유지된다", async () => {
  const response = await request(app)
    .post("/api/orders/checkout")
    .set("Idempotency-Key", "checkout-price-snapshot-0001")
    .send(validCheckout({ items: [{ productId: "injeolmi", quantity: 2 }] }));
  assert.equal(response.status, 201);
  db.prepare("UPDATE products SET price = 99999 WHERE id = 'injeolmi'").run();

  const item = db.prepare("SELECT unit_price, line_total FROM order_items WHERE order_id = ?").get(response.body.checkoutId);
  const order = db.prepare("SELECT subtotal, total_amount FROM orders WHERE id = ?").get(response.body.checkoutId);
  assert.equal(item.unit_price, 3500);
  assert.equal(item.line_total, 7000);
  assert.equal(order.subtotal, 7000);
  assert.equal(order.total_amount, 7000);
  db.prepare("UPDATE products SET price = 3500 WHERE id = 'injeolmi'").run();
});

test("관리자 주문 조회에 여러 상품이 포함되고 상태 변경 이력이 저장된다", async () => {
  const created = await request(app)
    .post("/api/orders/checkout")
    .set("Idempotency-Key", "checkout-admin-items-0001")
    .send(validCheckout());
  const login = await request(app).post("/api/auth/login").send({ code: "test-admin-code" });
  const token = login.body.token;
  const list = await request(app).get("/api/orders").set("Authorization", `Bearer ${token}`);
  const order = list.body.find((item) => item.id === created.body.checkoutId);
  assert.equal(order.items.length, 2);
  assert.equal(order.product, "인절미 외 1건");

  const preparing = await request(app)
    .put(`/api/orders/${order.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "준비중" });
  assert.equal(preparing.status, 200);
  const updated = await request(app)
    .put(`/api/orders/${order.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "준비완료" });
  assert.equal(updated.status, 200);
  const history = db.prepare("SELECT previous_status, next_status FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC").all(order.id);
  assert.deepEqual(history.map((row) => row.next_status), ["접수대기", "준비중", "준비완료"]);
  assert.equal(history[1].previous_status, "접수대기");
});

test("비회원 주문은 휴대폰 인증을 소비하고 조회 비밀번호를 해시로 저장한다", async () => {
  const phone = "01077778888";
  const password = "guest-order-password";
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO phone_verifications (id, phone, code, code_hash, expires_at, verified_at, attempts, created_at)
    VALUES (?, ?, 'hashed', 'test-hash', ?, ?, 0, ?)`)
    .run("guest-order-verification", phone, new Date(Date.now() + 300000).toISOString(), now, now);

  const response = await request(app).post("/api/orders/checkout")
    .set("Idempotency-Key", "guest-checkout-secure-0001")
    .send(validCheckout({ phone, guestPassword: password, guestAddress: "경기도 화성시 동탄대로 1" }));
  assert.equal(response.status, 201);
  const stored = db.prepare("SELECT guest_password_hash, guest_address FROM orders WHERE id = ?").get(response.body.checkoutId);
  assert.notEqual(stored.guest_password_hash, password);
  assert.equal(bcrypt.compareSync(password, stored.guest_password_hash), true);
  assert.equal(stored.guest_address, "경기도 화성시 동탄대로 1");
  assert.ok(db.prepare("SELECT consumed_at FROM phone_verifications WHERE id = 'guest-order-verification'").get().consumed_at);

  const lookup = await request(app).post("/api/orders/guest/lookup").send({ orderId: response.body.checkoutId, phone, password });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.id, response.body.checkoutId);
  const denied = await request(app).post("/api/orders/guest/lookup").send({ orderId: response.body.checkoutId, phone, password: "wrong-password" });
  assert.equal(denied.status, 401);
});
