const db = require("../db");

const user = db.prepare("SELECT id, name, phone FROM user_accounts WHERE username = ?").get("portfolio_admin");
if (!user) throw new Error("portfolio_admin 계정을 찾을 수 없습니다.");

const products = db.prepare("SELECT id, name FROM products WHERE status = 'active' ORDER BY display_order LIMIT 3").all();
if (!products.length) throw new Error("문의 더미 데이터에 사용할 상품이 없습니다.");

const samples = [
  {
    id: "portfolio-member-inquiry-01", product: products[0], quantity: 60, desiredDate: "2026-08-18",
    photos: ["assets/products/menu-gift-box.png", "assets/products/menu-assorted-seolgi.png"],
    message: "부모님 생신 답례용으로 준비하려고 합니다. 개별 포장과 감사 문구 스티커를 함께 신청할 수 있을까요?",
    status: "답변완료", reply: "개별 포장과 감사 문구 스티커 모두 가능합니다. 원하시는 문구를 보내주시면 시안 확인 후 제작해 드리겠습니다.",
    createdAt: "2026-07-18T02:15:00.000Z", respondedAt: "2026-07-18T07:30:00.000Z",
  },
  {
    id: "portfolio-member-inquiry-02", product: products[1] || products[0], quantity: 100, desiredDate: "2026-08-25",
    photos: ["assets/products/menu-bulk-order.png", "assets/products/assorted-tteok.jpg", "assets/products/menu-songpyeon.png"],
    message: "회사 행사 간식으로 100개를 주문하면 오전 9시까지 배송이 가능한지 문의드립니다.",
    status: "접수", reply: null, createdAt: "2026-07-21T05:40:00.000Z", respondedAt: null,
  },
  {
    id: "portfolio-member-inquiry-03", product: products[2] || products[0], quantity: 40, desiredDate: "2026-08-02",
    photos: ["assets/products/menu-baekil.png"],
    message: "아이 돌잔치에 사용할 떡 구성을 두 종류로 나누고 싶습니다. 추천 구성이 있으면 안내 부탁드립니다.",
    status: "답변완료", reply: "백설기와 수수팥떡을 함께 구성하는 조합을 많이 선택하십니다. 인원과 예산에 맞춘 상세 구성을 연락처로 안내드리겠습니다.",
    createdAt: "2026-07-15T04:10:00.000Z", respondedAt: "2026-07-15T08:20:00.000Z",
  },
];

const insert = db.prepare(`INSERT INTO product_inquiries
  (id, product_id, product_name, customer_name, customer_phone, quantity, desired_date, message,
   status, created_at, admin_reply, responded_at, updated_at, user_id, photos_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

db.exec("BEGIN");
try {
  db.prepare("DELETE FROM product_inquiries WHERE id LIKE 'portfolio-member-inquiry-%'").run();
  for (const sample of samples) {
    insert.run(sample.id, sample.product.id, sample.product.name, user.name, user.phone, sample.quantity,
      sample.desiredDate, sample.message, sample.status, sample.createdAt, sample.reply,
      sample.respondedAt, sample.respondedAt || sample.createdAt, user.id, JSON.stringify(sample.photos || []));
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(`portfolio_admin 회원 문의 더미데이터 ${samples.length}건을 저장했습니다.`);
