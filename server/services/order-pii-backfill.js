const {
  acquireRunnerLock: acquireCommonRunnerLock,
  isProcessAlive,
  runBusyRetry,
  writeSafeJsonlReport,
} = require("../lib/operations-runner");
const {
  buildOrderPiiColumns,
  decryptOrderPii,
  normalizeOrderPii,
} = require("./order-pii-service");

const CLASSIFICATIONS = Object.freeze({
  LEGACY_VALID: "LEGACY_VALID",
  ENCRYPTED_VALID: "ENCRYPTED_VALID",
  PARTIAL_TUPLE: "PARTIAL_TUPLE",
  UNKNOWN_KEY_VERSION: "UNKNOWN_KEY_VERSION",
  ENCRYPTED_METADATA_MISMATCH: "ENCRYPTED_METADATA_MISMATCH",
  LEGACY_INVALID: "LEGACY_INVALID",
});
const TUPLE_FIELDS = ["pii_ciphertext", "pii_iv", "pii_auth_tag", "pii_key_version"];
const REPORT_FIELDS = [
  "orderId", "classification", "createdAt", "fulfillmentType", "keyVersion",
  "hasCiphertext", "hasIv", "hasAuthTag", "hasKeyVersion",
];

class OrderPiiBackfillError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = "OrderPiiBackfillError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validTimestamp(value) {
  return value === null || value === undefined || value === ""
    || (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
}

function validLegacy(row) {
  const name = typeof row.customer_name === "string" ? row.customer_name.trim() : "";
  const phone = typeof row.customer_phone === "string" ? row.customer_phone.trim() : "";
  const address = typeof row.delivery_address === "string" ? row.delivery_address.trim() : "";
  return Boolean(name)
    && name !== "[protected]"
    && !name.includes("*")
    && /^01\d{8,9}$/.test(phone)
    && ["pickup", "delivery"].includes(row.fulfillment_type)
    && (row.fulfillment_type !== "delivery" || Boolean(address));
}

function classifyOrder(row, keyring) {
  const tuple = TUPLE_FIELDS.map((field) => present(row[field]));
  const tupleParts = tuple.filter(Boolean).length;
  if (tupleParts > 0 && tupleParts < TUPLE_FIELDS.length) return CLASSIFICATIONS.PARTIAL_TUPLE;
  if (tupleParts === TUPLE_FIELDS.length) {
    if (!keyring.hasVersion(row.pii_key_version)) return CLASSIFICATIONS.UNKNOWN_KEY_VERSION;
    if (row.customer_name !== "[protected]"
      || row.customer_phone !== "[protected]"
      || row.delivery_address !== null
      || row.guest_address !== null
      || !present(row.customer_name_masked)
      || !present(row.customer_phone_masked)
      || !validTimestamp(row.pii_migrated_at)) {
      return CLASSIFICATIONS.ENCRYPTED_METADATA_MISMATCH;
    }
    return CLASSIFICATIONS.ENCRYPTED_VALID;
  }
  return validLegacy(row) ? CLASSIFICATIONS.LEGACY_VALID : CLASSIFICATIONS.LEGACY_INVALID;
}

function safeDetail(row, classification) {
  return {
    orderId: String(row.id),
    classification,
    createdAt: row.created_at || null,
    fulfillmentType: row.fulfillment_type || null,
    keyVersion: present(row.pii_key_version) ? row.pii_key_version : null,
    hasCiphertext: present(row.pii_ciphertext),
    hasIv: present(row.pii_iv),
    hasAuthTag: present(row.pii_auth_tag),
    hasKeyVersion: present(row.pii_key_version),
  };
}

function selectRows(db, { afterId, limit } = {}) {
  const clauses = [];
  const params = [];
  if (afterId) {
    clauses.push("id > ?");
    params.push(afterId);
  }
  const sql = `SELECT * FROM orders ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY id${limit ? " LIMIT ?" : ""}`;
  if (limit) params.push(limit);
  return db.prepare(sql).all(...params);
}

function inventoryOrders(db, keyring, options = {}) {
  const rows = selectRows(db, options);
  const counts = Object.fromEntries(Object.values(CLASSIFICATIONS).map((code) => [code, 0]));
  const legacyByFulfillment = {};
  const legacyByOwner = { member: 0, guest: 0 };
  const legacyByMonth = {};
  const details = [];
  for (const row of rows) {
    const classification = classifyOrder(row, keyring);
    counts[classification] += 1;
    if ([CLASSIFICATIONS.LEGACY_VALID, CLASSIFICATIONS.LEGACY_INVALID].includes(classification)) {
      const fulfillment = row.fulfillment_type || "UNKNOWN";
      const month = /^\d{4}-\d{2}/.test(row.created_at || "") ? row.created_at.slice(0, 7) : "UNKNOWN";
      legacyByFulfillment[fulfillment] = (legacyByFulfillment[fulfillment] || 0) + 1;
      legacyByOwner[row.user_id === null ? "guest" : "member"] += 1;
      legacyByMonth[month] = (legacyByMonth[month] || 0) + 1;
    }
    if (classification !== CLASSIFICATIONS.ENCRYPTED_VALID) {
      details.push(safeDetail(row, classification));
    }
  }
  return {
    totalOrders: rows.length,
    legacyValid: counts.LEGACY_VALID,
    encryptedValid: counts.ENCRYPTED_VALID,
    partialTuple: counts.PARTIAL_TUPLE,
    unknownKeyVersion: counts.UNKNOWN_KEY_VERSION,
    encryptedMetadataMismatch: counts.ENCRYPTED_METADATA_MISMATCH,
    legacyInvalid: counts.LEGACY_INVALID,
    legacyByFulfillment,
    legacyByOwner,
    legacyByMonth,
    details,
    finalCursor: rows.at(-1)?.id || afterId || null,
  };
}

function assertApplyReady(inventory, allowInvalidSkip) {
  if (inventory.partialTuple || inventory.unknownKeyVersion) {
    throw new OrderPiiBackfillError("ORDER_PII_INTEGRITY_BLOCKER", "Partial or unknown-key rows block backfill.", 4);
  }
  if (inventory.legacyInvalid && !allowInvalidSkip) {
    throw new OrderPiiBackfillError("ORDER_PII_INVALID_APPROVAL_REQUIRED", "Invalid legacy rows require explicit skip approval.", 4);
  }
}

function backfillOrder(db, row, keyring, migratedAt) {
  const value = normalizeOrderPii({
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    deliveryAddress: row.delivery_address,
    guestAddress: row.guest_address,
  });
  const encrypted = buildOrderPiiColumns(value, keyring, migratedAt);
  return db.prepare(`UPDATE orders SET
    customer_name='[protected]', customer_phone='[protected]',
    delivery_address=NULL, guest_address=NULL,
    pii_ciphertext=?, pii_iv=?, pii_auth_tag=?, pii_key_version=?,
    customer_name_masked=?, customer_phone_masked=?, delivery_region_masked=?,
    pii_migrated_at=?
    WHERE id=?
      AND COALESCE(pii_ciphertext, '')='' AND COALESCE(pii_iv, '')=''
      AND COALESCE(pii_auth_tag, '')='' AND COALESCE(pii_key_version, '')=''
      AND updated_at=?
      AND customer_name=? AND customer_phone=?
      AND delivery_address IS ? AND guest_address IS ?`)
    .run(
      encrypted.piiCiphertext, encrypted.piiIv, encrypted.piiAuthTag, encrypted.piiKeyVersion,
      encrypted.customerNameMasked, encrypted.customerPhoneMasked,
      encrypted.deliveryRegionMasked, encrypted.piiMigratedAt,
      row.id, row.updated_at, row.customer_name, row.customer_phone,
      row.delivery_address, row.guest_address,
    );
}

function applyBackfill(db, keyring, options = {}) {
  const batchSize = options.batchSize || 100;
  const scopedInventory = inventoryOrders(db, keyring, options);
  assertApplyReady(inventoryOrders(db, keyring), options.allowInvalidSkip);
  const targetIds = selectRows(db, options)
    .filter((row) => classifyOrder(row, keyring) === CLASSIFICATIONS.LEGACY_VALID)
    .map((row) => row.id);
  let processed = 0;
  let finalCursor = options.afterId || null;
  for (let offset = 0; offset < targetIds.length; offset += batchSize) {
    const ids = targetIds.slice(offset, offset + batchSize);
    runBusyRetry(() => db.exec("BEGIN IMMEDIATE"), options);
    try {
      for (const id of ids) {
        const row = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
        if (!row || classifyOrder(row, keyring) !== CLASSIFICATIONS.LEGACY_VALID) {
          throw new OrderPiiBackfillError("ORDER_PII_CONCURRENT_CHANGE", "Order changed during backfill.", 5);
        }
        options.beforeUpdate?.(row, processed);
        const result = backfillOrder(db, row, keyring, (options.now?.() || new Date()).toISOString());
        if (result.changes !== 1) {
          throw new OrderPiiBackfillError("ORDER_PII_CONCURRENT_CHANGE", "Order changed during backfill.", 5);
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
  return {
    ...scopedInventory,
    processed,
    skipped: scopedInventory.totalOrders - processed,
    finalCursor,
  };
}

function verifyBackfill(db, keyring, options = {}) {
  const inventory = inventoryOrders(db, keyring);
  let decryptSuccess = 0;
  const failures = [];
  const batchSize = options.batchSize || 100;
  let afterId = null;
  for (;;) {
    const rows = selectRows(db, { afterId, limit: batchSize });
    if (!rows.length) break;
    for (const row of rows) {
      if (classifyOrder(row, keyring) !== CLASSIFICATIONS.ENCRYPTED_VALID) continue;
      try {
        decryptOrderPii(row, keyring);
        decryptSuccess += 1;
      } catch {
        failures.push({ ...safeDetail(row, "DECRYPT_FAILED"), safeErrorCode: "ORDER_PII_DECRYPTION_FAILED" });
      }
    }
    afterId = rows.at(-1).id;
  }
  const failed = inventory.legacyValid > 0
    || inventory.legacyInvalid > 0
    || inventory.partialTuple > 0
    || inventory.unknownKeyVersion > 0
    || inventory.encryptedMetadataMismatch > 0
    || failures.length > 0;
  return { ...inventory, decryptSuccess, decryptFailure: failures.length, failures, ok: !failed };
}

function writeSafeReport(reportPath, result) {
  const records = [...(result.details || []), ...(result.failures || [])];
  return writeSafeJsonlReport(reportPath, records, [...REPORT_FIELDS, "safeErrorCode"], {
    reportExistsCode: "ORDER_PII_REPORT_EXISTS",
    reportFailedCode: "ORDER_PII_REPORT_FAILED",
    errorFactory: (code, message, exitCode) => new OrderPiiBackfillError(code, message, exitCode),
  });
}

function acquireRunnerLock(lockPath, mode, options = {}) {
  return acquireCommonRunnerLock(lockPath, mode, {
    ...options,
    lockConflictCode: "ORDER_PII_LOCK_CONFLICT",
    errorFactory: (code, message, exitCode) => new OrderPiiBackfillError(code, message, exitCode),
  });
}

module.exports = {
  CLASSIFICATIONS,
  OrderPiiBackfillError,
  acquireRunnerLock,
  applyBackfill,
  classifyOrder,
  inventoryOrders,
  isProcessAlive,
  safeDetail,
  verifyBackfill,
  writeSafeReport,
};
