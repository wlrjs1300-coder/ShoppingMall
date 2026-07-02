const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/recipes
router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM recipes ORDER BY product, ingredient").all();
  res.json(rows.map((row) => ({
    product: row.product,
    ingredient: row.ingredient,
    amount: row.amount,
    unit: row.unit,
  })));
});

// PUT /api/recipes — 전체 배합 기준 교체
router.put("/", requireAuth, (req, res) => {
  const recipes = req.body;
  if (!Array.isArray(recipes)) return res.status(400).json({ error: "배합 기준 배열이 필요합니다." });

  const upsert = db.prepare(`
    INSERT INTO recipes (product, ingredient, amount, unit) VALUES (?, ?, ?, ?)
    ON CONFLICT(product, ingredient) DO UPDATE SET amount=excluded.amount, unit=excluded.unit
  `);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM recipes");
    for (const r of recipes) {
      if (r.product && r.ingredient) {
        upsert.run(r.product, r.ingredient, Number(r.amount || 0), r.unit || "");
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  res.json({ ok: true });
});

// DELETE /api/recipes/:product/:ingredient — 단건 삭제
router.delete("/:product/:ingredient", requireAuth, (req, res) => {
  db.prepare("DELETE FROM recipes WHERE product = ? AND ingredient = ?")
    .run(decodeURIComponent(req.params.product), decodeURIComponent(req.params.ingredient));
  res.json({ ok: true });
});

module.exports = router;
