const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { getDefaultNaverCommerceClient } = require("../services/naver-commerce-client");
const {
  createNaverProductService,
  validateExternalProductForNaverMapping,
  validateInternalProductForNaverMapping,
} = require("../services/naver-product-service");

const router = express.Router();
const SALES_UNITS = new Set(["pack", "half_mal", "mal"]);
const defaultService = createNaverProductService({ client: getDefaultNaverCommerceClient() });
let serviceFactory = () => defaultService;

function rowToMapping(row) {
  return {
    id: row.id,
    channel: row.channel,
    internalProductId: row.internal_product_id,
    salesUnit: row.sales_unit,
    externalOriginProductNo: row.external_origin_product_no,
    externalChannelProductNo: row.external_channel_product_no,
    externalProductName: row.external_product_name,
    externalStatus: row.external_status,
    mappingStatus: row.mapping_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function unitIsSellable(product, salesUnit) {
  const priceColumn = { pack: "price", half_mal: "half_mal_price", mal: "mal_price" }[salesUnit];
  return product?.purchase_type === "direct" && product.status === "active"
    && ((Number.isInteger(product[priceColumn]) && product[priceColumn] > 0)
      || (salesUnit !== "pack" && Number.isInteger(product.price) && product.price > 0));
}

function audit(req, action, row, previousValue, nextValue) {
  db.prepare(`INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
    VALUES (?, 'INTEGRATION', ?, 'sales-channels', ?, ?, ?, ?, ?, ?)`)
    .run(`activity-${crypto.randomUUID()}`, JSON.stringify({
      internalProductId: row.internal_product_id,
      salesUnit: row.sales_unit,
      externalChannelProductNo: `***${row.external_channel_product_no.slice(-4)}`,
    }), action, row.id, previousValue, nextValue, req.admin.id, new Date().toISOString());
}

router.get("/naver/product-unit-mappings", requireAuth, requirePermission("sales_channels:read"), (req, res) => {
  const clauses = ["channel='naver'"];
  const values = [];
  if (req.query.internalProductId) { clauses.push("internal_product_id=?"); values.push(req.query.internalProductId); }
  if (req.query.salesUnit) {
    if (!SALES_UNITS.has(req.query.salesUnit)) return res.status(400).json({ reason: "PRODUCT_UNIT_MAPPING_INVALID" });
    clauses.push("sales_unit=?"); values.push(req.query.salesUnit);
  }
  const items = db.prepare(`SELECT * FROM sales_channel_product_unit_mappings
    WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`).all(...values).map(rowToMapping);
  return res.json({ items, total: items.length });
});

router.post("/naver/product-unit-mappings", requireAuth, requirePermission("sales_channels:manage"), async (req, res) => {
  const internalProductId = String(req.body?.internalProductId || "").trim();
  const salesUnit = String(req.body?.salesUnit || "").trim();
  const channelProductNo = String(req.body?.channelProductNo || "").trim();
  if (!internalProductId || !SALES_UNITS.has(salesUnit) || !/^[1-9]\d*$/.test(channelProductNo)) {
    return res.status(400).json({ error: "상품 단위 매핑 입력이 올바르지 않습니다.", reason: "PRODUCT_UNIT_MAPPING_INVALID" });
  }
  const same = db.prepare(`SELECT * FROM sales_channel_product_unit_mappings
    WHERE channel='naver' AND internal_product_id=? AND sales_unit=? AND external_channel_product_no=?`)
    .get(internalProductId, salesUnit, channelProductNo);
  if (same) return res.json(rowToMapping(same));
  const conflict = db.prepare(`SELECT 1 FROM sales_channel_product_unit_mappings
    WHERE channel='naver' AND ((internal_product_id=? AND sales_unit=?) OR external_channel_product_no=?)`)
    .get(internalProductId, salesUnit, channelProductNo);
  if (conflict) return res.status(409).json({ error: "이미 다른 판매 단위에 연결된 네이버 상품입니다.", reason: "PRODUCT_UNIT_MAPPING_CONFLICT" });
  const product = db.prepare("SELECT * FROM products WHERE id=?").get(internalProductId);
  if (validateInternalProductForNaverMapping(product) || !unitIsSellable(product, salesUnit)) {
    return res.status(422).json({ error: "현재 판매 중인 해당 단위만 연결할 수 있습니다.", reason: "PRODUCT_UNIT_NOT_SELLABLE" });
  }
  let external;
  try { external = await serviceFactory().getChannelProduct(channelProductNo); }
  catch { return res.status(502).json({ error: "네이버 상품 정보를 확인하지 못했습니다.", reason: "NAVER_PRODUCT_REQUEST_FAILED" }); }
  const externalReason = validateExternalProductForNaverMapping(external);
  if (externalReason || external.channelProductNo !== channelProductNo) {
    return res.status(422).json({ error: "네이버 상품을 연결할 수 없습니다.", reason: externalReason || "NAVER_PRODUCT_RESPONSE_INVALID" });
  }
  const now = new Date().toISOString();
  const id = `channel-unit-map-${crypto.randomUUID()}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO sales_channel_product_unit_mappings
      (id,channel,internal_product_id,sales_unit,external_origin_product_no,external_channel_product_no,
       external_product_name,external_status,mapping_status,created_at,updated_at)
      VALUES (?,'naver',?,?,?,?,?,?,'ACTIVE',?,?)`).run(
      id, internalProductId, salesUnit, external.originProductNo, external.channelProductNo,
      external.name, external.statusType, now, now,
    );
    const created = db.prepare("SELECT * FROM sales_channel_product_unit_mappings WHERE id=?").get(id);
    audit(req, "naver_product_unit_mapping_created", created, null, "ACTIVE");
    db.exec("COMMIT");
    return res.status(201).json(rowToMapping(created));
  } catch (error) {
    db.exec("ROLLBACK");
    if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ reason: "PRODUCT_UNIT_MAPPING_CONFLICT" });
    return res.status(500).json({ reason: "PRODUCT_UNIT_MAPPING_WRITE_FAILED" });
  }
});

router.patch("/naver/product-unit-mappings/:id", requireAuth, requirePermission("sales_channels:manage"), (req, res) => {
  if (typeof req.body?.enabled !== "boolean" || Object.keys(req.body).some((key) => key !== "enabled")) {
    return res.status(400).json({ reason: "PRODUCT_UNIT_MAPPING_INVALID" });
  }
  const before = db.prepare("SELECT * FROM sales_channel_product_unit_mappings WHERE id=? AND channel='naver'").get(req.params.id);
  if (!before) return res.status(404).json({ reason: "PRODUCT_UNIT_MAPPING_NOT_FOUND" });
  const status = req.body.enabled ? "ACTIVE" : "DISABLED";
  if (status === "ACTIVE") {
    const product = db.prepare("SELECT * FROM products WHERE id=?").get(before.internal_product_id);
    if (!unitIsSellable(product, before.sales_unit)) return res.status(409).json({ reason: "PRODUCT_UNIT_NOT_SELLABLE" });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE sales_channel_product_unit_mappings SET mapping_status=?,updated_at=? WHERE id=?")
      .run(status, new Date().toISOString(), before.id);
    const after = db.prepare("SELECT * FROM sales_channel_product_unit_mappings WHERE id=?").get(before.id);
    audit(req, status === "ACTIVE" ? "naver_product_unit_mapping_enabled" : "naver_product_unit_mapping_disabled", after, before.mapping_status, status);
    db.exec("COMMIT");
    return res.json(rowToMapping(after));
  } catch {
    db.exec("ROLLBACK");
    return res.status(500).json({ reason: "PRODUCT_UNIT_MAPPING_WRITE_FAILED" });
  }
});

router.setServiceFactoryForTest = (factory) => { serviceFactory = factory || (() => defaultService); };
module.exports = router;
