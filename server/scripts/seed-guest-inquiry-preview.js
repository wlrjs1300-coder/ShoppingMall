const db = require("../db");

const id = "inquiry-demo-guest-20260722";
const phone = "01048271635";
const pendingId = "inquiry-demo-pending-20260722";
const pendingPhone = "01073529418";
const product = db.prepare("SELECT id, name FROM products WHERE id = 'gift-box' AND status = 'active'").get()
  || db.prepare("SELECT id, name FROM products WHERE status = 'active' ORDER BY display_order LIMIT 1").get();

if (!product) throw new Error("문의 더미 데이터에 사용할 판매 상품이 없습니다.");

const createdAt = "2026-07-22T01:20:00.000Z";
const respondedAt = "2026-07-22T05:40:00.000Z";

db.prepare("DELETE FROM product_inquiries WHERE id = ?").run(id);
db.prepare("DELETE FROM product_inquiries WHERE id = ?").run(pendingId);
db.prepare(`INSERT INTO product_inquiries
  (id, product_id, product_name, customer_name, customer_phone, quantity, desired_date,
   message, status, created_at, admin_reply, admin_memo, responded_at, updated_at, user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
  .run(
    id,
    product.id,
    product.name,
    "김다정",
    phone,
    80,
    "2026-08-15",
    "회사 창립기념일 답례품으로 준비하려고 합니다. 개별 포장 80개와 보자기 포장 10개가 필요하며, 스티커에 회사 로고를 넣을 수 있는지 문의드립니다. 8월 15일 오전까지 배송받고 싶습니다.",
    "답변완료",
    createdAt,
    "문의해 주셔서 감사합니다. 개별 포장과 보자기 포장 모두 가능하며, 회사 로고 스티커도 함께 제작해 드릴 수 있습니다. 희망하신 8월 15일 오전 배송 일정으로 준비 가능하며, 상세 구성과 최종 견적은 입력해 주신 연락처로 안내드리겠습니다.",
    "비회원 문의조회 UI 확인용 더미 데이터",
    respondedAt,
    respondedAt,
  );

db.prepare("UPDATE product_inquiries SET photos_json = ? WHERE id = ?")
  .run(JSON.stringify([
    "assets/products/menu-gift-box.png",
    "assets/products/menu-assorted-seolgi.png",
    "assets/products/menu-songpyeon.png",
  ]), id);

db.prepare(`INSERT INTO product_inquiries
  (id, product_id, product_name, customer_name, customer_phone, quantity, desired_date,
   message, status, created_at, admin_reply, admin_memo, responded_at, updated_at, user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL)`)
  .run(
    pendingId,
    product.id,
    product.name,
    "이하늘",
    pendingPhone,
    50,
    "2026-08-08",
    "돌잔치 답례떡 50개를 준비하려고 합니다. 떡 종류를 두 가지로 구성할 수 있는지와 개별 포장에 감사 문구 스티커를 추가할 수 있는지 궁금합니다.",
    "접수",
    "2026-07-22T06:30:00.000Z",
    "답변 대기 상태 UI 확인용 더미 데이터",
    "2026-07-22T06:30:00.000Z",
  );

console.log(JSON.stringify({
  answered: { id, phone, productName: product.name, status: "답변완료" },
  pending: { id: pendingId, phone: pendingPhone, productName: product.name, status: "접수" },
}, null, 2));
