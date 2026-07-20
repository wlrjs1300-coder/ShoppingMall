const express = require("express");
const db = require("../db");

const router = express.Router();

function rowToProduct(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    purchaseType: row.purchase_type,
    price: row.price,
    imageUrl: row.image_url,
    description: row.description,
    unitWeightGrams: row.purchase_type === "direct" ? 250 : null,
    status: row.status,
    displayOrder: row.display_order,
  };
}

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
