const crypto = require("crypto");
const db = require("../db");

const samples = [
  ["gift-box", "김서연", "01024587312", 80, "2026-07-25", "돌잔치 답례떡 80개를 개별 포장으로 주문하고 싶습니다. 스티커 문구와 포장 구성 상담 부탁드립니다.", "접수", "", ""],
  ["baekil", "이준호", "01091824407", 120, "2026-08-02", "백일 행사에 사용할 백일떡 세트 구성을 문의드립니다. 배송 가능 지역과 예상 금액도 함께 알려주세요.", "접수", "", "배송 지역 확인 후 전화 안내 예정"],
  ["bulk-order", "한빛어린이집", "01036719024", 200, "2026-07-29", "원내 행사 간식으로 아이들이 먹기 좋은 떡 200개가 필요합니다. 알레르기 성분과 낱개 포장 가능 여부가 궁금합니다.", "답변완료", "낱개 포장이 가능하며 견과류 제외 구성으로 준비할 수 있습니다. 정확한 구성과 배송 시간은 유선으로 안내드리겠습니다.", ""],
  ["songpyeon-reserve", "박지민", "01055201846", 50, "2026-09-20", "추석 송편 예약은 언제부터 가능한가요? 깨와 콩 송편을 반반 구성하고 싶습니다.", "접수", "", "추석 예약 일정 확정 후 안내"],
  ["susupat", "최유진", "01077432915", 40, "2026-08-08", "수수팥떡 40개를 오전 10시 이전에 픽업하고 싶습니다. 가능한지 확인 부탁드립니다.", "접수", "", ""],
  ["gift-box", "정민서", "01063084421", 150, "2026-08-15", "회사 창립기념 답례품으로 준비하려고 합니다. 로고 스티커 제작과 보자기 포장 견적을 받고 싶습니다.", "접수", "", "로고 원본 파일 요청 필요"],
  ["baekil", "오하늘", "01018236659", 60, "2026-07-31", "백일떡 구성 중 백설기와 수수팥떡 비율을 조정할 수 있을까요? 서울 지역 퀵 배송도 문의드립니다.", "답변완료", "구성 비율은 자유롭게 조정 가능하며 서울 지역 퀵 배송도 가능합니다. 세부 견적을 문자로 보내드렸습니다.", ""],
  ["bulk-order", "새봄복지관", "01040978136", 300, "2026-08-22", "지역 행사 배부용 떡 300개 문의드립니다. 예산에 맞는 제품 구성과 대량 주문 할인 여부를 안내해 주세요.", "접수", "", ""],
];

const product = db.prepare("SELECT name FROM products WHERE id = ?");
const insert = db.prepare(`INSERT INTO product_inquiries
  (id, product_id, product_name, customer_name, customer_phone, quantity, desired_date, message, status, created_at, admin_reply, admin_memo, responded_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

db.exec("BEGIN");
try {
  db.prepare("DELETE FROM product_inquiries WHERE id LIKE 'demo-inquiry-%' OR customer_name LIKE '%?%'").run();
  samples.forEach(([productId, customer, phone, quantity, desiredDate, message, status, reply, memo], index) => {
    const createdAt = new Date(Date.now() - index * 5 * 60 * 60 * 1000).toISOString();
    insert.run(
      `demo-inquiry-${crypto.randomUUID()}`,
      productId,
      product.get(productId).name,
      customer,
      phone,
      quantity,
      desiredDate,
      message,
      status,
      createdAt,
      reply || null,
      memo || null,
      status === "답변완료" ? createdAt : null,
      createdAt,
    );
  });
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const result = db.prepare("SELECT status, COUNT(*) AS count FROM product_inquiries GROUP BY status ORDER BY status").all();
console.log(`문의 더미 데이터 ${samples.length}건을 저장했습니다.`);
console.table(result);
