process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-inquiries-tests-only";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../index");
const db = require("../db");

const validInquiry = {
  productId: "baekil",
  customer: "문의 고객",
  phone: "010-1234-5678",
  quantity: 20,
  desiredDate: "2027-01-15",
  message: "행사용 포장 구성을 문의합니다.",
  agreePrivacy: "on",
};

test("비회원도 상품 문의를 접수할 수 있다", async () => {
  const response = await request(app).post("/api/inquiries").send(validInquiry);
  assert.equal(response.status, 201);
  assert.match(response.body.id, /^inquiry-/);

  const saved = db.prepare("SELECT * FROM product_inquiries WHERE id = ?").get(response.body.id);
  assert.equal(saved.product_id, validInquiry.productId);
  assert.equal(saved.customer_phone, "01012345678");
  assert.equal(saved.quantity, 20);
});

test("개인정보 동의가 없으면 문의를 접수하지 않는다", async () => {
  const response = await request(app).post("/api/inquiries").send({ ...validInquiry, agreePrivacy: undefined });
  assert.equal(response.status, 400);
});

test("존재하지 않는 상품 문의를 접수하지 않는다", async () => {
  const response = await request(app).post("/api/inquiries").send({ ...validInquiry, productId: "missing-product" });
  assert.equal(response.status, 404);
});

test("문의 목록은 관리자 인증 없이 조회할 수 없다", async () => {
  const response = await request(app).get("/api/inquiries");
  assert.equal(response.status, 401);
});

test("메뉴 문의 버튼과 전용 문의 페이지가 연결되어 있다", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "../..");
  const menuOrder = fs.readFileSync(path.join(root, "js/menu-order.js"), "utf8");
  const menuPage = fs.readFileSync(path.join(root, "menu.html"), "utf8");
  const inquiryPage = fs.readFileSync(path.join(root, "inquiry.html"), "utf8");
  assert.doesNotMatch(menuOrder, /문의 남기기/);
  assert.doesNotMatch(menuPage, /문의 남기기/);
  assert.match(menuOrder, /inquiry\.html\?product=/);
  assert.match(inquiryPage, /data-inquiry-form/);
  assert.match(inquiryPage, /name="agreePrivacy"/);
});

test("관리자는 문의 답변과 처리 상태를 저장할 수 있다", async () => {
  const created = await request(app).post("/api/inquiries").send(validInquiry);
  const login = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE });
  const response = await request(app)
    .patch(`/api/inquiries/${created.body.id}`)
    .set("Authorization", `Bearer ${login.body.token}`)
    .send({ status: "답변완료", adminReply: "요청하신 날짜에 준비할 수 있습니다.", adminMemo: "전화 안내 완료" });
  assert.equal(response.status, 200);
  assert.equal(response.body.inquiry.status, "답변완료");
  assert.equal(response.body.inquiry.admin_reply, "요청하신 날짜에 준비할 수 있습니다.");
  assert.ok(response.body.inquiry.responded_at);
});

test("답변 없이 문의를 답변완료 처리할 수 없다", async () => {
  const created = await request(app).post("/api/inquiries").send(validInquiry);
  const login = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE });
  const response = await request(app)
    .patch(`/api/inquiries/${created.body.id}`)
    .set("Authorization", `Bearer ${login.body.token}`)
    .send({ status: "답변완료", adminReply: "" });
  assert.equal(response.status, 400);
});

test("관리자 페이지에 주문관리 바로 다음 문의관리 탭과 상세 화면이 연결되어 있다", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "../..");
  const adminPage = fs.readFileSync(path.join(root, "admin.html"), "utf8");
  const orderPosition = adminPage.indexOf('data-admin-tab="orders"');
  const inquiryPosition = adminPage.indexOf('data-admin-tab="inquiries"');
  const customerPosition = adminPage.indexOf('data-admin-tab="customers"');
  assert.ok(orderPosition < inquiryPosition && inquiryPosition < customerPosition);
  assert.match(adminPage, /data-admin-inquiry-dialog/);
  assert.match(adminPage, /js\/admin\/inquiries\.js/);
});
