process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "naver-lifecycle-test-secret-at-least-32-bytes";
process.env.NODE_ENV = "test";
process.env.NAVER_ORDER_PII_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.NAVER_ORDER_PII_KEY_VERSION = "v1";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const { createNaverOrderSyncService } = require("../services/naver-order-sync-service");
const { convertNaverOrderImport } = require("../services/naver-order-conversion-service");
const { synchronizeNaverOrderStatus } = require("../services/naver-order-status-sync-service");
const { createNaverShipmentDispatchService } = require("../services/naver-shipment-dispatch-service");

const NOW = "2026-08-10T12:00:00.000Z";
const CHANGED_AT = "2026-08-10T10:00:00.000Z";

function detail({ orderId, productOrderId, claimType = null }) {
  return {
    header: {
      externalOrderId: orderId,
      importStatus: "IMPORTED",
      externalPaymentStatus: "PAYED",
      paymentMethod: "CARD",
      orderAmount: 18000,
      paymentAmount: 18000,
      orderedAt: CHANGED_AT,
      paidAt: CHANGED_AT,
      sourceChangedAt: CHANGED_AT,
      pii: { ordererName: "통합검증 주문자", ordererPhone: "01011112222" },
      ordererNameMasked: "통***",
      ordererPhoneMasked: "010****2222",
    },
    item: {
      externalOrderId: orderId,
      externalProductOrderId: productOrderId,
      externalChannelProductNo: "991001",
      externalOriginProductNo: "881001",
      externalClaimId: claimType ? `claim-${productOrderId}` : null,
      groupProductId: null,
      packageNumber: null,
      itemNo: null,
      optionManageCode: null,
      sellerProductCode: "INJEOLMI-HALF",
      productNameSnapshot: "인절미 반말",
      optionNameSnapshot: "반말",
      initialQuantity: 1,
      remainingQuantity: 1,
      unitPrice: 18000,
      initialPaymentAmount: 18000,
      remainingPaymentAmount: 18000,
      externalProductOrderStatus: "PAYED",
      externalClaimType: claimType,
      externalClaimStatus: claimType ? "RETURN_REQUEST" : null,
      lastChangedType: "PAYED",
      sourceChangedAt: CHANGED_AT,
      pii: {
        recipientName: "통합검증 수령인",
        recipientPhone: "01033334444",
        postalCode: "18501",
        baseAddress: "경기 화성시 동탄대로 198",
        detailedAddress: "116호",
        shippingMemo: "문 앞",
      },
      recipientNameMasked: "통***",
      recipientPhoneMasked: "010****4444",
    },
  };
}

test.before(() => {
  db.prepare(`INSERT INTO sales_channel_product_unit_mappings
    (id,channel,internal_product_id,sales_unit,external_origin_product_no,external_channel_product_no,
     external_product_name,external_status,mapping_status,created_at,updated_at)
    VALUES ('lifecycle-unit-map','naver','injeolmi','half_mal','881001','991001',
      '인절미 반말','SALE','ACTIVE',?,?)`).run(NOW, NOW);
  db.prepare(`UPDATE products SET status='active',half_mal_price=18000,half_mal_weight_grams=4000
    WHERE id='injeolmi'`).run();
});

test("네이버 주문 수집부터 발송 재확인까지 전체 흐름은 멱등하고 안전하다", async () => {
  const normal = { orderId: "lifecycle-order-1001", productOrderId: "lifecycle-product-order-1001" };
  const claimed = { orderId: "lifecycle-order-1002", productOrderId: "lifecycle-product-order-1002" };
  const snapshots = new Map([
    [normal.productOrderId, detail(normal)],
    [claimed.productOrderId, detail({ ...claimed, claimType: "RETURN" })],
  ]);
  const orderService = {
    async getLastChangedProductOrders() {
      return {
        items: [normal, claimed].map((item) => ({
          ...item, lastChangedAt: CHANGED_AT, lastChangedType: "PAYED",
        })),
        more: null,
      };
    },
    async getProductOrders(ids) {
      return { items: ids.map((id) => snapshots.get(id)), traceId: "safe-lifecycle-trace" };
    },
  };
  const sync = createNaverOrderSyncService({
    db,
    orderService,
    now: () => new Date(NOW),
    sleep: async () => {},
  });

  const pulled = await sync.pullOrderImports({
    initialLastChangedFrom: "2026-08-10T00:00:00.000Z", actor: "lifecycle-test",
  });
  assert.equal(pulled.status, "SUCCEEDED");
  assert.equal(pulled.importedCount, 2);

  const converted = db.prepare(`SELECT * FROM sales_channel_order_conversions
    WHERE external_order_id=?`).get(normal.orderId);
  assert.equal(converted.conversion_status, "CONVERTED");
  const internalOrder = db.prepare("SELECT * FROM orders WHERE id=?").get(converted.internal_order_id);
  assert.equal(internalOrder.total_amount, 18000);
  assert.equal(internalOrder.fulfillment_type, "delivery");
  const internalItem = db.prepare("SELECT * FROM order_items WHERE order_id=?").get(internalOrder.id);
  assert.equal(internalItem.quantity_unit, "mal");
  assert.equal(internalItem.quantity, 0.5);
  assert.equal(internalItem.total_weight_grams, 4000);

  const blocked = db.prepare(`SELECT * FROM sales_channel_order_conversions
    WHERE external_order_id=?`).get(claimed.orderId);
  assert.equal(blocked.conversion_status, "MANUAL_REVIEW");
  assert.equal(blocked.safe_error_code, "NAVER_ORDER_CLAIM_REVIEW_REQUIRED");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE external_order_id=?").get(claimed.orderId).count, 0);

  const importRow = db.prepare("SELECT id FROM sales_channel_order_imports WHERE external_order_id=?").get(normal.orderId);
  const conversionReplay = convertNaverOrderImport(importRow.id, { actor: "lifecycle-test" });
  assert.equal(conversionReplay.replayed, true);
  assert.equal(conversionReplay.orderId, internalOrder.id);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE external_order_id=?").get(normal.orderId).count, 1);
  db.prepare(`UPDATE sales_channel_order_import_items SET external_product_order_status='PRODUCT_PREPARE',
    source_changed_at='2026-08-10T10:30:00.000Z' WHERE channel_order_import_id=?`).run(importRow.id);
  const synchronized = synchronizeNaverOrderStatus(importRow.id, { actor: "lifecycle-test" });
  assert.equal(synchronized.status, "SYNCHRONIZED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(internalOrder.id).status, "준비중");
  db.prepare("UPDATE orders SET status='준비완료',workflow_status='준비완료' WHERE id=?").run(internalOrder.id);

  let dispatchCalls = 0;
  let statusCalls = 0;
  let outboundPayload;
  const shipment = createNaverShipmentDispatchService({
    db,
    allowedCarrierCodes: ["CJGLS"],
    provider: {
      async dispatchShipment(payload) {
        dispatchCalls += 1;
        outboundPayload = payload;
        return { results: [] };
      },
      async getShipmentStatuses({ productOrderIds }) {
        statusCalls += 1;
        return { results: productOrderIds.map((productOrderId) => ({ productOrderId, status: "DISPATCHED" })) };
      },
    },
  });
  const uncertain = await shipment.dispatch({
    orderId: internalOrder.id, carrierCode: "CJGLS", trackingNumber: "123-456-789", actor: "lifecycle-test",
  });
  assert.equal(uncertain.status, "RECONCILE_REQUIRED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(internalOrder.id).status, "준비완료");
  assert.deepEqual(outboundPayload.productOrderIds, [normal.productOrderId]);
  assert.equal(JSON.stringify(outboundPayload).includes("010"), false);
  assert.equal(JSON.stringify(outboundPayload).includes("동탄"), false);

  const recovered = await shipment.reconcile({ orderId: internalOrder.id, actor: "lifecycle-test" });
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(internalOrder.id).status, "배송중");
  const dispatchReplay = await shipment.dispatch({
    orderId: internalOrder.id, carrierCode: "CJGLS", trackingNumber: "123456789", actor: "lifecycle-test",
  });
  assert.equal(dispatchReplay.replayed, true);
  const replay = await shipment.reconcile({ orderId: internalOrder.id, actor: "lifecycle-test" });
  assert.equal(replay.replayed, true);
  assert.equal(dispatchCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM order_status_history
    WHERE order_id=? AND next_status='배송중'`).get(internalOrder.id).count, 1);

  const serializedLogs = JSON.stringify(db.prepare(`SELECT message FROM activity_logs
    WHERE actor='lifecycle-test'`).all());
  assert.equal(serializedLogs.includes("01011112222"), false);
  assert.equal(serializedLogs.includes("01033334444"), false);
  assert.equal(serializedLogs.includes("경기 화성시"), false);
});
