process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "destructive-safety-admin";
process.env.JWT_SECRET = "destructive-safety-secret";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../index");
const db = require("../db");

async function token() {
  const response = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE });
  return response.body.token;
}

function insertOrder(id, overrides = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO orders
    (id, customer_name, customer_phone, fulfillment_type, subtotal, delivery_fee, total_amount, cost,
     status, payment_status, amount_status, workflow_status, logistics_status, production_status, created_at, updated_at)
    VALUES (?, '삭제 안전 테스트', '01012345678', 'pickup', 1000, 0, 1000, 0, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`)
    .run(id, overrides.status || "접수대기", overrides.paymentStatus || "결제대기",
      overrides.workflowStatus || "결제대기", overrides.logisticsStatus || "픽업대기",
      overrides.productionStatus || "생산 대기", now, now);
  db.prepare(`INSERT INTO order_items
    (id, order_id, product_name, unit_price, quantity, quantity_unit, line_total)
    VALUES (?, ?, '테스트', 1000, 1, 'pack', 1000)`).run(`item-${id}`, id);
  return now;
}

test("전체 삭제 및 감사·재고 이력 삭제 API는 인증 후에도 차단된다", async () => {
  const admin = await token();
  for (const endpoint of ["/api/orders", "/api/inventory", "/api/inventory/logs", "/api/purchase-orders"]) {
    assert.equal((await request(app).delete(endpoint)).status, 401);
    const customer = jwt.sign({ sub: "customer", role: "customer" }, process.env.JWT_SECRET);
    assert.equal((await request(app).delete(endpoint).set("Authorization", `Bearer ${customer}`)).status, 403);
    const response = await request(app).delete(endpoint).set("Authorization", `Bearer ${admin}`);
    assert.equal(response.status, 405);
    assert.ok(["DESTRUCTIVE_ACTION_DISABLED", "INVENTORY_HISTORY_EXISTS"].includes(response.body.reason));
  }
  db.prepare(`INSERT INTO activity_logs (id, category, message, tab, created_at)
    VALUES ('immutable-log', 'TEST', 'must remain', 'logs', ?)`).run(new Date().toISOString());
  const logs = await request(app).delete("/api/activity-logs").set("Authorization", `Bearer ${admin}`);
  assert.equal(logs.status, 405);
  assert.equal(logs.body.reason, "AUDIT_LOG_IMMUTABLE");
  assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE id='immutable-log'").get());
  assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE action='destructive_action_blocked' AND entity_id='activity_logs'").get());
});

test("결제 또는 상태 이력이 있는 주문과 진행 주문은 삭제되지 않는다", async () => {
  const admin = await token();
  for (const paymentStatus of ["DONE", "FAILED", "RECONCILE_REQUIRED"]) {
    const id = `protected-payment-${paymentStatus}`;
    const now = insertOrder(id);
    db.prepare(`INSERT INTO payments (id, order_id, amount, status, requested_at)
      VALUES (?, ?, 1000, ?, ?)`).run(`payment-${id}`, id, paymentStatus, now);
    const response = await request(app).delete(`/api/orders/${id}`).set("Authorization", `Bearer ${admin}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, "PAYMENT_HISTORY_EXISTS");
    assert.ok(db.prepare("SELECT 1 FROM orders WHERE id=?").get(id));
  }

  const historyId = "protected-history";
  const now = insertOrder(historyId);
  db.prepare(`INSERT INTO order_status_history
    (id, order_id, previous_status, next_status, changed_by, created_at)
    VALUES ('history-protected', ?, NULL, '접수대기', 'customer', ?)`).run(historyId, now);
  const history = await request(app).delete(`/api/orders/${historyId}`).set("Authorization", `Bearer ${admin}`);
  assert.equal(history.status, 409);
  assert.equal(history.body.reason, "ORDER_HISTORY_EXISTS");

  for (const [id, overrides] of [
    ["protected-production", { productionStatus: "생산 중" }],
    ["protected-delivery", { workflowStatus: "배송중", logisticsStatus: "배송중" }],
    ["protected-refund", { paymentStatus: "부분환불" }],
  ]) {
    insertOrder(id, overrides);
    const response = await request(app).delete(`/api/orders/${id}`).set("Authorization", `Bearer ${admin}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, "INVALID_DELETE_STATE");
  }
});

test("이력이 없는 초기 오입력 주문만 트랜잭션으로 삭제하고 감사 로그를 남긴다", async () => {
  const admin = await token();
  insertOrder("unused-initial-order");
  const response = await request(app).delete("/api/orders/unused-initial-order")
    .set("Authorization", `Bearer ${admin}`);
  assert.equal(response.status, 200);
  assert.equal(db.prepare("SELECT 1 FROM orders WHERE id='unused-initial-order'").get(), undefined);
  assert.ok(db.prepare(
    "SELECT 1 FROM activity_logs WHERE entity_id='unused-initial-order' AND action='order_deleted'"
  ).get());

  insertOrder("rollback-initial-order");
  db.exec(`CREATE TEMP TRIGGER fail_order_delete_audit
    BEFORE INSERT ON activity_logs WHEN NEW.action='order_deleted'
    BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;`);
  try {
    const failed = await request(app).delete("/api/orders/rollback-initial-order")
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(failed.status, 500);
    assert.ok(db.prepare("SELECT 1 FROM orders WHERE id='rollback-initial-order'").get());
    assert.ok(db.prepare("SELECT 1 FROM order_items WHERE order_id='rollback-initial-order'").get());
  } finally {
    db.exec("DROP TRIGGER fail_order_delete_audit");
  }
});

test("재고 이력·재고량·발주가 있는 품목은 보호하고 미사용 품목만 삭제한다", async () => {
  const admin = await token();
  const now = new Date().toISOString();
  for (const [id, name, stock] of [
    ["inventory-stock", "재고 있음", 1],
    ["inventory-log", "이력 있음", 0],
    ["inventory-purchase", "발주 있음", 0],
    ["inventory-unused", "미사용 오입력", 0],
  ]) db.prepare(`INSERT INTO inventory
    (id, name, stock, unit, safe_stock, created_at, updated_at) VALUES (?, ?, ?, 'kg', 0, ?, ?)`)
    .run(id, name, stock, now, now);
  db.prepare(`INSERT INTO inventory_logs (id, product, quantity, created_at)
    VALUES ('inventory-log-row', '이력 있음', 1, ?)`).run(now);
  db.prepare(`INSERT INTO purchase_orders
    (id, inventory_id, name, status, created_at, updated_at)
    VALUES ('inventory-purchase-row', 'inventory-purchase', '발주 있음', '발주요청', ?, ?)`).run(now, now);

  for (const id of ["inventory-stock", "inventory-log", "inventory-purchase"]) {
    const response = await request(app).delete(`/api/inventory/${id}`).set("Authorization", `Bearer ${admin}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, "INVENTORY_HISTORY_EXISTS");
  }
  const deleted = await request(app).delete("/api/inventory/inventory-unused")
    .set("Authorization", `Bearer ${admin}`);
  assert.equal(deleted.status, 200);
  assert.ok(db.prepare("SELECT 1 FROM inventory_logs WHERE id='inventory-log-row'").get());
  assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE entity_id='inventory-unused' AND action='inventory_deleted'").get());
});

test("초기 발주만 삭제하고 확정·입고 발주는 보호한다", async () => {
  const admin = await token();
  const now = new Date().toISOString();
  for (const [id, status, receivedAt] of [
    ["purchase-draft", "발주요청", null],
    ["purchase-confirmed", "발주확정", null],
    ["purchase-received", "입고완료", now],
  ]) db.prepare(`INSERT INTO purchase_orders
    (id, name, status, received_at, created_at, updated_at) VALUES (?, '쌀', ?, ?, ?, ?)`)
    .run(id, status, receivedAt, now, now);

  for (const id of ["purchase-confirmed", "purchase-received"]) {
    const response = await request(app).delete(`/api/purchase-orders/${id}`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, "PURCHASE_ORDER_LOCKED");
  }
  const draft = await request(app).delete("/api/purchase-orders/purchase-draft")
    .set("Authorization", `Bearer ${admin}`);
  assert.equal(draft.status, 200);
  assert.ok(db.prepare(
    "SELECT 1 FROM activity_logs WHERE entity_id='purchase-draft' AND action='purchase_order_deleted'"
  ).get());
});

test("관리자 UI는 연관 데이터를 함께 삭제하지 않고 안전한 확인과 서버 결과를 사용한다", () => {
  const root = path.join(__dirname, "..", "..");
  const inventory = fs.readFileSync(path.join(root, "js", "admin", "inventory.js"), "utf8");
  const events = fs.readFileSync(path.join(root, "js", "admin", "events.js"), "utf8");
  assert.doesNotMatch(inventory, /발주까지 함께 삭제|writePurchaseOrders\(.*filter/);
  assert.match(inventory, /신규 오입력 품목만 삭제/);
  assert.match(inventory, /apiFetchResult\(`\/inventory\//);
  assert.match(events, /초기 발주 요청을 영구 삭제/);
  assert.match(events, /apiFetchResult\(`\/purchase-orders\//);
  assert.match(events, /운영 주문은 결제 및 상태 이력 보호를 위해 삭제할 수 없습니다/);
  assert.doesNotMatch(events, /writeOrders\(.*filter\(\(.*\) => .*id/);
});

test("개별 삭제 검증은 BEGIN IMMEDIATE 안에서 수행하고 삭제 행 수를 검증한다", () => {
  const routes = ["orders.js", "inventory.js", "purchase-orders.js"].map((file) => ({
    file,
    source: fs.readFileSync(path.join(__dirname, "..", "routes", file), "utf8"),
  }));
  for (const { file, source } of routes) {
    const handler = source.slice(source.indexOf('router.delete("/:id"'), source.indexOf('router.delete("/", requireAuth'));
    assert.ok(handler.indexOf('db.exec("BEGIN IMMEDIATE")') < handler.indexOf('const current = db.prepare'), file);
    assert.match(handler, /if \(deleted\.changes !== 1\) throw new Error\("CONCURRENT_STATE_CHANGE"\)/, file);
    assert.ok(handler.indexOf("const current = db.prepare") < handler.indexOf('DELETE FROM'), file);
  }
});

test("차단 감사 로그 INSERT가 실패해도 원래 409·405와 데이터 보존을 유지한다", async () => {
  const admin = await token();
  const now = new Date().toISOString();
  insertOrder("blocked-log-order");
  db.prepare(`INSERT INTO payments (id, order_id, amount, status, requested_at)
    VALUES ('blocked-log-payment', 'blocked-log-order', 1000, 'DONE', ?)`).run(now);
  db.prepare(`INSERT INTO inventory
    (id, name, stock, unit, safe_stock, created_at, updated_at)
    VALUES ('blocked-log-inventory', '차단 로그 재고', 1, 'kg', 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO purchase_orders
    (id, name, status, created_at, updated_at)
    VALUES ('blocked-log-purchase', '차단 로그 발주', '입고완료', ?, ?)`).run(now, now);
  db.exec(`CREATE TEMP TRIGGER fail_blocked_delete_audit
    BEFORE INSERT ON activity_logs WHEN NEW.action='destructive_action_blocked'
    BEGIN SELECT RAISE(ABORT, 'forced blocked audit failure'); END;`);
  try {
    const requests = [
      ["/api/orders/blocked-log-order", 409],
      ["/api/orders", 405],
      ["/api/activity-logs", 405],
      ["/api/inventory/blocked-log-inventory", 409],
      ["/api/inventory/logs", 405],
      ["/api/inventory", 405],
      ["/api/purchase-orders/blocked-log-purchase", 409],
      ["/api/purchase-orders", 405],
    ];
    for (const [endpoint, status] of requests) {
      const response = await request(app).delete(endpoint).set("Authorization", `Bearer ${admin}`);
      assert.equal(response.status, status, endpoint);
      assert.doesNotMatch(JSON.stringify(response.body), /forced blocked audit failure|SQLITE|TRIGGER/);
    }
    assert.ok(db.prepare("SELECT 1 FROM orders WHERE id='blocked-log-order'").get());
    assert.ok(db.prepare("SELECT 1 FROM payments WHERE id='blocked-log-payment'").get());
    assert.ok(db.prepare("SELECT 1 FROM inventory WHERE id='blocked-log-inventory'").get());
    assert.ok(db.prepare("SELECT 1 FROM purchase_orders WHERE id='blocked-log-purchase'").get());
  } finally {
    db.exec("DROP TRIGGER fail_blocked_delete_audit");
  }
});

test("DELETE가 한 행을 삭제하지 못하면 허용 삭제도 rollback한다", async () => {
  const admin = await token();
  insertOrder("ignored-delete-order");
  db.exec(`CREATE TEMP TRIGGER ignore_order_delete
    BEFORE DELETE ON orders WHEN OLD.id='ignored-delete-order'
    BEGIN SELECT RAISE(IGNORE); END;`);
  try {
    const response = await request(app).delete("/api/orders/ignored-delete-order")
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(response.status, 500);
    assert.ok(db.prepare("SELECT 1 FROM orders WHERE id='ignored-delete-order'").get());
    assert.equal(db.prepare(
      "SELECT 1 FROM activity_logs WHERE entity_id='ignored-delete-order' AND action='order_deleted'"
    ).get(), undefined);
  } finally {
    db.exec("DROP TRIGGER ignore_order_delete");
  }
});
