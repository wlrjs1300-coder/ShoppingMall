const db = require("../db");

if (process.env.NODE_ENV === "production") {
  throw new Error("운영 환경에서는 시연용 더미 데이터를 만들 수 없습니다.");
}

const admin = db.prepare("SELECT id FROM user_accounts WHERE username = 'portfolio_admin'").get();
if (!admin?.id) throw new Error("portfolio_admin 계정을 찾지 못했습니다.");

const hasProduct = db.prepare("SELECT COUNT(*) AS count FROM products LIMIT 1").get();
if (hasProduct?.count <= 0) throw new Error("상품 데이터가 없습니다.");

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
const insertHistory = db.prepare(`
  INSERT INTO order_status_history
    (id, order_id, previous_status, next_status, changed_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const deliverySampleProducts = [
  { productId: "songpyeon-sesame", productName: "깨송편", unitPrice: 4000 },
  { productId: "injeolmi", productName: "인절미", unitPrice: 3500 },
  { productId: "watermelon-seolgi", productName: "수박설기", unitPrice: 3000 },
  { productId: "honey-seolgi", productName: "꿀설기", unitPrice: 3500 },
  { productId: "chapssaltteok", productName: "찹쌀떡", unitPrice: 3500 },
  { productId: "mugwort-injeolmi", productName: "쑥인절미", unitPrice: 4000 },
];

const pickupSampleProducts = [
  { productId: "garaetteok", productName: "가래떡", unitPrice: 3500 },
  { productId: "mugwort-jeolpyeon", productName: "쑥절편", unitPrice: 3800 },
  { productId: "baekil", productName: "백일떡", unitPrice: 4300 },
  { productId: "yaksik", productName: "약식", unitPrice: 4000 },
  { productId: "gift-box", productName: "답례떡", unitPrice: 8000 },
];

const extendedOrders = [
  { status: "결제대기", fulfillmentType: "delivery", createdAt: "2026-07-15T09:12:00+09:00", address: "서울 강남구 선릉로 10", items: [{ ...deliverySampleProducts[0], quantity: 1 }, { ...deliverySampleProducts[1], quantity: 2 }] },
  { status: "결제완료", fulfillmentType: "pickup", createdAt: "2026-07-15T10:12:00+09:00", items: [{ ...pickupSampleProducts[0], quantity: 2 }] },
  { status: "접수완료", fulfillmentType: "delivery", createdAt: "2026-07-15T11:10:00+09:00", address: "서울 성동구 성수이로 3", items: [{ ...deliverySampleProducts[2], quantity: 1 }, { ...deliverySampleProducts[3], quantity: 1 }] },
  { status: "상품준비중", fulfillmentType: "pickup", createdAt: "2026-07-15T12:34:00+09:00", items: [{ ...pickupSampleProducts[1], quantity: 3 }, { ...pickupSampleProducts[2], quantity: 1 }] },
  { status: "상품준비완료", fulfillmentType: "delivery", createdAt: "2026-07-15T14:00:00+09:00", address: "서울 영등포구 영등포로 44", items: [{ ...deliverySampleProducts[4], quantity: 2 }, { ...deliverySampleProducts[5], quantity: 1 }] },
  { status: "배송준비중", fulfillmentType: "delivery", createdAt: "2026-07-14T13:00:00+09:00", address: "서울 중구 퇴계로 33", items: [{ ...deliverySampleProducts[0], quantity: 4 }] },
  { status: "배송중", fulfillmentType: "delivery", createdAt: "2026-07-14T12:50:00+09:00", address: "부산 해운대구 센텀로 15", items: [{ ...deliverySampleProducts[4], quantity: 4 }] },
  { status: "배송완료", fulfillmentType: "delivery", createdAt: "2026-07-14T15:25:00+09:00", address: "서울 서초구 강남대로 100", items: [{ ...deliverySampleProducts[2], quantity: 1 }, { ...deliverySampleProducts[5], quantity: 1 }, { ...deliverySampleProducts[1], quantity: 1 }] },
  { status: "픽업준비중", fulfillmentType: "pickup", createdAt: "2026-07-14T16:10:00+09:00", items: [{ ...pickupSampleProducts[1], quantity: 2 }, { ...pickupSampleProducts[2], quantity: 1 }] },
  { status: "상품준비완료", fulfillmentType: "pickup", createdAt: "2026-07-14T10:40:00+09:00", items: [{ ...pickupSampleProducts[3], quantity: 1 }, { ...pickupSampleProducts[4], quantity: 1 }] },
  { status: "픽업준비완료", fulfillmentType: "pickup", createdAt: "2026-07-13T09:55:00+09:00", items: [{ ...pickupSampleProducts[2], quantity: 2 }, { ...pickupSampleProducts[0], quantity: 1 }] },
  { status: "픽업완료", fulfillmentType: "pickup", createdAt: "2026-07-13T11:30:00+09:00", items: [{ ...pickupSampleProducts[3], quantity: 4 }] },
  { status: "취소", fulfillmentType: "delivery", createdAt: "2026-07-13T10:20:00+09:00", address: "서울 중랑구 망우로 8", items: [{ ...deliverySampleProducts[2], quantity: 1 }, { ...deliverySampleProducts[3], quantity: 1 }] },
  { status: "배송완료", fulfillmentType: "delivery", createdAt: "2026-07-12T18:20:00+09:00", address: "제주 제주시 중앙로 20", items: [{ ...deliverySampleProducts[0], quantity: 1 }, { ...deliverySampleProducts[1], quantity: 1 }, { ...deliverySampleProducts[2], quantity: 1 }] },
  { status: "상품준비완료", fulfillmentType: "pickup", createdAt: "2026-07-12T09:30:00+09:00", items: [{ ...pickupSampleProducts[2], quantity: 1 }, { ...pickupSampleProducts[4], quantity: 1 }] },
  { status: "배송중", fulfillmentType: "delivery", createdAt: "2026-07-12T16:40:00+09:00", address: "부산 남구 대연동 11", items: [{ ...deliverySampleProducts[4], quantity: 2 }, { ...deliverySampleProducts[5], quantity: 1 }] },
  { status: "픽업준비완료", fulfillmentType: "pickup", createdAt: "2026-07-12T14:10:00+09:00", items: [{ ...pickupSampleProducts[0], quantity: 1 }, { ...pickupSampleProducts[2], quantity: 2 }] },
  { status: "결제완료", fulfillmentType: "delivery", createdAt: "2026-07-11T15:15:00+09:00", address: "서울 용산구 이태원로 3", items: [{ ...deliverySampleProducts[3], quantity: 1 }, { ...deliverySampleProducts[4], quantity: 1 }] },
];

const DELAYED_STATUS_FLOW = ["결제완료", "접수완료", "상품준비중", "상품준비완료", "배송준비중", "배송중", "배송완료"];
const PICKUP_STATUS_FLOW = ["결제완료", "접수완료", "상품준비완료", "픽업준비완료", "픽업완료"];

const deleted = db.prepare("DELETE FROM orders WHERE id LIKE 'demo-status-all-%'").run();
const deletedItems = db.prepare("DELETE FROM order_items WHERE order_id LIKE 'demo-status-all-%'").run();
const deletedHistory = db.prepare("DELETE FROM order_status_history WHERE order_id LIKE 'demo-status-all-%'").run();

extendedOrders.forEach((sample, index) => {
  const id = `demo-status-all-${String(index + 1).padStart(2, "0")}`;
  const createdAt = new Date(sample.createdAt).toISOString();
  const flow = sample.fulfillmentType === "pickup" ? PICKUP_STATUS_FLOW : DELAYED_STATUS_FLOW;
  const finalStatus = sample.status;
  const statusIndex = flow.indexOf(finalStatus);

  const subtotal = sample.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const deliveryFee = sample.fulfillmentType === "delivery" ? 3500 : 0;
  const totalAmount = subtotal + deliveryFee;
  const customer = `${sample.status} 주문 - ${sample.fulfillmentType === "pickup" ? "픽업" : "배송"}`;
  const phone = `010-9${String(index + 1).padStart(2, "0")}-${String((3100 + index * 137) % 10000).padStart(4, "0")}`;
  const payment = finalStatus === "결제대기" ? "결제대기" : finalStatus === "취소" ? "결제취소" : "결제완료";
  const amountStatus = finalStatus === "결제대기" ? "pending" : "confirmed";
  const logisticsStatus = sample.fulfillmentType === "delivery"
    ? (statusIndex >= 4 ? "배송중" : "배송준비중")
    : (statusIndex >= 2 ? "픽업준비완료" : "픽업준비중");
  const pickupDate = new Date(new Date(createdAt).getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pickupTime = sample.fulfillmentType === "delivery" ? "14:00" : "17:00";

  insertOrder.run(
    id,
    admin.id,
    customer,
    phone,
    sample.fulfillmentType,
    sample.fulfillmentType === "delivery" ? sample.address : null,
    pickupDate,
    pickupTime,
    subtotal,
    deliveryFee,
    totalAmount,
    Math.round(subtotal * 0.58),
    finalStatus,
    payment,
    amountStatus,
    finalStatus,
    logisticsStatus,
    `${sample.status} 상태 확인용 더미`,
    "일반",
    "선물박스",
    createdAt,
    createdAt,
  );

  sample.items.forEach((item, itemIndex) => {
    insertItem.run(
      `demo-status-all-item-${String(index + 1).padStart(2, "0")}-${String(itemIndex + 1)}`,
      id,
      item.productId,
      item.productName,
      item.unitPrice,
      item.quantity,
      item.unitPrice * item.quantity,
    );
  });

  const steps = statusIndex >= 0 ? flow.slice(0, statusIndex + 1) : [finalStatus];
  steps.forEach((nextStatus, stepIndex) => {
    const previousStatus = stepIndex === 0 ? null : steps[stepIndex - 1];
    const historyAt = new Date(new Date(createdAt).getTime() + stepIndex * 8 * 60 * 1000).toISOString();
    insertHistory.run(
      `demo-status-all-history-${String(index + 1).padStart(2, "0")}-${String(stepIndex + 1)}`,
      id,
      previousStatus,
      nextStatus,
      "system",
      historyAt,
    );
  });
});

console.log(`상태별 주문 더미 등록 완료: ${extendedOrders.length}건`);
console.log({
  deletedOrders: deleted.changes,
  deletedItems: deletedItems.changes,
  deletedHistory: deletedHistory.changes,
});
