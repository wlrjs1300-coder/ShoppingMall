process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "naver-shipment-test-secret-at-least-32-bytes";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const shipmentRoutes = require("../routes/naver-shipments");
const { createNaverShipmentDispatchService } = require("../services/naver-shipment-dispatch-service");

let sequence = 0;
const auth = (role = "super_admin") => ({ Authorization: `Bearer ${jwt.sign({ sub: `shipment-${role}`, role }, process.env.JWT_SECRET)}` });

function fixture({ claimType = null, status = "준비완료" } = {}) {
  sequence += 1;
  const suffix = String(sequence);
  const now = "2026-08-10T04:00:00.000Z";
  const orderId = `shipment-order-${suffix}`;
  const importId = `shipment-import-${suffix}`;
  const conversionId = `shipment-conversion-${suffix}`;
  const externalOrderId = `71000${suffix}`;
  db.prepare(`INSERT INTO orders
    (id,customer_name,customer_phone,fulfillment_type,delivery_address,subtotal,delivery_fee,total_amount,
     cost,status,payment_status,workflow_status,logistics_status,created_at,updated_at,source_channel,external_order_id)
    VALUES (?,?,?,?,?,10000,0,10000,0,?,'결제완료','준비완료','배송대기',?,?,'naver',?)`).run(
    orderId, "개인정보 이름", "01012345678", "delivery", "개인정보 주소", status, now, now, externalOrderId,
  );
  db.prepare(`INSERT INTO sales_channel_order_imports
    (id,channel,external_order_id,import_status,payment_amount,ordered_at,created_at,updated_at)
    VALUES (?,'naver',?,'IMPORTED',10000,?,?,?)`).run(importId, externalOrderId, now, now, now);
  db.prepare(`INSERT INTO sales_channel_order_import_items
    (id,channel,channel_order_import_id,external_product_order_id,external_product_order_status,
     external_claim_type,mapping_status,created_at,updated_at)
    VALUES (?,'naver',?,?,'PRODUCT_PREPARE',?,'MAPPED',?,?)`).run(
    `shipment-item-${suffix}`, importId, `product-order-${suffix}`, claimType, now, now,
  );
  db.prepare(`INSERT INTO sales_channel_order_conversions
    (id,channel,channel_order_import_id,external_order_id,internal_order_id,conversion_status,created_at,updated_at)
    VALUES (?,'naver',?,?,?,'CONVERTED',?,?)`).run(conversionId, importId, externalOrderId, orderId, now, now);
  return { orderId, productOrderId: `product-order-${suffix}` };
}

function service(provider, allowedCarrierCodes = ["CJGLS"]) {
  return createNaverShipmentDispatchService({ db, provider, allowedCarrierCodes });
}

test.beforeEach(() => {
  shipmentRoutes.setServiceFactoryForTest(null);
  db.prepare("DELETE FROM sales_channel_shipment_dispatches").run();
  db.prepare("DELETE FROM sales_channel_order_status_syncs").run();
  db.prepare("DELETE FROM sales_channel_order_conversions WHERE id LIKE 'shipment-conversion-%'").run();
  db.prepare("DELETE FROM sales_channel_order_import_items WHERE id LIKE 'shipment-item-%'").run();
  db.prepare("DELETE FROM sales_channel_order_imports WHERE id LIKE 'shipment-import-%'").run();
  db.prepare("DELETE FROM order_status_history WHERE order_id LIKE 'shipment-order-%'").run();
  db.prepare("DELETE FROM orders WHERE id LIKE 'shipment-order-%'").run();
});

test.after(() => shipmentRoutes.setServiceFactoryForTest(null));

test("발송 입력을 외부 호출 전에 검증한다", async () => {
  const data = fixture();
  let calls = 0;
  const instance = service({ async dispatchShipment() { calls += 1; return { results: [] }; } });
  await assert.rejects(
    instance.dispatch({ orderId: data.orderId, carrierCode: "UNKNOWN", trackingNumber: "123456789" }),
    (error) => error.reason === "NAVER_SHIPMENT_REQUEST_INVALID",
  );
  assert.equal(calls, 0);
});

test("전체 성공 때만 배송중으로 바꾸고 재요청은 외부 호출과 이력을 중복 생성하지 않는다", async () => {
  const data = fixture();
  let calls = 0;
  const instance = service({
    async dispatchShipment(payload) {
      calls += 1;
      assert.deepEqual(Object.keys(payload).sort(), ["carrierCode", "dispatchedAt", "productOrderIds", "signal", "trackingNumber"]);
      assert.equal(JSON.stringify(payload).includes("개인정보"), false);
      return { results: payload.productOrderIds.map((productOrderId) => ({ productOrderId, status: "SUCCESS" })) };
    },
  });
  const first = await instance.dispatch({ orderId: data.orderId, carrierCode: "cjgls", trackingNumber: "123-456-789" });
  assert.equal(first.status, "SUCCEEDED");
  assert.equal(first.trackingNumberMasked, "***6789");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(data.orderId).status, "배송중");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_status_history WHERE order_id=?").get(data.orderId).count, 1);

  const replay = await instance.dispatch({ orderId: data.orderId, carrierCode: "CJGLS", trackingNumber: "123456789" });
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_status_history WHERE order_id=?").get(data.orderId).count, 1);
});

test("부분 응답이나 타임아웃은 재확인 대상으로 남기고 주문 상태를 유지한다", async () => {
  const partial = fixture();
  const partialResult = await service({ async dispatchShipment() { return { results: [] }; } })
    .dispatch({ orderId: partial.orderId, carrierCode: "CJGLS", trackingNumber: "11111111" });
  assert.equal(partialResult.status, "RECONCILE_REQUIRED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(partial.orderId).status, "준비완료");

  const timeout = fixture();
  await assert.rejects(
    service({ async dispatchShipment() { const error = new Error("timeout containing secret"); error.status = 504; throw error; } })
      .dispatch({ orderId: timeout.orderId, carrierCode: "CJGLS", trackingNumber: "22222222" }),
    (error) => error.reason === "NAVER_SHIPMENT_PROVIDER_UNCERTAIN",
  );
  assert.equal(service({}, ["CJGLS"]).get(timeout.orderId).status, "RECONCILE_REQUIRED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(timeout.orderId).status, "준비완료");
  const audit = db.prepare("SELECT message FROM activity_logs WHERE entity_id=(SELECT id FROM sales_channel_shipment_dispatches WHERE internal_order_id=?) ORDER BY created_at DESC LIMIT 1").get(timeout.orderId);
  assert.equal(audit.message.includes("secret"), false);
});

test("클레임 주문은 발송하지 않는다", async () => {
  const data = fixture({ claimType: "RETURN" });
  let calls = 0;
  await assert.rejects(
    service({ async dispatchShipment() { calls += 1; } }).dispatch({
      orderId: data.orderId, carrierCode: "CJGLS", trackingNumber: "33333333",
    }),
    (error) => error.reason === "NAVER_SHIPMENT_CLAIM_REVIEW_REQUIRED",
  );
  assert.equal(calls, 0);
});

test("발송 API는 권한을 검사하고 응답에서 송장번호를 마스킹한다", async () => {
  const data = fixture();
  const instance = service({
    async dispatchShipment(payload) {
      return { results: payload.productOrderIds.map((productOrderId) => ({ productOrderId, status: "SUCCESS" })) };
    },
  });
  shipmentRoutes.setServiceFactoryForTest(() => instance);
  await request(app).post(`/api/sales-channels/naver/shipments/${data.orderId}/dispatch`)
    .send({ carrierCode: "CJGLS", trackingNumber: "987654321" }).expect(401);
  await request(app).post(`/api/sales-channels/naver/shipments/${data.orderId}/dispatch`)
    .set(auth("viewer")).send({ carrierCode: "CJGLS", trackingNumber: "987654321" }).expect(403);
  const sent = await request(app).post(`/api/sales-channels/naver/shipments/${data.orderId}/dispatch`)
    .set(auth()).send({ carrierCode: "CJGLS", trackingNumber: "987654321" }).expect(200);
  assert.equal(sent.body.trackingNumberMasked, "***4321");
  assert.equal(JSON.stringify(sent.body).includes("987654321"), false);
  await request(app).get(`/api/sales-channels/naver/shipments/${data.orderId}`).set(auth("viewer")).expect(200);
});

test("실제 네이버 쓰기 제공자는 기본값에서 비활성화되어 있다", async () => {
  const data = fixture();
  const instance = createNaverShipmentDispatchService({ db, allowedCarrierCodes: ["CJGLS"] });
  await assert.rejects(
    instance.dispatch({ orderId: data.orderId, carrierCode: "CJGLS", trackingNumber: "55555555" }),
    (error) => error.reason === "NAVER_SHIPMENT_WRITE_DISABLED",
  );
  assert.equal(instance.get(data.orderId).status, "FAILED");
});

async function makeReconcileRequired(data) {
  const instance = service({ async dispatchShipment() { return { results: [] }; } });
  await instance.dispatch({ orderId: data.orderId, carrierCode: "CJGLS", trackingNumber: "77777777" });
}

test("재확인 결과가 전부 발송 완료일 때만 주문을 배송중으로 복구한다", async () => {
  const data = fixture();
  await makeReconcileRequired(data);
  let queries = 0;
  const instance = service({
    async getShipmentStatuses({ productOrderIds }) {
      queries += 1;
      return { results: productOrderIds.map((productOrderId) => ({ productOrderId, status: "DISPATCHED" })) };
    },
  });
  const result = await instance.reconcile({ orderId: data.orderId });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.reconciliationAttemptCount, 1);
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(data.orderId).status, "배송중");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_status_history WHERE order_id=?").get(data.orderId).count, 1);
  const replay = await instance.reconcile({ orderId: data.orderId });
  assert.equal(replay.replayed, true);
  assert.equal(queries, 1);
});

test("전부 미발송이면 안전하게 재시도 가능 상태로 돌리고 주문 상태를 유지한다", async () => {
  const data = fixture();
  await makeReconcileRequired(data);
  const instance = service({
    async getShipmentStatuses({ productOrderIds }) {
      return { results: productOrderIds.map((productOrderId) => ({ productOrderId, status: "NOT_DISPATCHED" })) };
    },
  });
  const result = await instance.reconcile({ orderId: data.orderId });
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "NAVER_SHIPMENT_NOT_DISPATCHED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(data.orderId).status, "준비완료");
});

test("부분·불완전 조회 결과는 재확인 상태를 유지하고 중복 상품 결과도 거부한다", async () => {
  const data = fixture();
  db.prepare(`INSERT INTO sales_channel_order_import_items
    (id,channel,channel_order_import_id,external_product_order_id,external_product_order_status,mapping_status,created_at,updated_at)
    SELECT 'shipment-item-extra-' || id,'naver',channel_order_import_id,'product-order-extra-' || id,
      'PRODUCT_PREPARE','MAPPED',created_at,updated_at FROM sales_channel_order_import_items
    WHERE external_product_order_id=?`).run(data.productOrderId);
  await makeReconcileRequired(data);
  const instance = service({
    async getShipmentStatuses({ productOrderIds }) {
      return { results: productOrderIds.map((productOrderId, index) => ({
        productOrderId: index ? productOrderIds[0] : productOrderId,
        status: index ? "NOT_DISPATCHED" : "DISPATCHED",
      })) };
    },
  });
  const result = await instance.reconcile({ orderId: data.orderId });
  assert.equal(result.status, "RECONCILE_REQUIRED");
  assert.equal(result.reason, "NAVER_SHIPMENT_PARTIALLY_DISPATCHED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(data.orderId).status, "준비완료");
});

test("실제 조회 제공자는 기본 비활성화되고 기존 재확인 상태를 보존한다", async () => {
  const data = fixture();
  await makeReconcileRequired(data);
  const instance = createNaverShipmentDispatchService({ db, allowedCarrierCodes: ["CJGLS"] });
  await assert.rejects(instance.reconcile({ orderId: data.orderId }),
    (error) => error.reason === "NAVER_SHIPMENT_READ_DISABLED");
  assert.equal(instance.get(data.orderId).status, "RECONCILE_REQUIRED");
  assert.equal(instance.get(data.orderId).reason, "NAVER_SHIPMENT_READ_DISABLED");
});

test("재확인 API도 관리 권한을 요구한다", async () => {
  const data = fixture();
  await makeReconcileRequired(data);
  const instance = service({
    async getShipmentStatuses({ productOrderIds }) {
      return { results: productOrderIds.map((productOrderId) => ({ productOrderId, status: "NOT_DISPATCHED" })) };
    },
  });
  shipmentRoutes.setServiceFactoryForTest(() => instance);
  await request(app).post(`/api/sales-channels/naver/shipments/${data.orderId}/reconcile`).expect(401);
  await request(app).post(`/api/sales-channels/naver/shipments/${data.orderId}/reconcile`)
    .set(auth("viewer")).expect(403);
  const result = await request(app).post(`/api/sales-channels/naver/shipments/${data.orderId}/reconcile`)
    .set(auth()).send({}).expect(200);
  assert.equal(result.body.status, "FAILED");
});
