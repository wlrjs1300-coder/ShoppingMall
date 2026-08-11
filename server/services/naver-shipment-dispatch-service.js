const crypto = require("node:crypto");
const defaultDb = require("../db");

const SAFE_REASONS = new Set([
  "NAVER_SHIPMENT_WRITE_DISABLED",
  "NAVER_SHIPMENT_REQUEST_INVALID",
  "NAVER_SHIPMENT_ORDER_NOT_FOUND",
  "NAVER_SHIPMENT_ORDER_NOT_ELIGIBLE",
  "NAVER_SHIPMENT_CONVERSION_NOT_FOUND",
  "NAVER_SHIPMENT_PRODUCT_ORDER_MISSING",
  "NAVER_SHIPMENT_CLAIM_REVIEW_REQUIRED",
  "NAVER_SHIPMENT_ALREADY_PROCESSING",
  "NAVER_SHIPMENT_PROVIDER_REJECTED",
  "NAVER_SHIPMENT_PROVIDER_UNCERTAIN",
  "NAVER_SHIPMENT_READ_DISABLED",
  "NAVER_SHIPMENT_RECONCILIATION_NOT_REQUIRED",
  "NAVER_SHIPMENT_NOT_DISPATCHED",
  "NAVER_SHIPMENT_PARTIALLY_DISPATCHED",
]);

class NaverShipmentDispatchError extends Error {
  constructor(reason, status = 400) {
    super(reason);
    this.name = "NaverShipmentDispatchError";
    this.reason = SAFE_REASONS.has(reason) ? reason : "NAVER_SHIPMENT_PROVIDER_UNCERTAIN";
    this.status = status;
  }
}

function disabledProvider() {
  return {
    async dispatchShipment() {
      throw new NaverShipmentDispatchError("NAVER_SHIPMENT_WRITE_DISABLED", 503);
    },
    async getShipmentStatuses() {
      throw new NaverShipmentDispatchError("NAVER_SHIPMENT_READ_DISABLED", 503);
    },
  };
}

function normalizeCarrierCodes(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return new Set(values.map((item) => String(item).trim().toUpperCase()).filter(Boolean));
}

function normalizeInput(input, allowedCarrierCodes) {
  const carrierCode = String(input.carrierCode || "").trim().toUpperCase();
  const trackingNumber = String(input.trackingNumber || "").replace(/[\s-]/g, "").trim();
  if (!/^[A-Z0-9_]{2,30}$/.test(carrierCode)
    || !allowedCarrierCodes.has(carrierCode)
    || !/^[A-Z0-9]{6,40}$/i.test(trackingNumber)) {
    throw new NaverShipmentDispatchError("NAVER_SHIPMENT_REQUEST_INVALID", 400);
  }
  return { carrierCode, trackingNumber };
}

function maskTracking(value) {
  const text = String(value || "");
  return text ? `***${text.slice(-4)}` : null;
}

function publicResult(row, extra = {}) {
  return {
    id: row.id,
    internalOrderId: row.internal_order_id,
    status: row.dispatch_status,
    reason: SAFE_REASONS.has(row.safe_error_code) ? row.safe_error_code : null,
    carrierCode: row.carrier_code,
    trackingNumberMasked: maskTracking(row.tracking_number),
    attemptCount: row.attempt_count,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    reconciliationAttemptCount: row.reconciliation_attempt_count || 0,
    lastReconciledAt: row.last_reconciled_at || null,
    ...extra,
  };
}

function classifyProviderError(error) {
  if (error instanceof NaverShipmentDispatchError) return error;
  const status = Number(error?.status || error?.statusCode || 0);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return new NaverShipmentDispatchError("NAVER_SHIPMENT_PROVIDER_REJECTED", 502);
  }
  return new NaverShipmentDispatchError("NAVER_SHIPMENT_PROVIDER_UNCERTAIN", 502);
}

function createNaverShipmentDispatchService({
  db = defaultDb,
  provider = disabledProvider(),
  allowedCarrierCodes = process.env.NAVER_SHIPMENT_CARRIER_CODES,
  now = () => new Date().toISOString(),
} = {}) {
  const carrierCodes = normalizeCarrierCodes(allowedCarrierCodes);

  function get(orderId) {
    const row = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE channel='naver' AND internal_order_id=?").get(orderId);
    return row ? publicResult(row) : null;
  }

  function audit(action, dispatch, actor) {
    try {
      db.prepare(`INSERT INTO activity_logs
        (id,category,message,tab,action,entity_id,previous_value,next_value,actor,created_at)
        VALUES (?,'INTEGRATION',?,'sales-channels',?,?,NULL,?,?,?)`).run(
        `activity-${crypto.randomUUID()}`,
        JSON.stringify({ status: dispatch.dispatch_status, reason: dispatch.safe_error_code || null,
          trackingReference: maskTracking(dispatch.tracking_number) }),
        action, dispatch.id, dispatch.dispatch_status, actor || "system", now(),
      );
    } catch { /* shipment recovery must not depend on audit storage */ }
  }

  function loadEligible(orderId) {
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
    if (!order || order.source_channel !== "naver") {
      throw new NaverShipmentDispatchError("NAVER_SHIPMENT_ORDER_NOT_FOUND", 404);
    }
    if (order.fulfillment_type !== "delivery" || order.payment_status !== "결제완료" || order.status !== "준비완료") {
      throw new NaverShipmentDispatchError("NAVER_SHIPMENT_ORDER_NOT_ELIGIBLE", 409);
    }
    const conversion = db.prepare(`SELECT * FROM sales_channel_order_conversions
      WHERE channel='naver' AND internal_order_id=? AND conversion_status='CONVERTED'`).get(orderId);
    if (!conversion) throw new NaverShipmentDispatchError("NAVER_SHIPMENT_CONVERSION_NOT_FOUND", 409);
    const items = db.prepare(`SELECT external_product_order_id,external_claim_type,external_claim_status
      FROM sales_channel_order_import_items WHERE channel_order_import_id=? ORDER BY id`).all(conversion.channel_order_import_id);
    if (!items.length || items.some((item) => !item.external_product_order_id)) {
      throw new NaverShipmentDispatchError("NAVER_SHIPMENT_PRODUCT_ORDER_MISSING", 409);
    }
    if (items.some((item) => item.external_claim_type || item.external_claim_status)) {
      throw new NaverShipmentDispatchError("NAVER_SHIPMENT_CLAIM_REVIEW_REQUIRED", 409);
    }
    return { order, conversion, productOrderIds: items.map((item) => item.external_product_order_id) };
  }

  function loadProductOrderIds(conversionId) {
    const conversion = db.prepare("SELECT * FROM sales_channel_order_conversions WHERE id=? AND channel='naver'").get(conversionId);
    if (!conversion) throw new NaverShipmentDispatchError("NAVER_SHIPMENT_CONVERSION_NOT_FOUND", 409);
    const items = db.prepare(`SELECT external_product_order_id FROM sales_channel_order_import_items
      WHERE channel_order_import_id=? ORDER BY id`).all(conversion.channel_order_import_id);
    if (!items.length || items.some((item) => !item.external_product_order_id)) {
      throw new NaverShipmentDispatchError("NAVER_SHIPMENT_PRODUCT_ORDER_MISSING", 409);
    }
    return items.map((item) => item.external_product_order_id);
  }

  function completeInternalOrder(dispatchRow, actor, historyReason) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT * FROM orders WHERE id=?").get(dispatchRow.internal_order_id);
      if (!current) throw new NaverShipmentDispatchError("NAVER_SHIPMENT_ORDER_NOT_FOUND", 404);
      const completedAt = now();
      db.prepare(`UPDATE sales_channel_shipment_dispatches SET dispatch_status='SUCCEEDED',safe_error_code=NULL,
        lock_token=NULL,completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=?`).run(
        completedAt, completedAt, dispatchRow.id,
      );
      if (current.status !== "배송중" && current.status !== "배송완료") {
        db.prepare("UPDATE orders SET status='배송중',workflow_status='배송중',logistics_status='배송중',updated_at=? WHERE id=?")
          .run(completedAt, current.id);
        db.prepare(`INSERT INTO order_status_history
          (id,order_id,previous_status,next_status,changed_by,created_at,reason)
          VALUES (?,?,?,'배송중','naver',?,?)`).run(
          `history-${crypto.randomUUID()}`, current.id, current.status, completedAt, historyReason,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
    const succeeded = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE id=?").get(dispatchRow.id);
    audit("naver_shipment_dispatch_succeeded", succeeded, actor);
    return publicResult(succeeded);
  }

  async function dispatch({ orderId, carrierCode, trackingNumber, actor = "system", signal } = {}) {
    const normalizedOrderId = String(orderId || "").trim();
    if (!normalizedOrderId) throw new NaverShipmentDispatchError("NAVER_SHIPMENT_REQUEST_INVALID", 400);
    const input = normalizeInput({ carrierCode, trackingNumber }, carrierCodes);
    const completed = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE channel='naver' AND internal_order_id=? AND dispatch_status='SUCCEEDED'").get(normalizedOrderId);
    if (completed) return publicResult(completed, { replayed: true });
    const eligible = loadEligible(normalizedOrderId);
    const lockToken = crypto.randomUUID();
    const requestedAt = now();
    let dispatchRow;

    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE channel='naver' AND internal_order_id=?").get(normalizedOrderId);
      if (existing?.dispatch_status === "SUCCEEDED") {
        db.exec("COMMIT");
        return publicResult(existing, { replayed: true });
      }
      if (existing?.dispatch_status === "PROCESSING") {
        db.exec("ROLLBACK");
        throw new NaverShipmentDispatchError("NAVER_SHIPMENT_ALREADY_PROCESSING", 409);
      }
      if (existing) {
        db.prepare(`UPDATE sales_channel_shipment_dispatches SET carrier_code=?,tracking_number=?,
          dispatch_status='PROCESSING',attempt_count=attempt_count+1,safe_error_code=NULL,lock_token=?,
          requested_at=?,completed_at=NULL,updated_at=? WHERE id=?`).run(
          input.carrierCode, input.trackingNumber, lockToken, requestedAt, requestedAt, existing.id,
        );
        dispatchRow = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE id=?").get(existing.id);
      } else {
        const id = `shipment-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO sales_channel_shipment_dispatches
          (id,channel,internal_order_id,conversion_id,carrier_code,tracking_number,dispatch_status,
           attempt_count,lock_token,requested_at,updated_at)
          VALUES (?,'naver',?,?,?,?, 'PROCESSING',1,?,?,?)`).run(
          id, normalizedOrderId, eligible.conversion.id, input.carrierCode, input.trackingNumber,
          lockToken, requestedAt, requestedAt,
        );
        dispatchRow = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE id=?").get(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }

    let response;
    try {
      response = await provider.dispatchShipment({
        productOrderIds: eligible.productOrderIds,
        carrierCode: input.carrierCode,
        trackingNumber: input.trackingNumber,
        dispatchedAt: requestedAt,
        signal,
      });
    } catch (error) {
      const safe = classifyProviderError(error);
      const uncertain = safe.reason === "NAVER_SHIPMENT_PROVIDER_UNCERTAIN";
      db.prepare(`UPDATE sales_channel_shipment_dispatches SET dispatch_status=?,safe_error_code=?,
        lock_token=NULL,completed_at=?,updated_at=? WHERE id=? AND lock_token=?`).run(
        uncertain ? "RECONCILE_REQUIRED" : "FAILED", safe.reason, now(), now(), dispatchRow.id, lockToken,
      );
      const failed = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE id=?").get(dispatchRow.id);
      audit("naver_shipment_dispatch_failed", failed, actor);
      throw safe;
    }

    const results = Array.isArray(response?.results) ? response.results : [];
    const expected = new Set(eligible.productOrderIds);
    const returned = new Set(results.map((item) => String(item.productOrderId)));
    const valid = results.length === expected.size && returned.size === expected.size
      && results.every((item) => expected.has(String(item.productOrderId))
        && ["SUCCESS", "ALREADY_DISPATCHED"].includes(item.status));
    if (!valid) {
      db.prepare(`UPDATE sales_channel_shipment_dispatches SET dispatch_status='RECONCILE_REQUIRED',
        safe_error_code='NAVER_SHIPMENT_PROVIDER_UNCERTAIN',lock_token=NULL,completed_at=?,updated_at=?
        WHERE id=? AND lock_token=?`).run(now(), now(), dispatchRow.id, lockToken);
      const uncertain = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE id=?").get(dispatchRow.id);
      audit("naver_shipment_dispatch_reconcile_required", uncertain, actor);
      return publicResult(uncertain);
    }

    return completeInternalOrder(dispatchRow, actor, "NAVER_SHIPMENT_DISPATCHED");
  }

  async function reconcile({ orderId, actor = "system", signal } = {}) {
    const normalizedOrderId = String(orderId || "").trim();
    if (!normalizedOrderId) throw new NaverShipmentDispatchError("NAVER_SHIPMENT_REQUEST_INVALID", 400);
    const lockToken = crypto.randomUUID();
    let dispatchRow;
    db.exec("BEGIN IMMEDIATE");
    try {
      dispatchRow = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE channel='naver' AND internal_order_id=?").get(normalizedOrderId);
      if (!dispatchRow) throw new NaverShipmentDispatchError("NAVER_SHIPMENT_ORDER_NOT_FOUND", 404);
      if (dispatchRow.dispatch_status === "SUCCEEDED") {
        db.exec("COMMIT");
        return publicResult(dispatchRow, { replayed: true });
      }
      if (dispatchRow.dispatch_status !== "RECONCILE_REQUIRED") {
        throw new NaverShipmentDispatchError("NAVER_SHIPMENT_RECONCILIATION_NOT_REQUIRED", 409);
      }
      if (dispatchRow.lock_token) throw new NaverShipmentDispatchError("NAVER_SHIPMENT_ALREADY_PROCESSING", 409);
      db.prepare(`UPDATE sales_channel_shipment_dispatches SET lock_token=?,
        reconciliation_attempt_count=reconciliation_attempt_count+1,updated_at=? WHERE id=?`).run(lockToken, now(), dispatchRow.id);
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }

    const productOrderIds = loadProductOrderIds(dispatchRow.conversion_id);
    let response;
    try {
      response = await provider.getShipmentStatuses({ productOrderIds, signal });
    } catch (error) {
      const safe = error instanceof NaverShipmentDispatchError
        ? error : new NaverShipmentDispatchError("NAVER_SHIPMENT_PROVIDER_UNCERTAIN", 502);
      const reconciledAt = now();
      db.prepare(`UPDATE sales_channel_shipment_dispatches SET lock_token=NULL,
        safe_error_code=?,last_reconciled_at=?,updated_at=? WHERE id=? AND lock_token=?`).run(
        safe.reason, reconciledAt, reconciledAt, dispatchRow.id, lockToken,
      );
      const unchanged = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE id=?").get(dispatchRow.id);
      audit("naver_shipment_reconciliation_failed", unchanged, actor);
      throw safe;
    }

    const results = Array.isArray(response?.results) ? response.results : [];
    const expected = new Set(productOrderIds);
    const returned = new Set(results.map((item) => String(item.productOrderId)));
    const structurallyValid = results.length === expected.size && returned.size === expected.size
      && results.every((item) => expected.has(String(item.productOrderId))
        && ["DISPATCHED", "NOT_DISPATCHED", "UNKNOWN"].includes(item.status));
    const statuses = structurallyValid ? new Set(results.map((item) => item.status)) : new Set(["UNKNOWN"]);
    const reconciledAt = now();

    if (statuses.size === 1 && statuses.has("DISPATCHED")) {
      db.prepare(`UPDATE sales_channel_shipment_dispatches SET lock_token=NULL,last_reconciled_at=?,updated_at=?
        WHERE id=? AND lock_token=?`).run(reconciledAt, reconciledAt, dispatchRow.id, lockToken);
      return completeInternalOrder(dispatchRow, actor, "NAVER_SHIPMENT_RECONCILED");
    }
    if (statuses.size === 1 && statuses.has("NOT_DISPATCHED")) {
      db.prepare(`UPDATE sales_channel_shipment_dispatches SET dispatch_status='FAILED',
        safe_error_code='NAVER_SHIPMENT_NOT_DISPATCHED',lock_token=NULL,last_reconciled_at=?,updated_at=?
        WHERE id=? AND lock_token=?`).run(reconciledAt, reconciledAt, dispatchRow.id, lockToken);
      const retryable = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE id=?").get(dispatchRow.id);
      audit("naver_shipment_reconciliation_not_dispatched", retryable, actor);
      return publicResult(retryable);
    }
    db.prepare(`UPDATE sales_channel_shipment_dispatches SET safe_error_code='NAVER_SHIPMENT_PARTIALLY_DISPATCHED',
      lock_token=NULL,last_reconciled_at=?,updated_at=? WHERE id=? AND lock_token=?`).run(
      reconciledAt, reconciledAt, dispatchRow.id, lockToken,
    );
    const review = db.prepare("SELECT * FROM sales_channel_shipment_dispatches WHERE id=?").get(dispatchRow.id);
    audit("naver_shipment_reconciliation_review", review, actor);
    return publicResult(review);
  }

  return { dispatch, get, reconcile };
}

module.exports = {
  NaverShipmentDispatchError,
  createNaverShipmentDispatchService,
  disabledProvider,
};
