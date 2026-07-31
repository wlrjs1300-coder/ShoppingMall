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
const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 30;
const buckets = new Map();
let nowProvider = () => Date.now();

function normalizeOrderPiiAccessReason(value) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return ORDER_PII_ACCESS_REASON_SET.has(reason) ? reason : null;
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
}) {
  db.prepare(`INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value,
     actor, created_at, reason, outcome, failure_code, actor_role, request_ip)
    VALUES (?, 'SECURITY', ?, 'logs', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `activity-${crypto.randomUUID()}`,
      outcome === "success"
        ? "Administrator accessed protected order information"
        : "Protected order information access failed",
      action,
      orderId || null,
      actor || "anonymous",
      new Date(nowProvider()).toISOString(),
      reason,
      outcome,
      failureCode,
      actorRole || null,
      requestIp,
    );
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

function resetOrderPiiAccessLimiterForTest() {
  buckets.clear();
  nowProvider = () => Date.now();
}

function setOrderPiiAccessNowForTest(provider) {
  nowProvider = provider;
}

module.exports = {
  MAX_REQUESTS,
  ORDER_PII_ACCESS_REASONS,
  WINDOW_MS,
  insertOrderPiiAudit,
  normalizeOrderPiiAccessReason,
  normalizeRequestIp,
  orderPiiAccessLimiter,
  recordOrderPiiAccessFailure,
  resetOrderPiiAccessLimiterForTest,
  setOrderPiiAccessNowForTest,
};
