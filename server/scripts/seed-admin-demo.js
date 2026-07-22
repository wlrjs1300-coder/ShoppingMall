const db = require("../db");

if (process.env.NODE_ENV === "production") {
  throw new Error("운영 환경에서는 데모 데이터 주입을 허용하지 않습니다.");
}

const admin = db.prepare("SELECT id FROM user_accounts WHERE username = 'portfolio_admin'").get();
const demoUserId = admin?.id || null;

const inquirySamples = [
  ["gift-box", "김현수", "010-2458-7312", 80, "2026-07-25", "다음 주 행사용으로 80개 문의드립니다.", "답변완료"],
  ["baekil", "정유진", "010-9182-4407", 120, "2026-08-02", "일정 변경 요청드립니다.", "처리완료"],
  ["bulk-order", "박민수", "010-3671-9024", 200, "2026-07-29", "대량 주문 가능할지 확인 부탁드려요.", "처리중"],
  ["songpyeon-reserve", "최서연", "010-5520-1846", 50, "2026-09-20", "명절 선물용으로 50개 문의합니다.", "답변완료"],
];

const salesSamples = [
  ["2026-07-10", "첫번째 샘플", "songpyeon-reserve", 20, 4000, "홍길동", "010-2101-1001", "pickup"],
  ["2026-07-11", "두번째 샘플", "injeolmi", 32, 3500, "김철수", "010-2101-1002", "delivery"],
  ["2026-07-12", "세번째 샘플", "white-jeolpyeon", 40, 3500, "박민영", "010-2101-1003", "pickup"],
  ["2026-07-13", "네번째 샘플", "mugwort-injeolmi", 24, 3800, "강보람", "010-2101-1004", "delivery"],
  ["2026-07-14", "다섯번째 샘플", "yaksik", 18, 4000, "이미진", "010-2101-1005", "pickup"],
  ["2026-07-15", "여섯번째 샘플", "chapssaltteok", 30, 3500, "김가람", "010-2101-1006", "delivery"],
  ["2026-07-16", "일곱번째 샘플", "honey-seolgi", 36, 3500, "윤서영", "010-2101-1007", "pickup"],
  ["2026-07-17", "여덟번째 샘플", "songpyeon-sesame", 28, 4000, "한예슬", "010-2101-1008", "delivery"],
  ["2026-07-18", "아홉번째 샘플", "garaetteok", 25, 3500, "김성진", "010-2101-1009", "pickup"],
  ["2026-07-19", "열번째 샘플", "mugwort-jeolpyeon", 22, 4000, "임다솜", "010-2101-1010", "delivery"],
];

const logSamples = [
  ["문의", "ORD-DEMO-1001 주문 접수 처리", "orders", "주문 접수", "demo-sales-order-01", null, "처리완료"],
  ["주문", "ORD-DEMO-1002 결제 완료 처리", "orders", "상태 변경", "demo-sales-order-02", null, "결제완료"],
  ["주문", "ORD-DEMO-1003 상품 준비 시작", "orders", "상태 변경", "demo-sales-order-03", null, "상품준비중"],
];

const productName = db.prepare("SELECT name FROM products WHERE id = ?");
const insertInquiry = db.prepare(`
  INSERT INTO product_inquiries
    (id, product_id, product_name, customer_name, customer_phone, quantity, desired_date, message, status, created_at, admin_reply, admin_memo, responded_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertOrder = db.prepare(`
  INSERT INTO orders
    (id, user_id, customer_name, customer_phone, fulfillment_type, delivery_address, pickup_date, pickup_time,
     subtotal, delivery_fee, total_amount, cost, status, payment_status, amount_status, workflow_status,
     logistics_status, memo, production_status, packaging_type, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertItem = db.prepare(`
  INSERT INTO order_items
    (id, order_id, product_id, product_name, unit_price, quantity, line_total)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertLog = db.prepare(`
  INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertHistory = db.prepare(`
  INSERT INTO order_status_history
    (id, order_id, previous_status, next_status, changed_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const DELIVERY_FLOW = ["결제완료", "접수완료", "상품준비중", "상품준비완료", "배송준비중", "배송중", "배송완료"];
const PICKUP_FLOW = ["결제완료", "접수완료", "상품준비중", "상품준비완료", "픽업준비중", "픽업준비완료", "픽업완료"];

db.exec("BEGIN");
try {
  db.prepare("DELETE FROM product_inquiries WHERE id LIKE 'demo-inquiry-%'").run();
  db.prepare("DELETE FROM orders WHERE id LIKE 'demo-sales-order-%'").run();
  db.prepare("DELETE FROM activity_logs WHERE id LIKE 'demo-activity-%'").run();

  inquirySamples.forEach(([productId, customer, phone, quantity, desiredDate, message, status], index) => {
    const id = `demo-inquiry-${String(index + 1).padStart(2, "0")}`;
    const createdAt = new Date(`2026-07-${String(19 - index).padStart(2, "0")}T0${Math.min(index, 8)}:20:00+09:00`).toISOString();
    const answered = status === "처리완료";
    insertInquiry.run(
      id,
      productId,
      productName.get(productId)?.name || productId,
      customer,
      phone,
      quantity,
      desiredDate,
      message,
      status,
      createdAt,
      answered ? "문의 확인 후 처리했습니다." : null,
      null,
      answered ? createdAt : null,
      createdAt,
    );
  });

  salesSamples.forEach(([date, name, productId, quantity, unitPrice, customer, phone, fulfillment], index) => {
    const number = String(index + 1).padStart(2, "0");
    const id = `demo-sales-order-${number}`;
    const subtotal = unitPrice * quantity;
    const deliveryFee = fulfillment === "delivery" ? 3500 : 0;
    const total = subtotal + deliveryFee;
    const createdAt = new Date(`${date}T10:30:00+09:00`).toISOString();
    const flow = fulfillment === "delivery" ? DELIVERY_FLOW : PICKUP_FLOW;
    const finalStatus = flow[index % flow.length];
    const logisticsStatus = fulfillment === "delivery" ? "배송준비중" : "픽업준비중";

    insertOrder.run(
      id,
      demoUserId,
      customer,
      phone,
      fulfillment,
      fulfillment === "delivery" ? "서울시 강남구 데모주소 10" : null,
      date,
      fulfillment === "delivery" ? "14:00" : "16:00",
      subtotal,
      deliveryFee,
      total,
      Math.round(subtotal * 0.58),
      finalStatus,
      "결제완료",
      "confirmed",
      finalStatus,
      logisticsStatus,
      "데모 주문 메모",
      "생산완료",
      "일반 포장",
      createdAt,
      createdAt,
    );
    insertItem.run(`demo-sales-item-${number}`, id, productId, name, unitPrice, quantity, subtotal);

    const steps = flow.slice(0, index % flow.length + 1);
    steps.forEach((nextStatus, stepIndex) => {
      const previousStatus = stepIndex === 0 ? null : steps[stepIndex - 1];
      const historyAt = new Date(new Date(createdAt).getTime() + stepIndex * 6 * 60 * 1000).toISOString();
      insertHistory.run(`demo-history-${id}-${String(stepIndex + 1).padStart(2, "0")}`, id, previousStatus, nextStatus, "system", historyAt);
    });
  });

  logSamples.forEach(([category, message, tab, action, entityId], index) => {
    const createdAt = new Date(`2026-07-${String(19 - index).padStart(2, "0")}T${String(10 + index).padStart(2, "0")}:10:00+09:00`).toISOString();
    insertLog.run(`demo-activity-${String(index + 1).padStart(2, "0")}`, category, message, tab, action, entityId, null, "완료", "관리자", createdAt);
  });

  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log("포트폴리오 데모 주문 데이터를 상태 다양화 기준으로 생성했습니다.");
console.table([
  { section: "문의", rows: db.prepare("SELECT COUNT(*) count FROM product_inquiries WHERE id LIKE 'demo-inquiry-%'").get().count },
  { section: "주문", rows: db.prepare("SELECT COUNT(*) count FROM orders WHERE id LIKE 'demo-sales-order-%'").get().count },
  { section: "히스토리", rows: db.prepare("SELECT COUNT(*) count FROM order_status_history WHERE order_id LIKE 'demo-sales-order-%'").get().count },
]);

