const db = require("../db");

const inquirySamples = [
  ["gift-box", "김서연", "010-2458-7312", 80, "2026-07-25", "답례떡 80개를 개별 포장으로 주문하고 싶습니다. 스티커 문구와 포장 구성을 상담받고 싶어요.", "접수"],
  ["baekil", "이준호", "010-9182-4407", 120, "2026-08-02", "백일 행사에 사용할 백일떡 세트의 배송 가능 지역과 예상 금액을 알고 싶습니다.", "접수"],
  ["bulk-order", "한빛어린이집", "010-3671-9024", 200, "2026-07-29", "원내 행사 간식으로 200개가 필요합니다. 알레르기 성분과 개별 포장 가능 여부를 확인해 주세요.", "답변완료"],
  ["songpyeon-reserve", "박지민", "010-5520-1846", 50, "2026-09-20", "추석 송편 예약 가능 일정과 깨·콩 반반 구성 가능 여부가 궁금합니다.", "접수"],
  ["susupat", "최유진", "010-7743-2915", 40, "2026-08-08", "수수팥떡 40개를 오전 10시 이전에 픽업할 수 있는지 확인 부탁드립니다.", "접수"],
  ["gift-box", "정민서", "010-6308-4421", 150, "2026-08-15", "회사 창립기념 답례품입니다. 로고 스티커 제작과 보자기 포장 견적을 받고 싶습니다.", "접수"],
  ["baekil", "오하늘", "010-1823-6659", 60, "2026-07-31", "백일떡 구성 비율을 조정할 수 있는지와 서울 지역 배송 여부를 문의합니다.", "답변완료"],
  ["bulk-order", "새봄복지관", "010-4097-8136", 300, "2026-08-22", "지역 행사 배부용 300개 주문 시 구성과 대량 주문 할인을 안내해 주세요.", "접수"],
  ["garaetteok", "윤가람", "010-3365-1728", 35, "2026-07-28", "가래떡 35팩을 선물 포장할 경우 보관 방법과 소비기한이 궁금합니다.", "답변완료"],
  ["chapssaltteok", "정다운", "010-8274-5306", 90, "2026-08-05", "찹쌀떡 90개 배송 주문 시 아이스 포장 비용과 도착 가능 시간을 알려주세요.", "접수"],
];

const salesSamples = [
  ["2026-07-10", "송편 예약", "songpyeon-reserve", 20, 4000, "강민지", "010-2101-1001", "pickup"],
  ["2026-07-11", "인절미", "injeolmi", 32, 3500, "윤서준", "010-2101-1002", "delivery"],
  ["2026-07-12", "흰절편", "white-jeolpyeon", 40, 3500, "이수빈", "010-2101-1003", "pickup"],
  ["2026-07-13", "쑥인절미", "mugwort-injeolmi", 24, 3800, "박지후", "010-2101-1004", "delivery"],
  ["2026-07-14", "약식", "yaksik", 18, 4000, "김하린", "010-2101-1005", "pickup"],
  ["2026-07-15", "찹쌀떡", "chapssaltteok", 30, 3500, "최도윤", "010-2101-1006", "delivery"],
  ["2026-07-16", "꿀설기", "honey-seolgi", 36, 3500, "정유나", "010-2101-1007", "pickup"],
  ["2026-07-17", "깨송편", "songpyeon-sesame", 28, 4000, "한지민", "010-2101-1008", "delivery"],
  ["2026-07-18", "가래떡", "garaetteok", 25, 3500, "오세훈", "010-2101-1009", "pickup"],
  ["2026-07-19", "쑥절편", "mugwort-jeolpyeon", 22, 4000, "송예린", "010-2101-1010", "delivery"],
];

const logSamples = [
  ["문의", "답례떡 문의가 새로 접수되었습니다.", "inquiries", "문의 접수", "demo-inquiry-01", null, "접수"],
  ["주문", "ORD-DEMO-1001 주문의 결제가 완료되었습니다.", "orders", "결제 확인", "demo-sales-order-01", "결제대기", "결제완료"],
  ["주문", "ORD-DEMO-1002 주문을 접수 완료로 변경했습니다.", "orders", "상태 변경", "demo-sales-order-02", "접수대기", "접수완료"],
  ["생산", "인절미 32개 생산 준비를 시작했습니다.", "production", "생산 시작", "demo-sales-order-02", "생산대기", "생산중"],
  ["재고", "멥쌀가루 재고 10kg를 입고 처리했습니다.", "inventory", "재고 입고", "rice-flour", "24kg", "34kg"],
  ["발주", "팥앙금 8kg 발주를 요청했습니다.", "inventory", "발주 요청", "red-bean-paste", "발주 전", "발주중"],
  ["문의", "백일떡 문의에 답변을 등록했습니다.", "inquiries", "문의 답변", "demo-inquiry-02", "접수", "답변완료"],
  ["주문", "ORD-DEMO-1007 주문의 픽업 준비가 완료되었습니다.", "orders", "상태 변경", "demo-sales-order-07", "접수완료", "픽업준비완료"],
  ["배송", "ORD-DEMO-1008 주문이 배송중으로 변경되었습니다.", "orders", "배송 상태 변경", "demo-sales-order-08", "접수완료", "배송중"],
  ["고객", "고객 메모를 수정했습니다.", "customers", "메모 수정", "demo-customer-01", "", "재주문 시 오전 연락 요청"],
];

const productName = db.prepare("SELECT name FROM products WHERE id = ?");
const insertInquiry = db.prepare(`INSERT INTO product_inquiries
  (id, product_id, product_name, customer_name, customer_phone, quantity, desired_date, message, status, created_at, admin_reply, admin_memo, responded_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertOrder = db.prepare(`INSERT INTO orders
  (id, user_id, customer_name, customer_phone, fulfillment_type, delivery_address, pickup_date, pickup_time,
   subtotal, delivery_fee, total_amount, cost, status, payment_status, amount_status, workflow_status,
   logistics_status, memo, production_status, packaging_type, created_at, updated_at)
  VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertItem = db.prepare(`INSERT INTO order_items
  (id, order_id, product_id, product_name, unit_price, quantity, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const insertLog = db.prepare(`INSERT INTO activity_logs
  (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

db.exec("BEGIN");
try {
  db.prepare("DELETE FROM product_inquiries WHERE id LIKE 'demo-inquiry-%'").run();
  db.prepare("DELETE FROM orders WHERE id LIKE 'demo-sales-order-%'").run();
  db.prepare("DELETE FROM activity_logs WHERE id LIKE 'demo-activity-%'").run();

  inquirySamples.forEach(([productId, customer, phone, quantity, desiredDate, message, status], index) => {
    const id = `demo-inquiry-${String(index + 1).padStart(2, "0")}`;
    const createdAt = new Date(`2026-07-${String(19 - Math.floor(index / 2)).padStart(2, "0")}T0${index % 9}:20:00+09:00`).toISOString();
    const isAnswered = status === "답변완료";
    insertInquiry.run(id, productId, productName.get(productId)?.name || productId, customer, phone, quantity,
      desiredDate, message, status, createdAt, isAnswered ? "문의하신 일정과 구성으로 준비 가능합니다. 상세 견적은 유선으로 안내드리겠습니다." : null,
      null, isAnswered ? createdAt : null, createdAt);
  });

  salesSamples.forEach(([date, name, productId, quantity, unitPrice, customer, phone, fulfillment], index) => {
    const number = String(index + 1).padStart(2, "0");
    const id = `demo-sales-order-${number}`;
    const subtotal = unitPrice * quantity;
    const deliveryFee = fulfillment === "delivery" ? 3500 : 0;
    const total = subtotal + deliveryFee;
    const createdAt = new Date(`${date}T10:30:00+09:00`).toISOString();
    const completedStatus = fulfillment === "delivery" ? "배송완료" : "픽업완료";
    insertOrder.run(id, customer, phone, fulfillment, fulfillment === "delivery" ? "서울특별시 마포구 월드컵로 10" : null,
      date, fulfillment === "delivery" ? "14:00" : "16:00", subtotal, deliveryFee, total, Math.round(subtotal * 0.58),
      completedStatus, "결제완료", "confirmed", completedStatus, completedStatus, "포트폴리오 매출 화면 확인용 주문",
      "생산완료", "기본 포장", createdAt, createdAt);
    insertItem.run(`demo-sales-item-${number}`, id, productId, name, unitPrice, quantity, subtotal);
  });

  logSamples.forEach(([category, message, tab, action, entityId, previous, next], index) => {
    const createdAt = new Date(`2026-07-${String(19 - Math.floor(index / 3)).padStart(2, "0")}T${String(18 - index).padStart(2, "0")}:10:00+09:00`).toISOString();
    insertLog.run(`demo-activity-${String(index + 1).padStart(2, "0")}`, category, message, tab, action,
      entityId, previous, next, "관리자", createdAt);
  });
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log("관리자 화면용 데모 데이터를 저장했습니다.");
console.table([
  { section: "문의관리", demoRows: db.prepare("SELECT COUNT(*) count FROM product_inquiries WHERE id LIKE 'demo-inquiry-%'").get().count },
  { section: "매출관리", demoRows: db.prepare("SELECT COUNT(*) count FROM orders WHERE id LIKE 'demo-sales-order-%'").get().count },
  { section: "로그관리", demoRows: db.prepare("SELECT COUNT(*) count FROM activity_logs WHERE id LIKE 'demo-activity-%'").get().count },
]);
