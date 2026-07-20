process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "mypage-test-secret";
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_MODE = "none";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const { COOKIE_NAME, issueCustomerToken } = require("../middleware/customerAuth");

function cookie(userId) { return `${COOKIE_NAME}=${issueCustomerToken(userId)}`; }

function insertUser(id, password = "password123") {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user_accounts
    (id,username,email,password_hash,name,phone,status,terms_agreed_at,privacy_agreed_at,marketing_consent,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?,0,?,?)`)
    .run(id, id.replace(/-/g, "_"), `${id}@example.com`, bcrypt.hashSync(password, 4), `${id} 회원`, "01012345678", now, now, now, now);
  db.prepare(`INSERT INTO user_addresses
    (id,user_id,address_name,recipient_name,recipient_phone,postal_code,address,address_detail,is_default,created_at,updated_at)
    VALUES (?,?, '기본 배송지',?,?,?,?,?,1,?,?)`)
    .run(`addr-${id}`, id, `${id} 회원`, "01012345678", "18400", "경기도 화성시", "101호", now, now);
}

function insertOrder(id, userId, status = "접수대기") {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO orders
    (id,user_id,customer_name,customer_phone,fulfillment_type,pickup_date,pickup_time,subtotal,delivery_fee,total_amount,cost,status,logistics_status,created_at,updated_at)
    VALUES (?,?,?,?,'pickup','2099-12-31','14:00',3500,0,3500,0,?,'픽업대기',?,?)`)
    .run(id, userId, `${userId} 회원`, "01012345678", status, now, now);
  db.prepare(`INSERT INTO order_items (id,order_id,product_id,product_name,unit_price,quantity,line_total)
    VALUES (?,?, 'injeolmi','인절미',3500,1,3500)`).run(`item-${id}`, id);
}

insertUser("member-one");
insertUser("member-two");
insertOrder("member-one-order", "member-one");
insertOrder("member-two-order", "member-two");
insertOrder("preparing-order", "member-one", "준비중");

test("로그인 회원은 자신의 주문 목록과 상세만 조회한다", async () => {
  const list = await request(app).get("/api/users/me/orders").set("Cookie", cookie("member-one"));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.orders.map((order) => order.id).sort(), ["member-one-order", "preparing-order"]);
  assert.equal(list.body.orders[0].items[0].productName, "인절미");

  const own = await request(app).get("/api/users/me/orders/member-one-order").set("Cookie", cookie("member-one"));
  assert.equal(own.status, 200);
  const other = await request(app).get("/api/users/me/orders/member-two-order").set("Cookie", cookie("member-one"));
  assert.equal(other.status, 404);
});

test("다른 회원 주문 취소를 차단하고 접수대기 상태만 취소한다", async () => {
  const other = await request(app).post("/api/users/me/orders/member-two-order/cancel").set("Cookie", cookie("member-one"));
  assert.equal(other.status, 404);
  const preparing = await request(app).post("/api/users/me/orders/preparing-order/cancel").set("Cookie", cookie("member-one"));
  assert.equal(preparing.status, 409);
  const own = await request(app).post("/api/users/me/orders/member-one-order/cancel").set("Cookie", cookie("member-one"));
  assert.equal(own.status, 200);
  assert.equal(db.prepare("SELECT status FROM orders WHERE id='member-one-order'").get().status, "주문취소");
  assert.equal(db.prepare("SELECT changed_by FROM order_status_history WHERE order_id='member-one-order'").get().changed_by, "customer");
});

test("회원 정보와 기본 배송지는 본인 데이터만 수정한다", async () => {
  const profile = await request(app).patch("/api/users/me/profile").set("Cookie", cookie("member-one"))
    .send({ name: "새 이름", phone: "010-9999-8888", marketingConsent: true });
  assert.equal(profile.status, 200);
  assert.equal(db.prepare("SELECT name,marketing_consent FROM user_accounts WHERE id='member-one'").get().name, "새 이름");
  assert.equal(db.prepare("SELECT name FROM user_accounts WHERE id='member-two'").get().name, "member-two 회원");

  const address = await request(app).patch("/api/users/me/address").set("Cookie", cookie("member-one")).send({
    recipientName: "새 수령인", recipientPhone: "010-1111-2222", postalCode: "12345", address: "서울시 테스트구", addressDetail: "202호",
  });
  assert.equal(address.status, 200);
  const saved = db.prepare("SELECT * FROM user_addresses WHERE user_id='member-one'").get();
  assert.equal(saved.recipient_name, "새 수령인");
  assert.equal(saved.address, "서울시 테스트구");
});

test("현재 비밀번호 확인 후 비밀번호를 변경한다", async () => {
  const wrong = await request(app).post("/api/users/me/password").set("Cookie", cookie("member-one"))
    .send({ currentPassword: "wrong", newPassword: "newpassword123" });
  assert.equal(wrong.status, 400);
  const changed = await request(app).post("/api/users/me/password").set("Cookie", cookie("member-one"))
    .send({ currentPassword: "password123", newPassword: "newpassword123" });
  assert.equal(changed.status, 200);
  assert.equal(bcrypt.compareSync("newpassword123", db.prepare("SELECT password_hash FROM user_accounts WHERE id='member-one'").get().password_hash), true);
});

test("소셜 연결 상태를 세 제공자 기준으로 반환한다", async () => {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO social_identities (provider,provider_user_id,user_id,email,created_at) VALUES ('kakao','kakao-1','member-one','social@example.com',?)").run(now);
  const response = await request(app).get("/api/users/me/social-identities").set("Cookie", cookie("member-one"));
  assert.equal(response.status, 200);
  assert.equal(response.body.providers.length, 3);
  assert.equal(response.body.providers.find((item) => item.provider === "kakao").connected, true);
  assert.equal(response.body.providers.find((item) => item.provider === "google").connected, false);
});

test("진행 주문이 있으면 탈퇴를 막고, 정리 후 개인정보와 배송지를 삭제한다", async () => {
  const blocked = await request(app).delete("/api/users/me").set("Cookie", cookie("member-two")).send({ password: "password123" });
  assert.equal(blocked.status, 409);
  db.prepare("UPDATE orders SET status='주문취소' WHERE user_id='member-two'").run();
  const withdrawn = await request(app).delete("/api/users/me").set("Cookie", cookie("member-two")).send({ password: "password123" });
  assert.equal(withdrawn.status, 200);
  const user = db.prepare("SELECT * FROM user_accounts WHERE id='member-two'").get();
  assert.equal(user.status, "withdrawn");
  assert.equal(user.name, "탈퇴회원");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_addresses WHERE user_id='member-two'").get().count, 0);
});
