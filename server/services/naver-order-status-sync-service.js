const crypto = require("node:crypto");
const db = require("../db");

const STATUS_TARGETS = {
  PAYED: { order: "접수대기", workflow: "접수대기", logistics: "배송대기", rank: 1 },
  PRODUCT_PREPARE: { order: "준비중", workflow: "접수완료", logistics: "배송대기", rank: 2 },
  DELIVERING: { order: "배송중", workflow: "배송중", logistics: "배송중", rank: 3 },
  DELIVERED: { order: "배송완료", workflow: "배송완료", logistics: "배송완료", rank: 4 },
};
const INTERNAL_RANK = { 접수대기: 1, 준비중: 2, 준비완료: 2, 배송중: 3, 배송완료: 4, 취소: 99, 주문취소: 99 };
const FINAL_CANCEL_STATUSES = new Set(["CANCEL_DONE", "CANCEL_COMPLETED", "COMPLETED"]);
const SAFE_REASONS = new Set([
  "NAVER_STATUS_MAPPING_REQUIRED", "NAVER_STATUS_MIXED_ITEMS", "NAVER_STATUS_CLAIM_REVIEW_REQUIRED",
  "NAVER_STATUS_PARTIAL_CANCEL", "NAVER_STATUS_AMOUNT_MISMATCH", "NAVER_STATUS_REGRESSION",
  "NAVER_STATUS_SOURCE_TIME_INVALID",
]);

function latestSource(items) {
  const values = items.map((item) => item.source_changed_at).filter(Boolean);
  if (!values.length || values.some((value) => !Number.isFinite(Date.parse(value)))) return null;
  return values.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function publicResult(row, extra = {}) {
  return {
    status: row.sync_status,
    reason: SAFE_REASONS.has(row.safe_error_code) ? row.safe_error_code : null,
    internalOrderId: row.internal_order_id,
    internalStatus: row.internal_status,
    externalStatus: row.external_status,
    sourceChangedAt: row.source_changed_at,
    ...extra,
  };
}

function audit(action, row, actor) {
  try {
    const conversion = db.prepare("SELECT external_order_id FROM sales_channel_order_conversions WHERE id=?").get(row.conversion_id);
    db.prepare(`INSERT INTO activity_logs
      (id,category,message,tab,action,entity_id,previous_value,next_value,actor,created_at)
      VALUES (?,'INTEGRATION',?,'sales-channels',?,?,NULL,?,?,?)`).run(
      `activity-${crypto.randomUUID()}`,
      JSON.stringify({ externalOrderReference: conversion?.external_order_id ? `***${conversion.external_order_id.slice(-4)}` : null,
        reason: SAFE_REASONS.has(row.safe_error_code) ? row.safe_error_code : null }),
      action, row.id, row.sync_status, actor, new Date().toISOString(),
    );
  } catch { /* status synchronization must remain recoverable */ }
}

function saveSync(conversion, order, { externalStatus, sourceChangedAt, syncStatus, reason = null }, actor) {
  const now = new Date().toISOString();
  const id = `status-sync-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO sales_channel_order_status_syncs
    (id,channel,conversion_id,channel_order_import_id,internal_order_id,external_status,source_changed_at,
     internal_status,sync_status,safe_error_code,created_at,updated_at)
    VALUES (?,'naver',?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(channel,conversion_id) DO UPDATE SET external_status=excluded.external_status,
      source_changed_at=excluded.source_changed_at,internal_status=excluded.internal_status,
      sync_status=excluded.sync_status,safe_error_code=excluded.safe_error_code,updated_at=excluded.updated_at`)
    .run(id, conversion.id, conversion.channel_order_import_id, order.id, externalStatus, sourceChangedAt,
      order.status, syncStatus, reason, now, now);
  const saved = db.prepare("SELECT * FROM sales_channel_order_status_syncs WHERE channel='naver' AND conversion_id=?").get(conversion.id);
  audit(syncStatus === "SYNCHRONIZED" ? "naver_order_status_synchronized" : "naver_order_status_review", saved, actor);
  return saved;
}

function review(conversion, order, externalStatus, sourceChangedAt, reason, actor) {
  return publicResult(saveSync(conversion, order, {
    externalStatus, sourceChangedAt, syncStatus: "MANUAL_REVIEW", reason,
  }, actor));
}

function synchronizeNaverOrderStatus(importId, { actor = "system" } = {}) {
  const conversion = db.prepare(`SELECT * FROM sales_channel_order_conversions
    WHERE channel='naver' AND channel_order_import_id=? AND conversion_status='CONVERTED'`).get(importId);
  if (!conversion) return { status: "MANUAL_REVIEW", reason: "NAVER_STATUS_MAPPING_REQUIRED" };
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(conversion.internal_order_id);
  const header = db.prepare("SELECT * FROM sales_channel_order_imports WHERE id=?").get(importId);
  const items = db.prepare("SELECT * FROM sales_channel_order_import_items WHERE channel_order_import_id=? ORDER BY id").all(importId);
  if (!order || !header || !items.length) return { status: "MANUAL_REVIEW", reason: "NAVER_STATUS_MAPPING_REQUIRED" };
  const sourceChangedAt = latestSource(items);
  const existing = db.prepare("SELECT * FROM sales_channel_order_status_syncs WHERE channel='naver' AND conversion_id=?").get(conversion.id);
  if (!sourceChangedAt) return review(conversion, order, null, null, "NAVER_STATUS_SOURCE_TIME_INVALID", actor);
  if (existing?.source_changed_at && Date.parse(sourceChangedAt) <= Date.parse(existing.source_changed_at)) {
    return publicResult(existing, { replayed: true });
  }
  if (Number(header.payment_amount) !== Number(order.total_amount)) {
    return review(conversion, order, null, sourceChangedAt, "NAVER_STATUS_AMOUNT_MISMATCH", actor);
  }

  const claimed = items.filter((item) => item.external_claim_type || item.external_claim_status);
  if (claimed.length) {
    const allCancelled = claimed.length === items.length && claimed.every((item) =>
      item.external_claim_type === "CANCEL" && FINAL_CANCEL_STATUSES.has(item.external_claim_status));
    if (!allCancelled) {
      const reason = claimed.length !== items.length ? "NAVER_STATUS_PARTIAL_CANCEL" : "NAVER_STATUS_CLAIM_REVIEW_REQUIRED";
      return review(conversion, order, "CLAIM", sourceChangedAt, reason, actor);
    }
    if (["배송완료", "취소", "주문취소"].includes(order.status)) {
      if (["취소", "주문취소"].includes(order.status)) {
        const saved = saveSync(conversion, order, { externalStatus: "CANCEL_DONE", sourceChangedAt, syncStatus: "SYNCHRONIZED" }, actor);
        return publicResult(saved, { replayed: true });
      }
      return review(conversion, order, "CANCEL_DONE", sourceChangedAt, "NAVER_STATUS_REGRESSION", actor);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE orders SET status='취소',workflow_status='취소',logistics_status='취소',updated_at=? WHERE id=?")
        .run(new Date().toISOString(), order.id);
      db.prepare(`INSERT INTO order_status_history
        (id,order_id,previous_status,next_status,changed_by,created_at,reason) VALUES (?,?,?,'취소','naver',?,?)`)
        .run(`history-${crypto.randomUUID()}`, order.id, order.status, new Date().toISOString(), "NAVER_CANCEL_COMPLETED");
      order.status = "취소";
      const saved = saveSync(conversion, order, { externalStatus: "CANCEL_DONE", sourceChangedAt, syncStatus: "SYNCHRONIZED" }, actor);
      db.exec("COMMIT");
      return publicResult(saved);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const statuses = [...new Set(items.map((item) => item.external_product_order_status))];
  if (statuses.length !== 1) return review(conversion, order, statuses.join(","), sourceChangedAt, "NAVER_STATUS_MIXED_ITEMS", actor);
  const target = STATUS_TARGETS[statuses[0]];
  if (!target) return review(conversion, order, statuses[0], sourceChangedAt, "NAVER_STATUS_MAPPING_REQUIRED", actor);
  const currentRank = INTERNAL_RANK[order.status] || 0;
  if (target.rank < currentRank) return review(conversion, order, statuses[0], sourceChangedAt, "NAVER_STATUS_REGRESSION", actor);
  if (target.order === order.status) {
    const saved = saveSync(conversion, order, { externalStatus: statuses[0], sourceChangedAt, syncStatus: "SYNCHRONIZED" }, actor);
    return publicResult(saved, { replayed: true });
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE orders SET status=?,workflow_status=?,logistics_status=?,updated_at=? WHERE id=?")
      .run(target.order, target.workflow, target.logistics, new Date().toISOString(), order.id);
    db.prepare(`INSERT INTO order_status_history
      (id,order_id,previous_status,next_status,changed_by,created_at,reason) VALUES (?,?,?,?, 'naver',?,?)`)
      .run(`history-${crypto.randomUUID()}`, order.id, order.status, target.order, new Date().toISOString(), `NAVER_STATUS_${statuses[0]}`);
    order.status = target.order;
    const saved = saveSync(conversion, order, { externalStatus: statuses[0], sourceChangedAt, syncStatus: "SYNCHRONIZED" }, actor);
    db.exec("COMMIT");
    return publicResult(saved);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { synchronizeNaverOrderStatus };
