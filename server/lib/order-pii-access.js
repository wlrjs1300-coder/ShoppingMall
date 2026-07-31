const crypto = require("node:crypto");
const db = require("../db");

const ORDER_PII_ACCESS_REASONS = Object.freeze([
  "delivery_contact",
  "pickup_contact",
  "order_issue",
  "customer_request",
  "address_verification",
]);
const ORDER_PII_ACCESS_REASON_SET = new Set(ORDER_PII_ACCESS_REASONS);
const ORDER_PII_UPDATE_REASONS = Object.freeze([
  "customer_request",
  "address_correction",
  "phone_correction",
  "name_correction",
  "order_issue",
]);
const ORDER_PII_UPDATE_REASON_SET = new Set(ORDER_PII_UPDATE_REASONS);
const ORDER_PII_CHANGED_FIELD_SET = new Set([
  "customer",
  "phone",
  "deliveryAddress",
  "guestAddress",
]);
const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 30;
const UPDATE_MAX_REQUESTS = 10;
const buckets = new Map();
const updateBuckets = new Map();
let nowProvider = () => Date.now();

function normalizeOrderPiiAccessReason(value) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return ORDER_PII_ACCESS_REASON_SET.has(reason) ? reason : null;
}

function normalizeOrderPiiUpdateReason(value) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return ORDER_PII_UPDATE_REASON_SET.has(reason) ? reason : null;
}

function normalizeChangedFields(fields) {
  if (!Array.isArray(fields)) return [];
  return [...new Set(fields)]
    .filter((field) => ORDER_PII_CHANGED_FIELD_SET.has(field))
    .sort();
}

function normalizeRequestIp(req) {
  const value = typeof req?.ip === "string" ? req.ip.trim() : "";
  return value ? value.slice(0, 100) : null;
}

function insertOrderPiiAudit({
  action,
  orderId,
  actor,
  actorRole,
  reason = null,
  outcome,
  failureCode = null,
  requestIp = null,
  changedFields = [],
}) {
  const safeChangedFields = normalizeChangedFields(changedFields);
  const nextValue = safeChangedFields.length
    ? JSON.stringify({ changedFields: safeChangedFields })
    : null;
  db.prepare(`INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value,
     actor, created_at, reason, outcome, failure_code, actor_role, request_ip)
    VALUES (?, 'SECURITY', ?, 'logs', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `activity-${crypto.randomUUID()}`,
      action === "order_pii_updated"
        ? "Administrator updated protected order information"
        : action === "order_pii_update_failed"
          ? "Protected order information update failed"
          : outcome === "success"
            ? "Administrator accessed protected order information"
            : "Protected order information access failed",
      action,
      orderId || null,
      nextValue,
      actor || "anonymous",
      new Date(nowProvider()).toISOString(),
      reason,
      outcome,
      failureCode,
      actorRole || null,
      requestIp,
    );
}

function recordOrderPiiUpdateFailure(req, {
  orderId = null,
  reason = null,
  failureCode,
  changedFields = [],
}) {
  insertOrderPiiAudit({
    action: "order_pii_update_failed",
    orderId,
    actor: req.admin?.id,
    actorRole: req.admin?.role,
    reason,
    outcome: "failure",
    failureCode,
    requestIp: normalizeRequestIp(req),
    changedFields,
  });
}

function recordOrderPiiAccessFailure(req, { orderId = null, reason = null, failureCode }) {
  insertOrderPiiAudit({
    action: "order_pii_access_failed",
    orderId,
    actor: req.admin?.id,
    actorRole: req.admin?.role,
    reason,
    outcome: "failure",
    failureCode,
    requestIp: normalizeRequestIp(req),
  });
}

function orderPiiAccessLimiter(req, res, next) {
  const now = nowProvider();
  const key = req.admin?.id || "anonymous";
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  for (const [bucketKey, value] of buckets) {
    if (now >= value.resetAt) buckets.delete(bucketKey);
  }
  if (bucket.count <= MAX_REQUESTS) return next();

  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  res.setHeader("Retry-After", String(retryAfter));
  try {
    recordOrderPiiAccessFailure(req, {
      orderId: req.params?.id || null,
      failureCode: "ORDER_PII_RATE_LIMITED",
    });
  } catch {
    // Rate limiting remains fail-closed even when its failure audit cannot be stored.
  }
  return res.status(429).json({
    error: "개인정보 접근 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    reason: "ORDER_PII_RATE_LIMITED",
  });
}

function orderPiiUpdateLimiter(req, res, next) {
  const now = nowProvider();
  const key = req.admin?.id || "anonymous";
  let bucket = updateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    updateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  for (const [bucketKey, value] of updateBuckets) {
    if (now >= value.resetAt) updateBuckets.delete(bucketKey);
  }
  if (bucket.count <= UPDATE_MAX_REQUESTS) return next();

  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  res.setHeader("Retry-After", String(retryAfter));
  try {
    recordOrderPiiUpdateFailure(req, {
      orderId: req.params?.id || null,
      failureCode: "ORDER_PII_UPDATE_RATE_LIMITED",
    });
  } catch {
    // The write limiter remains fail-closed if its failure audit cannot be stored.
  }
  return res.status(429).json({
    error: "개인정보 수정 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    reason: "ORDER_PII_UPDATE_RATE_LIMITED",
  });
}

function resetOrderPiiAccessLimiterForTest() {
  buckets.clear();
  updateBuckets.clear();
  nowProvider = () => Date.now();
}

function setOrderPiiAccessNowForTest(provider) {
  nowProvider = provider;
}

module.exports = {
  MAX_REQUESTS,
  UPDATE_MAX_REQUESTS,
  ORDER_PII_ACCESS_REASONS,
  ORDER_PII_UPDATE_REASONS,
  WINDOW_MS,
  insertOrderPiiAudit,
  normalizeOrderPiiAccessReason,
  normalizeOrderPiiUpdateReason,
  normalizeRequestIp,
  orderPiiAccessLimiter,
  orderPiiUpdateLimiter,
  recordOrderPiiAccessFailure,
  recordOrderPiiUpdateFailure,
  resetOrderPiiAccessLimiterForTest,
  setOrderPiiAccessNowForTest,
};
