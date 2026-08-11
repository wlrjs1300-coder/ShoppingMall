process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "naver-conversion-test-secret-at-least-32-bytes";
process.env.NODE_ENV = "test";
process.env.NAVER_ORDER_PII_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.NAVER_ORDER_PII_KEY_VERSION = "v1";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const { encryptPii } = require("../lib/pii-crypto");
const { convertNaverOrderImport } = require("../services/naver-order-conversion-service");
const { synchronizeNaverOrderStatus } = require("../services/naver-order-status-sync-service");

let sequence = 0;
const auth = (role = "super_admin") => ({ Authorization: `Bearer ${jwt.sign({ sub: `conversion-${role}`, role }, process.env.JWT_SECRET)}` });
function fixture({ salesUnit = "pack", status = "PAYED", mappingStatus = "MAPPED", claimType = null, paymentAmount = 9000 } = {}) {
  sequence += 1;
  const suffix = String(sequence);
  const importId = `convert-import-${suffix}`;
  const externalOrderId = `9900${suffix}`;
  const now = "2026-08-10T01:00:00.000Z";
  const encrypted = encryptPii({
    recipientName: "네이버고객",
    recipientPhone: "01012345678",
    postalCode: "18501",
    baseAddress: "경기 화성시 동탄구 동탄대로 198",
    detailedAddress: "116호",
    shippingMemo: "문 앞에 놓아주세요",
  }, { key: process.env.NAVER_ORDER_PII_KEY, keyVersion: "v1" });
  db.prepare(`INSERT INTO sales_channel_order_imports
    (id,channel,external_order_id,import_status,payment_amount,ordered_at,created_at,updated_at)
    VALUES (?,'naver',?,'IMPORTED',?,?,?,?)`).run(importId, externalOrderId, paymentAmount, now, now, now);
  db.prepare(`INSERT INTO sales_channel_order_import_items
    (id,channel,channel_order_import_id,external_product_order_id,internal_product_id,sales_unit_snapshot,
     initial_quantity,unit_price,initial_payment_amount,external_product_order_status,external_claim_type,
     item_pii_ciphertext,item_pii_iv,item_pii_auth_tag,item_pii_key_version,mapping_status,created_at,updated_at)
    VALUES (?,'naver',?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `convert-item-${suffix}`, importId, `8800${suffix}`, "injeolmi", salesUnit,
    10000, 10000, status, claimType, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
    encrypted.keyVersion, mappingStatus, now, now,
  );
  return { importId, externalOrderId };
}

test.beforeEach(() => {
  db.prepare("DELETE FROM sales_channel_order_status_syncs").run();
  db.prepare("DELETE FROM sales_channel_order_conversions").run();
  db.prepare("DELETE FROM order_items WHERE order_id LIKE 'naver-%'").run();
  db.prepare("DELETE FROM orders WHERE source_channel='naver'").run();
  db.prepare("DELETE FROM sales_channel_order_import_items WHERE id LIKE 'convert-item-%'").run();
  db.prepare("DELETE FROM sales_channel_order_imports WHERE id LIKE 'convert-import-%'").run();
  db.prepare("UPDATE products SET status='active', unit_weight_grams=250, half_mal_weight_grams=4000, mal_weight_grams=8500 WHERE id='injeolmi'").run();
});

test("네이버 실결제 금액과 주문 당시 단위·중량을 내부 주문으로 보존한다", () => {
  const data = fixture({ salesUnit: "half_mal", paymentAmount: 9000 });
  const result = convertNaverOrderImport(data.importId);
  assert.equal(result.status, "CONVERTED", JSON.stringify(result));
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(result.orderId);
  assert.equal(order.source_channel, "naver");
  assert.equal(order.external_order_id, data.externalOrderId);
  assert.equal(order.total_amount, 9000);
  assert.equal(order.fulfillment_type, "delivery");
  const item = db.prepare("SELECT * FROM order_items WHERE order_id=?").get(result.orderId);
  assert.equal(item.quantity_unit, "mal");
  assert.equal(item.quantity, 0.5);
  assert.equal(item.line_total, 9000);
  assert.equal(item.total_weight_grams, 4000);
  assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE action='naver_order_conversion_completed'").get());
});

test("같은 네이버 주문을 반복 변환해도 내부 주문은 한 건만 생성한다", () => {
  const data = fixture();
  const first = convertNaverOrderImport(data.importId);
  const second = convertNaverOrderImport(data.importId);
  assert.equal(first.orderId, second.orderId);
  assert.equal(second.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE external_order_id=?").get(data.externalOrderId).count, 1);
});

test("미매핑·클레임·판매중지 주문은 자동 변환하지 않고 검토 대상으로 남긴다", () => {
  const unmapped = fixture({ mappingStatus: "UNMAPPED" });
  assert.equal(convertNaverOrderImport(unmapped.importId).reason, "NAVER_ORDER_MAPPING_REQUIRED");
  assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE action='naver_order_conversion_review'").get());
  const claimed = fixture({ claimType: "RETURN" });
  assert.equal(convertNaverOrderImport(claimed.importId).reason, "NAVER_ORDER_CLAIM_REVIEW_REQUIRED");
  const inactive = fixture();
  db.prepare("UPDATE products SET status='inactive' WHERE id='injeolmi'").run();
  assert.equal(convertNaverOrderImport(inactive.importId).reason, "NAVER_ORDER_PRODUCT_INACTIVE");
});

test("검토 주문을 안전하게 조회하고 원인이 해결되면 일괄 재처리한다", async () => {
  const data = fixture({ mappingStatus: "UNMAPPED" });
  convertNaverOrderImport(data.importId);
  await request(app).get("/api/sales-channels/naver/order-conversions").expect(401);
  const list = await request(app).get("/api/sales-channels/naver/order-conversions?status=MANUAL_REVIEW")
    .set(auth("viewer")).expect(200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].externalOrderReference, `***${data.externalOrderId.slice(-4)}`);
  assert.equal(JSON.stringify(list.body).includes(data.externalOrderId), false);
  const summary = await request(app).get("/api/sales-channels/naver/order-conversions/summary")
    .set(auth("viewer")).expect(200);
  assert.equal(summary.body.retryable, 1);

  db.prepare("UPDATE sales_channel_order_import_items SET mapping_status='MAPPED' WHERE channel_order_import_id=?").run(data.importId);
  const retried = await request(app).post("/api/sales-channels/naver/order-conversions/retry")
    .set(auth()).send({ limit: 10 }).expect(200);
  assert.equal(retried.body.converted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE external_order_id=?").get(data.externalOrderId).count, 1);
});

test("변환 조회 필터와 재처리 한도를 검증한다", async () => {
  await request(app).get("/api/sales-channels/naver/order-conversions?status=UNKNOWN")
    .set(auth("viewer")).expect(400);
  await request(app).post("/api/sales-channels/naver/order-conversions/retry")
    .set(auth()).send({ limit: 51 }).expect(400);
});

test("네이버 배송 상태를 순방향으로만 반영하고 중복 이력을 만들지 않는다", () => {
  const data = fixture();
  const converted = convertNaverOrderImport(data.importId);
  db.prepare(`UPDATE sales_channel_order_import_items SET external_product_order_status='DELIVERING',
    source_changed_at='2026-08-10T02:00:00.000Z' WHERE channel_order_import_id=?`).run(data.importId);
  const first = synchronizeNaverOrderStatus(data.importId);
  assert.equal(first.status, "SYNCHRONIZED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(converted.orderId).status, "배송중");
  const historyCount = db.prepare("SELECT COUNT(*) count FROM order_status_history WHERE order_id=?").get(converted.orderId).count;
  const replay = synchronizeNaverOrderStatus(data.importId);
  assert.equal(replay.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_status_history WHERE order_id=?").get(converted.orderId).count, historyCount);

  db.prepare(`UPDATE sales_channel_order_import_items SET external_product_order_status='PAYED',
    source_changed_at='2026-08-10T03:00:00.000Z' WHERE channel_order_import_id=?`).run(data.importId);
  assert.equal(synchronizeNaverOrderStatus(data.importId).reason, "NAVER_STATUS_REGRESSION");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(converted.orderId).status, "배송중");
});

test("최종 전체 취소만 자동 반영하고 반품·부분 취소는 검토 대상으로 둔다", () => {
  const cancelled = fixture();
  const converted = convertNaverOrderImport(cancelled.importId);
  db.prepare(`UPDATE sales_channel_order_import_items SET external_claim_type='CANCEL',external_claim_status='CANCEL_DONE',
    source_changed_at='2026-08-10T02:00:00.000Z' WHERE channel_order_import_id=?`).run(cancelled.importId);
  assert.equal(synchronizeNaverOrderStatus(cancelled.importId).status, "SYNCHRONIZED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(converted.orderId).status, "취소");

  const returned = fixture();
  convertNaverOrderImport(returned.importId);
  db.prepare(`UPDATE sales_channel_order_import_items SET external_claim_type='RETURN',external_claim_status='RETURN_REQUEST',
    source_changed_at='2026-08-10T02:00:00.000Z' WHERE channel_order_import_id=?`).run(returned.importId);
  assert.equal(synchronizeNaverOrderStatus(returned.importId).reason, "NAVER_STATUS_CLAIM_REVIEW_REQUIRED");
});

test("네이버 결제 금액이 달라지면 내부 주문 금액을 바꾸지 않는다", () => {
  const data = fixture({ paymentAmount: 9000 });
  const converted = convertNaverOrderImport(data.importId);
  db.prepare("UPDATE sales_channel_order_imports SET payment_amount=8000 WHERE id=?").run(data.importId);
  db.prepare("UPDATE sales_channel_order_import_items SET source_changed_at='2026-08-10T02:00:00.000Z' WHERE channel_order_import_id=?").run(data.importId);
  assert.equal(synchronizeNaverOrderStatus(data.importId).reason, "NAVER_STATUS_AMOUNT_MISMATCH");
  assert.equal(db.prepare("SELECT total_amount FROM orders WHERE id=?").get(converted.orderId).total_amount, 9000);
});
