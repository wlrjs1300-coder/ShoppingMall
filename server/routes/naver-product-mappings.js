const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { getDefaultNaverCommerceClient } = require("../services/naver-commerce-client");
const {
  NaverProductError,
  createNaverProductService,
  createSellerManagementCode,
  validateExternalProductForNaverMapping,
  validateInternalProductForNaverMapping,
} = require("../services/naver-product-service");

const router = express.Router();
const defaultService = createNaverProductService({ client: getDefaultNaverCommerceClient() });
const defaultServiceFactory = () => defaultService;
let serviceFactory = defaultServiceFactory;
const MAPPING_STATUSES = new Set([
  "ACTIVE", "DISABLED", "PENDING_VERIFICATION", "UNSUPPORTED_OPTION",
  "INVALID_INTERNAL_PRODUCT", "EXTERNAL_NOT_FOUND", "CONFLICT",
]);
const SELLER_CODE_STATUSES = new Set(["MATCHED", "MISSING", "MISMATCH"]);

function parsePage(value, fallback, maximum) {
  const number = value === undefined ? fallback : Number(value);
  return Number.isInteger(number) && number >= 1 && (!maximum || number <= maximum) ? number : null;
}

function rowToMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    internalProductId: row.internal_product_id,
    externalOriginProductNo: row.external_origin_product_no,
    externalChannelProductNo: row.external_channel_product_no,
    externalGroupProductNo: row.external_group_product_no,
    sellerManagementCode: row.seller_management_code,
    sellerManagementCodeStatus: sellerCodeStatus(row.internal_product_id, row.seller_management_code),
    channelServiceType: row.channel_service_type,
    externalProductName: row.external_product_name,
    externalStatus: row.external_status,
    mappingStatus: row.mapping_status,
    inventorySyncEnabled: row.inventory_sync_enabled === 1,
    priceSyncEnabled: row.price_sync_enabled === 1,
    safetyStock: row.safety_stock,
    lastVerifiedAt: row.last_verified_at,
    lastProductSyncAt: row.last_product_sync_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sellerCodeStatus(internalId, actual) {
  if (!actual) return "MISSING";
  return actual === createSellerManagementCode(internalId) ? "MATCHED" : "MISMATCH";
}

function maskedExternalId(value) {
  return value ? `***${value.slice(-4)}` : null;
}

function insertAudit(action, req, mapping, previousValue, nextValue, detail = null) {
  db.prepare(`INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
    VALUES (?, 'INTEGRATION', ?, 'sales-channels', ?, ?, ?, ?, ?, ?)`)
    .run(
      `activity-${crypto.randomUUID()}`,
      JSON.stringify({
        internalProductId: mapping.internal_product_id,
        externalChannelProductNo: maskedExternalId(mapping.external_channel_product_no),
        detail,
      }),
      action, mapping.id, previousValue, nextValue, req.admin.id, new Date().toISOString(),
    );
}

function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function safeError(res, error) {
  if (error instanceof NaverProductError) {
    return res.status(error.status || 400).json({ error: error.safeMessage, reason: error.reason });
  }
  if (error?.status === 404) {
    return res.status(404).json({ error: "네이버 상품을 찾을 수 없습니다.", reason: "NAVER_PRODUCT_NOT_FOUND" });
  }
  const reason = typeof error?.code === "string" && error.code.startsWith("NAVER_")
    ? error.code : "NAVER_PRODUCT_REQUEST_FAILED";
  return res.status(502).json({ error: "네이버 상품 정보를 확인하지 못했습니다.", reason });
}

router.post("/naver/products/search", requireAuth, requirePermission("sales_channels:read"), async (req, res) => {
  try {
    return res.json(await serviceFactory().searchProducts(req.body || {}));
  } catch (error) {
    return safeError(res, error);
  }
});

router.get("/naver/product-mappings", requireAuth, requirePermission("sales_channels:read"), (req, res) => {
  const page = parsePage(req.query.page, 1);
  const size = parsePage(req.query.size, 50, 100);
  const sellerStatus = req.query.sellerManagementCodeStatus;
  if (!page || !size || (req.query.mappingStatus && !MAPPING_STATUSES.has(req.query.mappingStatus))
    || (sellerStatus && !SELLER_CODE_STATUSES.has(sellerStatus))) {
    return res.status(400).json({ error: "매핑 조회 조건이 올바르지 않습니다.", reason: "PRODUCT_MAPPING_INVALID" });
  }
  const clauses = ["channel='naver'"];
  const values = [];
  if (req.query.mappingStatus) { clauses.push("mapping_status=?"); values.push(req.query.mappingStatus); }
  if (req.query.internalProductId) { clauses.push("internal_product_id=?"); values.push(req.query.internalProductId); }
  const where = clauses.join(" AND ");
  // This derived state uses the same normalization as code generation. Fetch
  // DB-filtered candidates before slicing; persist/index it if volume grows.
  let candidates = db.prepare(`SELECT * FROM sales_channel_product_mappings WHERE ${where}
    ORDER BY created_at DESC`).all(...values).map(rowToMapping);
  if (sellerStatus) candidates = candidates.filter((item) => item.sellerManagementCodeStatus === sellerStatus);
  const total = candidates.length;
  const items = candidates.slice((page - 1) * size, page * size);
  return res.json({ items, page, size, total, first: page === 1, last: page * size >= total });
});

router.get("/naver/product-mappings/:id", requireAuth, requirePermission("sales_channels:read"), (req, res) => {
  const mapping = db.prepare("SELECT * FROM sales_channel_product_mappings WHERE id=? AND channel='naver'").get(req.params.id);
  if (!mapping) return res.status(404).json({ error: "상품 매핑을 찾을 수 없습니다.", reason: "PRODUCT_MAPPING_NOT_FOUND" });
  return res.json(rowToMapping(mapping));
});

router.post("/naver/product-mappings", requireAuth, requirePermission("sales_channels:manage"), async (req, res) => {
  const internalProductId = typeof req.body?.internalProductId === "string" ? req.body.internalProductId.trim() : "";
  const channelProductNo = typeof req.body?.channelProductNo === "string" ? req.body.channelProductNo : "";
  if (!internalProductId || !/^[1-9]\d*$/.test(channelProductNo)) {
    return res.status(400).json({ error: "상품 매핑 입력이 올바르지 않습니다.", reason: "PRODUCT_MAPPING_INVALID" });
  }
  const existingSame = db.prepare(`SELECT * FROM sales_channel_product_mappings
    WHERE channel='naver' AND internal_product_id=? AND external_channel_product_no=?`).get(internalProductId, channelProductNo);
  if (existingSame) return res.json(rowToMapping(existingSame));
  const existingConflict = db.prepare(`SELECT * FROM sales_channel_product_mappings
    WHERE channel='naver' AND (internal_product_id=? OR external_channel_product_no=?)`).get(internalProductId, channelProductNo);
  if (existingConflict) {
    try { insertAudit("naver_product_mapping_conflict", req, existingConflict, existingConflict.mapping_status, "CONFLICT"); } catch {}
    return res.status(409).json({ error: "이미 다른 상품에 연결된 매핑입니다.", reason: "PRODUCT_MAPPING_CONFLICT" });
  }
  const product = db.prepare("SELECT * FROM products WHERE id=?").get(internalProductId);
  const internalReason = validateInternalProductForNaverMapping(product);
  if (internalReason) return res.status(422).json({ error: "내부 상품을 매핑할 수 없습니다.", reason: internalReason });

  let external;
  try {
    external = await serviceFactory().getChannelProduct(channelProductNo);
  } catch (error) {
    return safeError(res, error);
  }
  const externalReason = validateExternalProductForNaverMapping(external);
  if (externalReason) return res.status(422).json({ error: "네이버 상품을 매핑할 수 없습니다.", reason: externalReason });
  if (external.channelProductNo !== channelProductNo) {
    return res.status(422).json({ error: "네이버 상품 식별자가 일치하지 않습니다.", reason: "NAVER_PRODUCT_RESPONSE_INVALID" });
  }

  const now = new Date().toISOString();
  const id = `channel-map-${crypto.randomUUID()}`;
  try {
    const result = transaction(() => {
      const sameInsideTransaction = db.prepare(`SELECT * FROM sales_channel_product_mappings
        WHERE channel='naver' AND internal_product_id=? AND external_channel_product_no=?`)
        .get(internalProductId, channelProductNo);
      if (sameInsideTransaction) return { mapping: sameInsideTransaction, created: false };
      const conflictInsideTransaction = db.prepare(`SELECT * FROM sales_channel_product_mappings
        WHERE channel='naver' AND (internal_product_id=? OR external_channel_product_no=?)`)
        .get(internalProductId, channelProductNo);
      if (conflictInsideTransaction) {
        const error = new Error("PRODUCT_MAPPING_CONFLICT");
        error.reason = "PRODUCT_MAPPING_CONFLICT";
        throw error;
      }
      db.prepare(`INSERT INTO sales_channel_product_mappings (
        id, channel, internal_product_id, external_origin_product_no, external_channel_product_no,
        external_group_product_no, seller_management_code, channel_service_type, external_product_name,
        external_status, mapping_status, created_at, updated_at
      ) VALUES (?, 'naver', ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(
        id, internalProductId, external.originProductNo, external.channelProductNo,
        external.groupProductNo, external.sellerManagementCode, external.channelServiceType,
        external.name, external.statusType, now, now,
      );
      const created = db.prepare("SELECT * FROM sales_channel_product_mappings WHERE id=?").get(id);
      insertAudit("naver_product_mapping_created", req, created, null, "ACTIVE");
      return { mapping: created, created: true };
    });
    return res.status(result.created ? 201 : 200).json(rowToMapping(result.mapping));
  } catch (error) {
    if (error?.reason === "PRODUCT_MAPPING_CONFLICT"
      || error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      const concurrentSame = db.prepare(`SELECT * FROM sales_channel_product_mappings
        WHERE channel='naver' AND internal_product_id=? AND external_channel_product_no=?`)
        .get(internalProductId, channelProductNo);
      if (concurrentSame) return res.json(rowToMapping(concurrentSame));
      return res.status(409).json({ error: "이미 다른 상품에 연결된 매핑입니다.", reason: "PRODUCT_MAPPING_CONFLICT" });
    }
    return res.status(500).json({ error: "상품 매핑을 저장하지 못했습니다.", reason: "PRODUCT_MAPPING_WRITE_FAILED" });
  }
});

router.patch("/naver/product-mappings/:id", requireAuth, requirePermission("sales_channels:manage"), (req, res) => {
  const keys = Object.keys(req.body || {});
  if (!keys.length || keys.some((key) => !["enabled", "mappingStatus", "safetyStock"].includes(key))) {
    return res.status(400).json({ error: "변경할 매핑 정보가 올바르지 않습니다.", reason: "PRODUCT_MAPPING_INVALID" });
  }
  let desiredStatus;
  if (req.body.enabled !== undefined) {
    if (typeof req.body.enabled !== "boolean") return res.status(400).json({ reason: "PRODUCT_MAPPING_INVALID" });
    desiredStatus = req.body.enabled ? "ACTIVE" : "DISABLED";
  }
  if (req.body.mappingStatus !== undefined) {
    if (!["ACTIVE", "DISABLED"].includes(req.body.mappingStatus)
      || (desiredStatus && desiredStatus !== req.body.mappingStatus)) {
      return res.status(400).json({ reason: "PRODUCT_MAPPING_INVALID" });
    }
    desiredStatus = req.body.mappingStatus;
  }
  if (req.body.safetyStock !== undefined
    && (!Number.isSafeInteger(req.body.safetyStock) || req.body.safetyStock < 0)) {
    return res.status(400).json({ reason: "PRODUCT_MAPPING_INVALID" });
  }
  try {
    const updated = transaction(() => {
      const before = db.prepare("SELECT * FROM sales_channel_product_mappings WHERE id=? AND channel='naver'").get(req.params.id);
      if (!before) return null;
      if (desiredStatus && !["ACTIVE", "DISABLED"].includes(before.mapping_status)) {
        const error = new Error("MAPPING_STATUS_TRANSITION_INVALID");
        error.status = 409;
        throw error;
      }
      const status = desiredStatus || before.mapping_status;
      const safetyStock = req.body.safetyStock ?? before.safety_stock;
      const result = db.prepare(`UPDATE sales_channel_product_mappings
        SET mapping_status=?, safety_stock=?, updated_at=? WHERE id=? AND channel='naver'`).run(
        status, safetyStock, new Date().toISOString(), req.params.id,
      );
      if (result.changes !== 1) throw new Error("MAPPING_UPDATE_MISMATCH");
      const after = db.prepare("SELECT * FROM sales_channel_product_mappings WHERE id=?").get(req.params.id);
      const action = before.mapping_status !== status
        ? (status === "ACTIVE" ? "naver_product_mapping_enabled" : "naver_product_mapping_disabled")
        : "naver_product_mapping_updated";
      insertAudit(action, req, after, before.mapping_status, status, { safetyStock });
      return after;
    });
    if (!updated) return res.status(404).json({ error: "상품 매핑을 찾을 수 없습니다.", reason: "PRODUCT_MAPPING_NOT_FOUND" });
    return res.json(rowToMapping(updated));
  } catch (error) {
    if (error?.status === 409) {
      return res.status(409).json({ error: "매핑을 다시 검증한 후 상태를 변경해 주세요.", reason: "PRODUCT_MAPPING_INVALID" });
    }
    return res.status(500).json({ error: "상품 매핑을 변경하지 못했습니다.", reason: "PRODUCT_MAPPING_WRITE_FAILED" });
  }
});

router.post("/naver/product-mappings/:id/verify", requireAuth, requirePermission("sales_channels:manage"), async (req, res) => {
  const current = db.prepare("SELECT * FROM sales_channel_product_mappings WHERE id=? AND channel='naver'").get(req.params.id);
  if (!current) return res.status(404).json({ error: "상품 매핑을 찾을 수 없습니다.", reason: "PRODUCT_MAPPING_NOT_FOUND" });
  let external;
  let verificationStatus;
  let errorCode = null;
  try {
    external = await serviceFactory().getChannelProduct(current.external_channel_product_no);
    const reason = validateExternalProductForNaverMapping(external);
    verificationStatus = reason === "NAVER_PRODUCT_OPTION_UNSUPPORTED" ? "UNSUPPORTED_OPTION"
      : reason ? "CONFLICT"
        : "ACTIVE";
    errorCode = reason;
    if (external.channelProductNo !== current.external_channel_product_no
      || external.originProductNo !== current.external_origin_product_no) {
      verificationStatus = "CONFLICT";
      errorCode = "NAVER_PRODUCT_IDENTIFIER_MISMATCH";
    }
  } catch (error) {
    if (error?.status === 404) {
      verificationStatus = "EXTERNAL_NOT_FOUND";
      errorCode = "NAVER_PRODUCT_NOT_FOUND";
    } else return safeError(res, error);
  }
  try {
    const updated = transaction(() => {
      const latest = db.prepare("SELECT * FROM sales_channel_product_mappings WHERE id=? AND channel='naver'").get(current.id);
      if (!latest || latest.external_channel_product_no !== current.external_channel_product_no
        || latest.external_origin_product_no !== current.external_origin_product_no) {
        const error = new Error("PRODUCT_MAPPING_CONFLICT");
        error.reason = "PRODUCT_MAPPING_CONFLICT";
        throw error;
      }
      // Choice A: an explicit operator disablement wins. External verification
      // problems remain visible in last_error_code without re-enabling the row.
      const status = latest.mapping_status === "DISABLED" ? "DISABLED" : verificationStatus;
      const now = new Date().toISOString();
      const result = db.prepare(`UPDATE sales_channel_product_mappings SET
        external_product_name=COALESCE(?, external_product_name),
        external_status=COALESCE(?, external_status),
        seller_management_code=COALESCE(?, seller_management_code),
        mapping_status=?, last_verified_at=?, last_product_sync_at=?,
        last_error_code=?, last_error_message=NULL, updated_at=?
        WHERE id=? AND channel='naver'`).run(
        external?.name ?? null, external?.statusType ?? null, external?.sellerManagementCode ?? null,
        status, now, now, errorCode, now, current.id,
      );
      if (result.changes !== 1) throw new Error("MAPPING_UPDATE_MISMATCH");
      const row = db.prepare("SELECT * FROM sales_channel_product_mappings WHERE id=?").get(current.id);
      insertAudit("naver_product_mapping_verified", req, row, latest.mapping_status, status, errorCode);
      return row;
    });
    return res.json(rowToMapping(updated));
  } catch (error) {
    if (error?.reason === "PRODUCT_MAPPING_CONFLICT") {
      return res.status(409).json({ error: "상품 매핑이 변경되어 검증 결과를 저장하지 않았습니다.", reason: "PRODUCT_MAPPING_CONFLICT" });
    }
    return res.status(500).json({ error: "상품 매핑 검증 결과를 저장하지 못했습니다.", reason: "PRODUCT_MAPPING_WRITE_FAILED" });
  }
});

function setServiceFactoryForTest(factory) {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_ONLY");
  serviceFactory = factory || defaultServiceFactory;
}

module.exports = router;
module.exports.setServiceFactoryForTest = setServiceFactoryForTest;
