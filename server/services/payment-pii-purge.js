const {
  acquireRunnerLock: acquireCommonRunnerLock,
  isProcessAlive,
  runBusyRetry,
  writeSafeJsonlReport,
} = require("../lib/operations-runner");

const CLASSIFICATIONS = Object.freeze({
  PAYMENT_SAFE: "PAYMENT_SAFE",
  PAYMENT_LEGACY_PII_CONNECTED: "PAYMENT_LEGACY_PII_CONNECTED",
  PAYMENT_LEGACY_PII_ORPHAN: "PAYMENT_LEGACY_PII_ORPHAN",
  PAYMENT_ORPHAN_SAFE: "PAYMENT_ORPHAN_SAFE",
});
const KNOWN_STATUSES = new Set([
  "PENDING", "FAILED", "CONFIRMING", "DONE", "CANCELED", "PARTIAL_CANCELED",
  "RECONCILE_REQUIRED", "CANCELING",
]);
const REPORT_FIELDS = [
  "paymentId", "orderId", "classification", "status", "requestedAt",
  "hasCustomerName", "hasCustomerPhone", "hasOrder", "orderPiiMode",
  "linkUsed", "hasSession", "safeMetadataWarnings",
];

class PaymentPiiPurgeError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = "PaymentPiiPurgeError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function orderPiiMode(row) {
  if (!row.has_order) return "NO_ORDER";
  const fields = ["order_pii_ciphertext", "order_pii_iv", "order_pii_auth_tag", "order_pii_key_version"];
  const parts = fields.filter((field) => present(row[field])).length;
  if (parts === fields.length) return "ENCRYPTED";
  if (parts === 0) return "LEGACY";
  return "PARTIAL";
}

function metadataWarnings(row) {
  const warnings = [];
  if (!present(row.order_id)) warnings.push("PAYMENT_ORDER_ID_EMPTY");
  if (!KNOWN_STATUSES.has(row.status)) warnings.push("PAYMENT_STATUS_UNKNOWN");
  if (!present(row.requested_at) || !Number.isFinite(Date.parse(row.requested_at))) {
    warnings.push("PAYMENT_REQUESTED_AT_INVALID");
  }
  if (present(row.link_token_hash) !== present(row.link_token_expires_at)) {
    warnings.push("PAYMENT_LINK_METADATA_INCOMPLETE");
  }
  if (present(row.link_token_used_at) && !present(row.link_token_hash)) {
    warnings.push("PAYMENT_LINK_USED_WITHOUT_HASH");
  }
  if (present(row.session_token_hash) !== present(row.session_token_expires_at)) {
    warnings.push("PAYMENT_SESSION_METADATA_INCOMPLETE");
  }
  if (present(row.session_token_hash) && !present(row.link_token_used_at)) {
    warnings.push("PAYMENT_SESSION_WITHOUT_LINK_USE");
  }
  return warnings;
}

function classifyPayment(row) {
  const hasPii = present(row.customer_name) || present(row.customer_phone);
  if (row.has_order) {
    return hasPii ? CLASSIFICATIONS.PAYMENT_LEGACY_PII_CONNECTED : CLASSIFICATIONS.PAYMENT_SAFE;
  }
  return hasPii ? CLASSIFICATIONS.PAYMENT_LEGACY_PII_ORPHAN : CLASSIFICATIONS.PAYMENT_ORPHAN_SAFE;
}

function safeDetail(row, classification = classifyPayment(row), warnings = metadataWarnings(row)) {
  return {
    paymentId: String(row.id),
    orderId: row.order_id || null,
    classification,
    status: row.status || null,
    requestedAt: row.requested_at || null,
    hasCustomerName: present(row.customer_name),
    hasCustomerPhone: present(row.customer_phone),
    hasOrder: Boolean(row.has_order),
    orderPiiMode: orderPiiMode(row),
    linkUsed: present(row.link_token_used_at),
    hasSession: present(row.session_token_hash),
    safeMetadataWarnings: warnings,
  };
}

const JOIN_COLUMNS = `p.*,
  CASE WHEN o.id IS NULL THEN 0 ELSE 1 END AS has_order,
  o.pii_ciphertext AS order_pii_ciphertext, o.pii_iv AS order_pii_iv,
  o.pii_auth_tag AS order_pii_auth_tag, o.pii_key_version AS order_pii_key_version`;

function selectRows(db, { afterId, limit } = {}) {
  const where = afterId ? "WHERE p.id > ?" : "";
  const params = afterId ? [afterId] : [];
  if (limit) params.push(limit);
  return db.prepare(`SELECT ${JOIN_COLUMNS} FROM payments p LEFT JOIN orders o ON o.id=p.order_id
    ${where} ORDER BY p.id${limit ? " LIMIT ?" : ""}`).all(...params);
}

function increment(object, key) {
  object[key] = (object[key] || 0) + 1;
}

function inventoryPayments(db, options = {}) {
  const rows = selectRows(db, options);
  const counts = Object.fromEntries(Object.values(CLASSIFICATIONS).map((value) => [value, 0]));
  const byStatus = {};
  const byMonth = {};
  const byLinkState = {};
  const bySessionState = {};
  const byOrderPiiMode = {};
  const warningCounts = {};
  const details = [];
  for (const row of rows) {
    const classification = classifyPayment(row);
    const warnings = metadataWarnings(row);
    counts[classification] += 1;
    increment(byStatus, row.status || "UNKNOWN");
    increment(byMonth, /^\d{4}-\d{2}/.test(row.requested_at || "") ? row.requested_at.slice(0, 7) : "UNKNOWN");
    increment(byLinkState, present(row.link_token_used_at) ? "USED"
      : (present(row.link_token_hash) ? "AVAILABLE" : "NONE"));
    increment(bySessionState, present(row.session_token_hash) ? "PRESENT" : "NONE");
    increment(byOrderPiiMode, orderPiiMode(row));
    for (const warning of warnings) increment(warningCounts, warning);
    if (classification !== CLASSIFICATIONS.PAYMENT_SAFE || warnings.length > 0) {
      details.push(safeDetail(row, classification, warnings));
    }
  }
  return {
    totalPayments: rows.length,
    paymentSafe: counts.PAYMENT_SAFE,
    legacyPiiConnected: counts.PAYMENT_LEGACY_PII_CONNECTED,
    legacyPiiOrphan: counts.PAYMENT_LEGACY_PII_ORPHAN,
    orphanSafe: counts.PAYMENT_ORPHAN_SAFE,
    byStatus, byMonth, byLinkState, bySessionState, byOrderPiiMode, warningCounts, details,
    finalCursor: rows.at(-1)?.id || options.afterId || null,
  };
}

function applyPurge(db, options = {}) {
  const scoped = inventoryPayments(db, options);
  const targetIds = selectRows(db, options)
    .filter((row) => classifyPayment(row) === CLASSIFICATIONS.PAYMENT_LEGACY_PII_CONNECTED)
    .map((row) => row.id);
  let processed = 0;
  let finalCursor = options.afterId || null;
  const batchSize = options.batchSize || 500;
  for (let offset = 0; offset < targetIds.length; offset += batchSize) {
    const ids = targetIds.slice(offset, offset + batchSize);
    runBusyRetry(() => db.exec("BEGIN IMMEDIATE"), options);
    try {
      for (const id of ids) {
        const row = db.prepare(`SELECT ${JOIN_COLUMNS} FROM payments p
          LEFT JOIN orders o ON o.id=p.order_id WHERE p.id=?`).get(id);
        if (!row || classifyPayment(row) !== CLASSIFICATIONS.PAYMENT_LEGACY_PII_CONNECTED) {
          throw new PaymentPiiPurgeError("PAYMENT_PII_CONCURRENT_CHANGE",
            "Payment changed during purge.", 5);
        }
        options.beforeUpdate?.(row, processed);
        const update = db.prepare(`UPDATE payments SET customer_name=NULL, customer_phone=NULL
          WHERE id=? AND order_id=? AND customer_name IS ? AND customer_phone IS ?`)
          .run(row.id, row.order_id, row.customer_name, row.customer_phone);
        if (update.changes !== 1) {
          throw new PaymentPiiPurgeError("PAYMENT_PII_CONCURRENT_CHANGE",
            "Payment changed during purge.", 5);
        }
        processed += 1;
        finalCursor = id;
      }
      runBusyRetry(() => db.exec("COMMIT"), options);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  return { ...scoped, processed, skipped: scoped.totalPayments - processed, finalCursor };
}

function verifyPurge(db, options = {}) {
  const inventory = inventoryPayments(db);
  return {
    ...inventory,
    ok: inventory.legacyPiiConnected === 0 && inventory.legacyPiiOrphan === 0,
    batchSize: options.batchSize || 500,
  };
}

function writeSafeReport(reportPath, result) {
  return writeSafeJsonlReport(reportPath, result.details || [], REPORT_FIELDS, {
    reportExistsCode: "PAYMENT_PII_REPORT_EXISTS",
    reportFailedCode: "PAYMENT_PII_REPORT_FAILED",
    errorFactory: (code, message, exitCode) => new PaymentPiiPurgeError(code, message, exitCode),
  });
}

function acquireRunnerLock(lockPath, mode, options = {}) {
  return acquireCommonRunnerLock(lockPath, mode, {
    ...options,
    lockConflictCode: "PAYMENT_PII_LOCK_CONFLICT",
    errorFactory: (code, message, exitCode) => new PaymentPiiPurgeError(code, message, exitCode),
  });
}

module.exports = {
  CLASSIFICATIONS,
  KNOWN_STATUSES,
  PaymentPiiPurgeError,
  acquireRunnerLock,
  applyPurge,
  classifyPayment,
  inventoryPayments,
  isProcessAlive,
  metadataWarnings,
  safeDetail,
  verifyPurge,
  writeSafeReport,
};
