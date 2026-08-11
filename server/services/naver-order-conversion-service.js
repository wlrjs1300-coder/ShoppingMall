const crypto = require("node:crypto");
const db = require("../db");
const { decryptPii } = require("../lib/pii-crypto");
const { buildOrderPiiStorage } = require("./order-pii-service");

const SAFE_ITEM_STATUSES = new Set(["PAYED", "PRODUCT_PREPARE", "DELIVERING", "DELIVERED"]);
const STATUS_MAP = {
  PAYED: { status: "접수대기", workflow: "결제대기", logistics: "배송대기" },
  PRODUCT_PREPARE: { status: "준비중", workflow: "접수완료", logistics: "배송대기" },
  DELIVERING: { status: "배송중", workflow: "배송중", logistics: "배송중" },
  DELIVERED: { status: "배송완료", workflow: "배송완료", logistics: "배송완료" },
};
const CONVERSION_STATUSES = new Set(["CONVERTED", "MANUAL_REVIEW", "FAILED"]);
const SAFE_ERROR_CODES = new Set([
  "NAVER_ORDER_NOT_READY", "NAVER_ORDER_MAPPING_REQUIRED", "NAVER_ORDER_CLAIM_REVIEW_REQUIRED",
  "NAVER_ORDER_STATUS_REVIEW_REQUIRED", "NAVER_ORDER_PRODUCT_INACTIVE", "NAVER_ORDER_PII_UNAVAILABLE",
  "NAVER_ORDER_PII_DECRYPTION_FAILED", "NAVER_ORDER_PII_INCOMPLETE", "NAVER_ORDER_AMOUNT_INVALID",
  "NAVER_ORDER_QUANTITY_INVALID", "NAVER_ORDER_CONVERSION_FAILED",
]);

class NaverOrderConversionError extends Error {
  constructor(code) {
    super("네이버 주문을 내부 주문으로 변환하지 못했습니다.");
    this.name = "NaverOrderConversionError";
    this.code = code;
  }
}

function importedPii(row, fields) {
  const key = process.env.NAVER_ORDER_PII_KEY;
  if (!key || !row.item_pii_ciphertext || !row.item_pii_iv || !row.item_pii_auth_tag || !row.item_pii_key_version) {
    throw new NaverOrderConversionError("NAVER_ORDER_PII_UNAVAILABLE");
  }
  let value;
  try {
    value = decryptPii({
      ciphertext: row.item_pii_ciphertext,
      iv: row.item_pii_iv,
      authTag: row.item_pii_auth_tag,
      keyVersion: row.item_pii_key_version,
    }, { key });
  } catch {
    throw new NaverOrderConversionError("NAVER_ORDER_PII_DECRYPTION_FAILED");
  }
  for (const field of fields) if (!String(value?.[field] || "").trim()) throw new NaverOrderConversionError("NAVER_ORDER_PII_INCOMPLETE");
  return value;
}

function allocatePaidAmount(items, paymentAmount) {
  const weights = items.map((item) => Number(item.initial_payment_amount ?? item.unit_price ?? 0));
  const weightTotal = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (!Number.isSafeInteger(paymentAmount) || paymentAmount <= 0 || weightTotal <= 0) {
    throw new NaverOrderConversionError("NAVER_ORDER_AMOUNT_INVALID");
  }
  let assigned = 0;
  return weights.map((weight, index) => {
    const amount = index === weights.length - 1
      ? paymentAmount - assigned
      : Math.floor(paymentAmount * Math.max(0, weight) / weightTotal);
    assigned += amount;
    return amount;
  });
}

function totalWeight(product, salesUnit, externalQuantity) {
  const pack = Number.isInteger(product.unit_weight_grams) ? product.unit_weight_grams : null;
  const half = Number.isInteger(product.half_mal_weight_grams) ? product.half_mal_weight_grams : null;
  const mal = Number.isInteger(product.mal_weight_grams) ? product.mal_weight_grams : null;
  if (salesUnit === "pack") return pack === null ? null : pack * externalQuantity;
  if (salesUnit === "half_mal") return half === null ? null : half * externalQuantity;
  return mal === null ? null : mal * externalQuantity;
}

function writeConversionAudit({ action, conversionId, externalOrderId, outcome, reason = null, actor = "system" }) {
  try {
    db.prepare(`INSERT INTO activity_logs
      (id,category,message,tab,action,entity_id,previous_value,next_value,actor,created_at)
      VALUES (?,'INTEGRATION',?,'sales-channels',?,?,NULL,?,?,?)`).run(
      `activity-${crypto.randomUUID()}`,
      JSON.stringify({ externalOrderReference: externalOrderId ? `***${externalOrderId.slice(-4)}` : null, reason }),
      action, conversionId, outcome, actor, new Date().toISOString(),
    );
  } catch { /* audit failures must not expose order data or break conversion recovery */ }
}

function recordReview(importRow, code, actor = "system") {
  const safeCode = SAFE_ERROR_CODES.has(code) ? code : "NAVER_ORDER_CONVERSION_FAILED";
  const now = new Date().toISOString();
  const conversionId = `conversion-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO sales_channel_order_conversions
    (id,channel,channel_order_import_id,external_order_id,conversion_status,safe_error_code,created_at,updated_at)
    VALUES (?,'naver',?,?,'MANUAL_REVIEW',?,?,?)
    ON CONFLICT(channel,channel_order_import_id) DO UPDATE SET
      conversion_status='MANUAL_REVIEW',safe_error_code=excluded.safe_error_code,updated_at=excluded.updated_at
    WHERE sales_channel_order_conversions.conversion_status<>'CONVERTED'`)
    .run(conversionId, importRow.id, importRow.external_order_id, safeCode, now, now);
  const saved = db.prepare("SELECT id FROM sales_channel_order_conversions WHERE channel='naver' AND channel_order_import_id=?").get(importRow.id);
  writeConversionAudit({ action: "naver_order_conversion_review", conversionId: saved?.id || conversionId,
    externalOrderId: importRow.external_order_id, outcome: "MANUAL_REVIEW", reason: safeCode, actor });
  return { status: "MANUAL_REVIEW", reason: safeCode };
}

function publicConversion(row) {
  return {
    id: row.id,
    channel: row.channel,
    importId: row.channel_order_import_id,
    externalOrderReference: row.external_order_id ? `***${row.external_order_id.slice(-4)}` : null,
    internalOrderId: row.internal_order_id,
    status: row.conversion_status,
    reason: SAFE_ERROR_CODES.has(row.safe_error_code) ? row.safe_error_code : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listNaverOrderConversions({ status, reason, page = 1, size = 50 } = {}) {
  const normalizedPage = Number(page);
  const normalizedSize = Number(size);
  if (!Number.isInteger(normalizedPage) || normalizedPage < 1 || !Number.isInteger(normalizedSize)
    || normalizedSize < 1 || normalizedSize > 100 || (status && !CONVERSION_STATUSES.has(status))
    || (reason && !SAFE_ERROR_CODES.has(reason))) {
    throw new NaverOrderConversionError("NAVER_ORDER_CONVERSION_QUERY_INVALID");
  }
  const clauses = ["channel='naver'"];
  const values = [];
  if (status) { clauses.push("conversion_status=?"); values.push(status); }
  if (reason) { clauses.push("safe_error_code=?"); values.push(reason); }
  const where = clauses.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) count FROM sales_channel_order_conversions WHERE ${where}`).get(...values).count;
  const items = db.prepare(`SELECT * FROM sales_channel_order_conversions WHERE ${where}
    ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...values, normalizedSize, (normalizedPage - 1) * normalizedSize).map(publicConversion);
  return { items, page: normalizedPage, size: normalizedSize, total, last: normalizedPage * normalizedSize >= total };
}

function getNaverOrderConversion(id) {
  const row = db.prepare("SELECT * FROM sales_channel_order_conversions WHERE id=? AND channel='naver'").get(id);
  return row ? publicConversion(row) : null;
}

function summarizeNaverOrderConversions() {
  const summary = { converted: 0, manualReview: 0, failed: 0, retryable: 0 };
  for (const row of db.prepare(`SELECT conversion_status, COUNT(*) count FROM sales_channel_order_conversions
    WHERE channel='naver' GROUP BY conversion_status`).all()) {
    if (row.conversion_status === "CONVERTED") summary.converted = row.count;
    if (row.conversion_status === "MANUAL_REVIEW") summary.manualReview = row.count;
    if (row.conversion_status === "FAILED") summary.failed = row.count;
  }
  summary.retryable = summary.manualReview + summary.failed;
  return summary;
}

function retryNaverOrderConversions({ limit = 50, actor = "system" } = {}) {
  const normalizedLimit = Number(limit);
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 50) {
    throw new NaverOrderConversionError("NAVER_ORDER_CONVERSION_QUERY_INVALID");
  }
  const rows = db.prepare(`SELECT channel_order_import_id FROM sales_channel_order_conversions
    WHERE channel='naver' AND conversion_status IN ('MANUAL_REVIEW','FAILED')
    ORDER BY updated_at ASC LIMIT ?`).all(normalizedLimit);
  const results = rows.map((row) => convertNaverOrderImport(row.channel_order_import_id, { actor }));
  return {
    attempted: results.length,
    converted: results.filter((result) => result.status === "CONVERTED").length,
    manualReview: results.filter((result) => result.status === "MANUAL_REVIEW").length,
  };
}

function convertNaverOrderImport(importId, { actor = "system" } = {}) {
  const header = db.prepare("SELECT * FROM sales_channel_order_imports WHERE id=? AND channel='naver'").get(importId);
  if (!header) throw new NaverOrderConversionError("NAVER_ORDER_IMPORT_NOT_FOUND");
  const converted = db.prepare("SELECT * FROM sales_channel_order_conversions WHERE channel='naver' AND channel_order_import_id=? AND conversion_status='CONVERTED'").get(importId);
  if (converted) return { status: "CONVERTED", orderId: converted.internal_order_id, replayed: true };
  const items = db.prepare("SELECT * FROM sales_channel_order_import_items WHERE channel_order_import_id=? ORDER BY id").all(importId);

  try {
    if (header.import_status !== "IMPORTED" || !items.length) throw new NaverOrderConversionError("NAVER_ORDER_NOT_READY");
    if (items.some((item) => item.mapping_status !== "MAPPED" || !item.internal_product_id || !item.sales_unit_snapshot)) {
      throw new NaverOrderConversionError("NAVER_ORDER_MAPPING_REQUIRED");
    }
    if (items.some((item) => item.external_claim_type || item.external_claim_status)) throw new NaverOrderConversionError("NAVER_ORDER_CLAIM_REVIEW_REQUIRED");
    if (items.some((item) => !SAFE_ITEM_STATUSES.has(item.external_product_order_status))) throw new NaverOrderConversionError("NAVER_ORDER_STATUS_REVIEW_REQUIRED");

    const products = items.map((item) => db.prepare("SELECT * FROM products WHERE id=? AND status='active'").get(item.internal_product_id));
    if (products.some((product) => !product)) throw new NaverOrderConversionError("NAVER_ORDER_PRODUCT_INACTIVE");
    const recipient = importedPii(items[0], ["recipientName", "recipientPhone", "baseAddress"]);
    const address = [recipient.postalCode, recipient.baseAddress, recipient.detailedAddress].filter(Boolean).join(" ");
    const pii = buildOrderPiiStorage({
      customerName: recipient.recipientName,
      customerPhone: recipient.recipientPhone,
      deliveryAddress: address,
      guestAddress: address,
    });
    const paymentAmount = Number(header.payment_amount);
    const allocated = allocatePaidAmount(items, paymentAmount);
    const orderId = `naver-${header.external_order_id}`;
    const latestStatus = items.map((item) => item.external_product_order_status)
      .sort((a, b) => ["PAYED", "PRODUCT_PREPARE", "DELIVERING", "DELIVERED"].indexOf(a) - ["PAYED", "PRODUCT_PREPARE", "DELIVERING", "DELIVERED"].indexOf(b))[0];
    const mappedStatus = STATUS_MAP[latestStatus];
    const now = new Date().toISOString();

    db.exec("BEGIN IMMEDIATE");
    try {
      const existingOrder = db.prepare("SELECT id FROM orders WHERE source_channel='naver' AND external_order_id=?").get(header.external_order_id);
      if (existingOrder) {
        db.exec("ROLLBACK");
        return { status: "CONVERTED", orderId: existingOrder.id, replayed: true };
      }
      db.prepare(`INSERT INTO orders
        (id,customer_name,customer_phone,fulfillment_type,delivery_address,subtotal,delivery_fee,total_amount,cost,
         status,payment_status,amount_status,workflow_status,logistics_status,memo,created_at,updated_at,
         guest_address,pii_ciphertext,pii_iv,pii_auth_tag,pii_key_version,customer_name_masked,customer_phone_masked,
         delivery_region_masked,pii_migrated_at,source_channel,external_order_id)
        VALUES (?,?,?,'delivery',?,?,?,?,0,?,'결제완료','confirmed',?,?,?,?,?,?,?,?,?,?,?,?,?,?,'naver',?)`)
        .run(orderId, pii.customerName, pii.customerPhone, pii.deliveryAddress, paymentAmount, 0, paymentAmount,
          mappedStatus.status, mappedStatus.workflow, mappedStatus.logistics, recipient.shippingMemo || null,
          header.ordered_at || now, now, pii.guestAddress, pii.piiCiphertext, pii.piiIv, pii.piiAuthTag,
          pii.piiKeyVersion, pii.customerNameMasked, pii.customerPhoneMasked, pii.deliveryRegionMasked,
          pii.piiMigratedAt, header.external_order_id);

      const insertItem = db.prepare(`INSERT INTO order_items
        (id,order_id,product_id,product_name,unit_price,quantity,quantity_unit,line_total,
         pack_weight_grams,half_mal_weight_grams,mal_weight_grams,total_weight_grams)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      items.forEach((item, index) => {
        const product = products[index];
        const externalQuantity = Number(item.initial_quantity || 0);
        if (!Number.isSafeInteger(externalQuantity) || externalQuantity <= 0) throw new NaverOrderConversionError("NAVER_ORDER_QUANTITY_INVALID");
        const quantity = item.sales_unit_snapshot === "pack" ? externalQuantity
          : item.sales_unit_snapshot === "half_mal" ? externalQuantity * 0.5 : externalQuantity;
        const lineTotal = allocated[index];
        insertItem.run(`item-${orderId}-${index + 1}`, orderId, product.id, product.name,
          Math.round(lineTotal / quantity), quantity, item.sales_unit_snapshot === "pack" ? "pack" : "mal", lineTotal,
          product.unit_weight_grams ?? null, product.half_mal_weight_grams ?? null, product.mal_weight_grams ?? null,
          totalWeight(product, item.sales_unit_snapshot, externalQuantity));
      });
      db.prepare(`INSERT INTO sales_channel_order_conversions
        (id,channel,channel_order_import_id,external_order_id,internal_order_id,conversion_status,created_at,updated_at)
        VALUES (?,'naver',?,?,?,'CONVERTED',?,?)
        ON CONFLICT(channel,channel_order_import_id) DO UPDATE SET internal_order_id=excluded.internal_order_id,
          conversion_status='CONVERTED',safe_error_code=NULL,updated_at=excluded.updated_at`)
        .run(`conversion-${crypto.randomUUID()}`, header.id, header.external_order_id, orderId, now, now);
      db.exec("COMMIT");
      const savedConversion = db.prepare("SELECT id FROM sales_channel_order_conversions WHERE channel='naver' AND channel_order_import_id=?").get(header.id);
      writeConversionAudit({ action: "naver_order_conversion_completed", conversionId: savedConversion?.id || header.id,
        externalOrderId: header.external_order_id, outcome: "CONVERTED", actor });
      return { status: "CONVERTED", orderId, replayed: false };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (error instanceof NaverOrderConversionError) return recordReview(header, error.code, actor);
    if (process.env.NODE_ENV === "test") throw error;
    return recordReview(header, "NAVER_ORDER_CONVERSION_FAILED", actor);
  }
}

module.exports = {
  NaverOrderConversionError,
  allocatePaidAmount,
  convertNaverOrderImport,
  getNaverOrderConversion,
  listNaverOrderConversions,
  retryNaverOrderConversions,
  summarizeNaverOrderConversions,
};
