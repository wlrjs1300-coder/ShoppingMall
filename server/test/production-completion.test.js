process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-production-completion";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../index");
const db = require("../db");

const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const pickupDate = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
let token;

async function resetAndCreateOrder({ quantity = 2, stock = 10 } = {}) {
  for (const table of ["production_completions", "inventory_logs", "order_status_history", "checkout_idempotency", "order_items", "orders", "activity_logs", "inventory", "recipes"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("INSERT INTO inventory (id, name, stock, unit, safe_stock, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("inv-rice", "멥쌀가루", stock, "kg", 2, new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO recipes (product, ingredient, amount, unit) VALUES (?, ?, ?, ?)")
    .run("인절미", "멥쌀가루", 0.5, "kg");
  const created = await request(app).post("/api/orders").send({
    productId: "injeolmi", quantity, customer: "생산 테스트", phone: "010-1234-5678",
    pickupDate, pickupTime: "14:30", fulfillmentType: "pickup", deliveryAddress: "", memo: "",
  });
  assert.equal(created.status, 201);
  return created.body.id;
}

test.before(async () => {
  const login = await request(app).post("/api/auth/login").send({ code: "test-admin-code" });
  assert.equal(login.status, 200);
  token = login.body.token;
});

test("생산 완료는 주문 상태·원재료·사용 이력을 한 트랜잭션에서 반영한다", async () => {
  const orderId = await resetAndCreateOrder({ quantity: 4, stock: 10 });
  const response = await request(app).post("/api/orders/production/complete")
    .set("Authorization", `Bearer ${token}`)
    .send({ orderIds: [orderId], productName: "인절미" });

  assert.equal(response.status, 200);
  assert.equal(response.body.alreadyCompleted, false);
  assert.equal(db.prepare("SELECT stock FROM inventory WHERE id='inv-rice'").get().stock, 8);
  const order = db.prepare("SELECT production_status, status FROM orders WHERE id=?").get(orderId);
  assert.equal(order.production_status, "생산 완료");
  assert.equal(order.status, "준비완료");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM production_completions WHERE order_id=?").get(orderId).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM inventory_logs").get().count, 1);
});

test("같은 생산 완료 요청을 반복해도 원재료를 다시 차감하지 않는다", async () => {
  const orderId = await resetAndCreateOrder({ quantity: 2, stock: 10 });
  const send = () => request(app).post("/api/orders/production/complete")
    .set("Authorization", `Bearer ${token}`)
    .send({ orderIds: [orderId], productName: "인절미" });

  assert.equal((await send()).status, 200);
  const repeated = await send();
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.alreadyCompleted, true);
  assert.equal(db.prepare("SELECT stock FROM inventory WHERE id='inv-rice'").get().stock, 9);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM inventory_logs").get().count, 1);
});

test("원재료가 부족하면 생산 완료와 부분 차감을 모두 거절한다", async () => {
  const orderId = await resetAndCreateOrder({ quantity: 4, stock: 1 });
  const response = await request(app).post("/api/orders/production/complete")
    .set("Authorization", `Bearer ${token}`)
    .send({ orderIds: [orderId], productName: "인절미" });

  assert.equal(response.status, 409);
  assert.equal(db.prepare("SELECT stock FROM inventory WHERE id='inv-rice'").get().stock, 1);
  assert.equal(db.prepare("SELECT production_status FROM orders WHERE id=?").get(orderId).production_status, "생산 대기");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM production_completions").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM inventory_logs").get().count, 0);
});

test("이력 저장이 실패하면 재고 차감과 생산 완료를 rollback한다", async () => {
  const orderId = await resetAndCreateOrder({ quantity: 2, stock: 10 });
  db.exec("CREATE TEMP TRIGGER fail_inventory_log BEFORE INSERT ON inventory_logs BEGIN SELECT RAISE(ABORT, 'forced log failure'); END");
  const response = await request(app).post("/api/orders/production/complete")
    .set("Authorization", `Bearer ${token}`)
    .send({ orderIds: [orderId], productName: "인절미" });
  db.exec("DROP TRIGGER fail_inventory_log");

  assert.equal(response.status, 500);
  assert.equal(db.prepare("SELECT stock FROM inventory WHERE id='inv-rice'").get().stock, 10);
  assert.equal(db.prepare("SELECT production_status FROM orders WHERE id=?").get(orderId).production_status, "생산 대기");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM production_completions").get().count, 0);
});
