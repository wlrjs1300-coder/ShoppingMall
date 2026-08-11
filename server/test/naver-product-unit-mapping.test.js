process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "naver-unit-mapping-test-secret-at-least-32-bytes";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const route = require("../routes/naver-product-unit-mappings");
const { resolveProductMapping } = require("../services/naver-order-import-service");

const auth = (role = "super_admin") => ({ Authorization: `Bearer ${jwt.sign({ sub: `unit-${role}`, role }, process.env.JWT_SECRET)}` });
const external = (channelProductNo) => ({
  originProductNo: `9${channelProductNo}`,
  channelProductNo,
  channelServiceType: "STOREFARM",
  name: `네이버 상품 ${channelProductNo}`,
  statusType: "SALE",
  hasOptions: false,
});

test.beforeEach(() => {
  db.prepare("DELETE FROM sales_channel_product_unit_mappings").run();
  route.setServiceFactoryForTest(() => ({ getChannelProduct: async (id) => external(id) }));
});

test.after(() => route.setServiceFactoryForTest(null));

test("팩·반말·한말을 서로 다른 네이버 상품으로 연결한다", async () => {
  const values = [["pack", "81001"], ["half_mal", "81002"], ["mal", "81003"]];
  for (const [salesUnit, channelProductNo] of values) {
    const response = await request(app).post("/api/sales-channels/naver/product-unit-mappings")
      .set(auth()).send({ internalProductId: "injeolmi", salesUnit, channelProductNo }).expect(201);
    assert.equal(response.body.salesUnit, salesUnit);
    assert.equal(response.body.mappingStatus, "ACTIVE");
  }
  const list = await request(app).get("/api/sales-channels/naver/product-unit-mappings?internalProductId=injeolmi")
    .set(auth("viewer")).expect(200);
  assert.equal(list.body.total, 3);
});

test("네이버 상품 중복 연결과 판매 중지 상품 연결을 차단한다", async () => {
  await request(app).post("/api/sales-channels/naver/product-unit-mappings")
    .set(auth()).send({ internalProductId: "injeolmi", salesUnit: "pack", channelProductNo: "82001" }).expect(201);
  await request(app).post("/api/sales-channels/naver/product-unit-mappings")
    .set(auth()).send({ internalProductId: "injeolmi", salesUnit: "mal", channelProductNo: "82001" }).expect(409);
  db.prepare("UPDATE products SET status='inactive' WHERE id='injeolmi'").run();
  await request(app).post("/api/sales-channels/naver/product-unit-mappings")
    .set(auth()).send({ internalProductId: "injeolmi", salesUnit: "mal", channelProductNo: "82002" }).expect(422);
  db.prepare("UPDATE products SET status='active' WHERE id='injeolmi'").run();
});

test("주문 수집은 네이버 상품번호로 내부 상품과 판매 단위를 판별한다", async () => {
  await request(app).post("/api/sales-channels/naver/product-unit-mappings")
    .set(auth()).send({ internalProductId: "injeolmi", salesUnit: "half_mal", channelProductNo: "83001" }).expect(201);
  const mapped = resolveProductMapping(db, "83001");
  assert.equal(mapped.internalProductId, "injeolmi");
  assert.equal(mapped.salesUnit, "half_mal");
  assert.equal(mapped.mappingStatus, "MAPPED");

  db.prepare("UPDATE products SET status='inactive' WHERE id='injeolmi'").run();
  assert.equal(resolveProductMapping(db, "83001").mappingStatus, "UNMAPPED");
  db.prepare("UPDATE products SET status='active' WHERE id='injeolmi'").run();
});

test("매핑 비활성화 후 주문 연결 대상에서 제외하고 다시 활성화할 수 있다", async () => {
  const created = await request(app).post("/api/sales-channels/naver/product-unit-mappings")
    .set(auth()).send({ internalProductId: "injeolmi", salesUnit: "mal", channelProductNo: "84001" }).expect(201);
  await request(app).patch(`/api/sales-channels/naver/product-unit-mappings/${created.body.id}`)
    .set(auth()).send({ enabled: false }).expect(200);
  assert.equal(resolveProductMapping(db, "84001").mappingStatus, "UNMAPPED");
  await request(app).patch(`/api/sales-channels/naver/product-unit-mappings/${created.body.id}`)
    .set(auth()).send({ enabled: true }).expect(200);
  assert.equal(resolveProductMapping(db, "84001").salesUnit, "mal");
});
