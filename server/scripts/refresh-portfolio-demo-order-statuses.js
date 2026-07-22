const db = require("../db");

const DELIVERY_PROGRESS = ["결제완료", "접수완료", "상품준비중", "상품준비완료", "배송준비중", "배송중", "배송완료"];
const PICKUP_PROGRESS = ["결제완료", "접수완료", "상품준비중", "상품준비완료", "픽업준비중", "픽업준비완료", "픽업완료"];

const admin = db.prepare("SELECT id FROM user_accounts WHERE username = ?").get("portfolio_admin");
if (!admin?.id) {
  throw new Error("portfolio_admin 계정을 찾지 못했습니다.");
}

const orders = db.prepare(`
  SELECT id, fulfillment_type, created_at
  FROM orders
  WHERE id LIKE 'demo-sales-order-%' AND user_id = ?
  ORDER BY created_at ASC
`).all(admin.id);

if (!orders.length) {
  throw new Error("데모 주문이 없습니다. demo 주문 데이터(seed-admin-demo)부터 다시 생성해 주세요.");
}

const now = new Date().toISOString();
const insertHistory = db.prepare(`
  INSERT INTO order_status_history
  (id, order_id, previous_status, next_status, changed_by, created_at)
  VALUES (?, ?, ?, ?, 'system', ?)
`);
const deleteHistory = db.prepare("DELETE FROM order_status_history WHERE order_id = ?");
const updateOrder = db.prepare(`
  UPDATE orders
  SET status = ?, workflow_status = ?, payment_status = '결제완료', amount_status = 'confirmed', updated_at = ?
  WHERE id = ?
`);

db.exec("BEGIN");
try {
  for (let i = 0; i < orders.length; i += 1) {
    const order = orders[i];
    const progress = order.fulfillment_type === "delivery" ? DELIVERY_PROGRESS : PICKUP_PROGRESS;
    const targetIndex = (i % 6);
    const finalStatus = progress[targetIndex];

    updateOrder.run(finalStatus, finalStatus, now, order.id);
    deleteHistory.run(order.id);

    for (let step = 0; step <= targetIndex; step += 1) {
      const previous = step === 0 ? null : progress[step - 1];
      const next = progress[step];
      const createdAt = new Date(new Date(order.created_at).getTime() + step * 6 * 60 * 1000).toISOString();
      insertHistory.run(`history-${order.id}-${step + 1}`, order.id, previous, next, createdAt);
    }
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(`portfolio_admin 데모 주문 상태를 다양화했습니다. updated=${orders.length}`);
console.log("적용 대상:", orders.map((order) => `${order.id}(${order.fulfillment_type})`).join(", "));
