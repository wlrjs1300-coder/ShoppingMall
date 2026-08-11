const express = require("express");
const crypto = require("node:crypto");
const db = require("../db");
const seedProducts = require("../data/products");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
const SEEDED_PRODUCT_IDS = new Set(seedProducts.map((product) => product.id));

function cleanText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length <= maxLength ? text : "";
}

const SAFE_IMAGE_URL = /^(?:assets\/[a-zA-Z0-9_./-]+|https:\/\/[^\s]+|data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+)$/;
const MAX_IMAGE_DATA_LENGTH = 1_100_000;

function cleanImageUrl(value) {
  const url = String(value ?? "").trim();
  if (!url || url.length > MAX_IMAGE_DATA_LENGTH || !SAFE_IMAGE_URL.test(url)) return "";
  return url;
}

function parseDetailImages(value) {
  let items = value;
  if (typeof items === "string") {
    try { items = JSON.parse(items || "[]"); } catch { return null; }
  }
  if (!Array.isArray(items) || items.length > 4) return null;
  const images = items.map(cleanImageUrl);
  return images.every(Boolean) ? images : null;
}

function parseOriginItems(value) {
  let items = value;
  if (typeof items === "string") {
    try { items = JSON.parse(items || "[]"); } catch { return null; }
  }
  if (!Array.isArray(items) || items.length > 12) return null;
  const cleaned = items.map((item) => ({ ingredient: cleanText(item?.ingredient, 40), origin: cleanText(item?.origin, 60) }));
  return cleaned.every((item) => item.ingredient && item.origin) ? cleaned : null;
}

function getDefaultOriginItems(name) {
  const productName = String(name || "");
  let items = [["멥쌀", "국내산"], ["소금", "국내산"], ["설탕", "외국산"]];
  if (/흰절편/.test(productName)) items = [["멥쌀", "국내산"], ["소금", "국내산"], ["설탕", "외국산"], ["참기름", "국내산"]];
  else if (/약식|약밥/.test(productName)) items = [["찹쌀", "국내산"], ["흑설탕", "외국산"], ["밤", "국내산"], ["대추", "국내산"], ["잣", "국내산"], ["참기름", "국내산"]];
  else if (/쑥/.test(productName)) items = [["멥쌀", "국내산"], ["쑥", "국내산"], ["소금", "국내산"], ["설탕", "외국산"]];
  else if (/호박/.test(productName)) items = [["멥쌀", "국내산"], ["호박", "국내산"], ["설탕", "외국산"], ["소금", "국내산"]];
  else if (/송편/.test(productName)) items = [["멥쌀", "국내산"], ["참깨", "외국산"], ["설탕", "외국산"], ["소금", "국내산"], ["참기름", "국내산"]];
  else if (/팥|시루/.test(productName)) items = [["멥쌀", "국내산"], ["팥", "중국산"], ["설탕", "외국산"], ["소금", "국내산"]];
  else if (/인절미|찰떡|찹쌀/.test(productName)) items = [["찹쌀", "국내산"], ["콩가루", "국내산"], ["설탕", "외국산"], ["소금", "국내산"]];
  else if (/밤|대추/.test(productName)) items = [["멥쌀", "국내산"], ["밤", "국내산"], ["대추", "국내산"], ["설탕", "외국산"], ["소금", "국내산"]];
  return items.map(([ingredient, origin]) => ({ ingredient, origin }));
}

function validateProduct(body, existing = null) {
  const suppliedId = cleanText(body.id, 80).toLowerCase();
  const id = cleanText((existing?.id ?? suppliedId) || `menu-${crypto.randomUUID().slice(0, 8)}`, 80).toLowerCase();
  const name = cleanText(body.name ?? existing?.name, 80);
  const category = cleanText(body.category ?? existing?.category, 40);
  const purchaseType = body.purchaseType ?? existing?.purchase_type;
  const description = cleanText(body.description ?? existing?.description ?? "", 500);
  const imageUrl = cleanImageUrl(body.imageUrl ?? existing?.image_url);
  const detailImages = parseDetailImages(body.detailImages ?? existing?.detail_images_json ?? []);
  const status = body.status ?? existing?.status ?? "active";
  const rawDisplayOrder = body.displayOrder ?? existing?.display_order ?? 0;
  const displayOrder = Number(rawDisplayOrder);
  const price = purchaseType === "consultation" ? null : Number(body.price ?? existing?.price);
  const derivedMalPrice = Number.isInteger(price) && price > 0 ? Math.round(price * 32) : null;
  const halfMalPrice = purchaseType === "consultation" ? null : Number(body.halfMalPrice ?? existing?.half_mal_price ?? (derivedMalPrice ? derivedMalPrice / 2 : null));
  const malPrice = purchaseType === "consultation" ? null : Number(body.malPrice ?? existing?.mal_price ?? derivedMalPrice);
  const unitWeightGrams = Number(body.unitWeightGrams ?? existing?.unit_weight_grams ?? 250);
  const optionalWeight = (value) => value === null || value === undefined || value === "" ? null : Number(value);
  const halfMalWeightGrams = purchaseType === "consultation" ? null : optionalWeight(body.halfMalWeightGrams ?? existing?.half_mal_weight_grams);
  const malWeightGrams = purchaseType === "consultation" ? null : optionalWeight(body.malWeightGrams ?? existing?.mal_weight_grams);
  const originItems = parseOriginItems(body.originItems ?? existing?.origin_items_json ?? []);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return { error: "상품 ID는 영문 소문자, 숫자와 하이픈만 사용할 수 있습니다." };
  if (!name || !category) return { error: "상품명과 카테고리는 필수입니다." };
  if (!new Set(["direct", "consultation"]).has(purchaseType)) return { error: "판매 방식을 확인해 주세요." };
  if (purchaseType === "direct" && (!Number.isInteger(price) || price <= 0)) return { error: "바로 구매 상품은 1원 이상의 정수 가격이 필요합니다." };
  if (purchaseType === "direct" && (!Number.isInteger(halfMalPrice) || halfMalPrice <= 0 || !Number.isInteger(malPrice) || malPrice <= 0)) return { error: "반말과 한말 가격을 각각 입력해 주세요." };
  if (purchaseType === "direct" && (!Number.isInteger(unitWeightGrams) || unitWeightGrams <= 0)) return { error: "팩 중량은 1g 이상의 정수로 입력해 주세요." };
  if ([halfMalWeightGrams, malWeightGrams].some((weight) => weight !== null && (!Number.isInteger(weight) || weight <= 0))) return { error: "반말·한말 중량은 비워두거나 1g 이상의 정수로 입력해 주세요." };
  if (!originItems) return { error: "원재료와 원산지를 올바르게 입력해 주세요." };
  if (!imageUrl) return { error: "대표 이미지는 첨부 파일, assets/ 경로 또는 HTTPS URL로 설정해 주세요." };
  if (!detailImages) return { error: "상세 이미지는 최대 4개이며 PNG, JPG, WEBP, GIF 형식만 사용할 수 있습니다." };
  if (!new Set(["active", "inactive"]).has(status)) return { error: "판매 상태를 확인해 주세요." };
  if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 9999) return { error: "노출 순서는 0~9999의 정수여야 합니다." };

  return { product: { id, name, category, purchaseType, price, halfMalPrice, malPrice, unitWeightGrams, halfMalWeightGrams, malWeightGrams, originItems, imageUrl, detailImages, description, status, displayOrder } };
}

function writeProductAudit(req, action, product, previousValue = null) {
  db.prepare(`INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
    VALUES (?, 'PRODUCT', ?, 'products', ?, ?, ?, ?, ?, ?)`)
    .run(`activity-${crypto.randomUUID()}`, `${product.id} product ${action}`, action, product.id,
      previousValue ? JSON.stringify(previousValue) : null,
      action === "product_deleted" ? "DELETED" : JSON.stringify({ name: product.name, status: product.status }),
      req.admin?.id || "admin", new Date().toISOString());
}

function rowToProduct(row) {
  const storedOriginItems = parseOriginItems(row.origin_items_json || "[]") || [];
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    purchaseType: row.purchase_type,
    price: row.price,
    halfMalPrice: row.purchase_type === "direct" ? (row.half_mal_price ?? Math.round(Number(row.price || 0) * 16)) : null,
    malPrice: row.purchase_type === "direct" ? (row.mal_price ?? Math.round(Number(row.price || 0) * 32)) : null,
    halfMalWeightGrams: row.purchase_type === "direct" ? (row.half_mal_weight_grams ?? null) : null,
    malWeightGrams: row.purchase_type === "direct" ? (row.mal_weight_grams ?? null) : null,
    originItems: storedOriginItems.length ? storedOriginItems : getDefaultOriginItems(row.name),
    imageUrl: row.image_url,
    detailImages: parseDetailImages(row.detail_images_json || "[]") || [],
    description: row.description,
    unitWeightGrams: row.purchase_type === "direct" ? Number(row.unit_weight_grams || 250) : null,
    status: row.status,
    displayOrder: row.display_order,
  };
}

// 관리자 상품 목록은 판매 중지 상품도 포함한다.
router.get("/admin", requireAuth, requirePermission("inventory:read"), (req, res) => {
  const rows = db.prepare("SELECT * FROM products ORDER BY display_order ASC, created_at ASC").all();
  res.json({ products: rows.map(rowToProduct) });
});

router.post("/admin", requireAuth, requirePermission("inventory:write"), (req, res) => {
  const validated = validateProduct(req.body || {});
  if (validated.error) return res.status(400).json({ error: validated.error });
  const product = validated.product;
  if (db.prepare("SELECT 1 FROM products WHERE id=?").get(product.id)) {
    return res.status(409).json({ error: "이미 사용 중인 상품 ID입니다." });
  }
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO products
      (id,name,category,purchase_type,price,half_mal_price,mal_price,unit_weight_grams,half_mal_weight_grams,mal_weight_grams,origin_items_json,image_url,detail_images_json,description,status,display_order,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(product.id, product.name, product.category, product.purchaseType, product.price,
        product.halfMalPrice, product.malPrice, product.unitWeightGrams, product.halfMalWeightGrams, product.malWeightGrams,
        JSON.stringify(product.originItems), product.imageUrl, JSON.stringify(product.detailImages), product.description || null, product.status, product.displayOrder, now, now);
    writeProductAudit(req, "product_created", product);
    db.exec("COMMIT");
    return res.status(201).json({ product: rowToProduct(db.prepare("SELECT * FROM products WHERE id=?").get(product.id)) });
  } catch {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "상품을 등록하지 못했습니다." });
  }
});

router.put("/admin/reorder", requireAuth, requirePermission("inventory:write"), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => cleanText(id, 80)) : [];
  const existingIds = db.prepare("SELECT id FROM products ORDER BY display_order, created_at").all().map((row) => row.id);
  if (ids.length !== existingIds.length || new Set(ids).size !== ids.length || existingIds.some((id) => !ids.includes(id))) {
    return res.status(400).json({ error: "전체 메뉴의 노출 순서를 다시 확인해 주세요." });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE products SET display_order=?, updated_at=? WHERE id=?");
    const now = new Date().toISOString();
    ids.forEach((id, index) => update.run(index + 1, now, id));
    db.exec("COMMIT");
    return res.json({ ok: true });
  } catch {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "메뉴 순서를 저장하지 못했습니다." });
  }
});

router.put("/admin/:id", requireAuth, requirePermission("inventory:write"), (req, res) => {
  const existing = db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "상품을 찾을 수 없습니다." });
  const validated = validateProduct(req.body || {}, existing);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const product = validated.product;
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db.prepare(`UPDATE products SET name=?,category=?,purchase_type=?,price=?,half_mal_price=?,mal_price=?,unit_weight_grams=?,half_mal_weight_grams=?,mal_weight_grams=?,origin_items_json=?,image_url=?,detail_images_json=?,
      description=?,status=?,display_order=?,updated_at=? WHERE id=?`)
      .run(product.name, product.category, product.purchaseType, product.price,
        product.halfMalPrice, product.malPrice, product.unitWeightGrams, product.halfMalWeightGrams, product.malWeightGrams, JSON.stringify(product.originItems), product.imageUrl,
        JSON.stringify(product.detailImages), product.description || null, product.status, product.displayOrder, now, existing.id);
    if (changed.changes !== 1) throw new Error("CONCURRENT_STATE_CHANGE");
    writeProductAudit(req, "product_updated", product, rowToProduct(existing));
    db.exec("COMMIT");
    return res.json({ product: rowToProduct(db.prepare("SELECT * FROM products WHERE id=?").get(existing.id)) });
  } catch {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "상품을 수정하지 못했습니다." });
  }
});

router.delete("/admin/:id", requireAuth, requirePermission("inventory:write"), (req, res) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
    if (!existing) {
      db.exec("ROLLBACK");
      return res.status(404).json({ error: "상품을 찾을 수 없습니다.", reason: "NOT_FOUND" });
    }
    const referenced = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM order_items WHERE product_id=?) AS has_orders,
      EXISTS(SELECT 1 FROM product_inquiries WHERE product_id=?) AS has_inquiries,
      EXISTS(SELECT 1 FROM recipes WHERE product=?) AS has_recipe`).get(existing.id, existing.id, existing.name);
    if (SEEDED_PRODUCT_IDS.has(existing.id) || referenced.has_orders || referenced.has_inquiries || referenced.has_recipe) {
      db.exec("ROLLBACK");
      return res.status(409).json({
        error: "기본 상품 또는 주문·문의·배합 이력이 있는 상품은 삭제할 수 없습니다. 판매 중지로 보관해 주세요.",
        reason: "PRODUCT_HISTORY_EXISTS",
      });
    }
    const deleted = db.prepare("DELETE FROM products WHERE id=?").run(existing.id);
    if (deleted.changes !== 1) throw new Error("CONCURRENT_STATE_CHANGE");
    writeProductAudit(req, "product_deleted", rowToProduct(existing));
    db.exec("COMMIT");
    return res.json({ ok: true });
  } catch {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "상품을 삭제하지 못했습니다." });
  }
});

// GET /api/products — 공개 카탈로그 조회 (active만, 표시 순서대로)
router.get("/", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT * FROM products WHERE status = 'active' ORDER BY display_order ASC",
    ).all();
    res.json({ products: rows.map(rowToProduct) });
  } catch (err) {
    console.error("[products] 목록 조회 실패:", err);
    res.status(500).json({ error: "상품 목록을 불러오지 못했습니다." });
  }
});

// GET /api/products/:id — 공개 단일 상품 조회 (active만 노출, 나머지는 404)
router.get("/:id", (req, res) => {
  try {
    const row = db.prepare(
      "SELECT * FROM products WHERE id = ? AND status = 'active'",
    ).get(req.params.id);
    if (!row) return res.status(404).json({ error: "상품을 찾을 수 없습니다." });
    res.json({ product: rowToProduct(row) });
  } catch (err) {
    console.error("[products] 단일 조회 실패:", err);
    res.status(500).json({ error: "상품 정보를 불러오지 못했습니다." });
  }
});

module.exports = router;
