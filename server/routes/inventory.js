const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function rowToItem(row) {
  return {
    id: row.id,
    name: row.name,
    stock: row.stock,
    unit: row.unit,
    safeStock: row.safe_stock,
    memo: row.memo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLog(row) {
  return {
    id: row.id,
    product: row.product,
    quantity: row.quantity,
    orderCount: row.order_count,
    materials: row.materials ? JSON.parse(row.materials) : [],
    createdAt: row.created_at,
  };
}

// GET /api/inventory
router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM inventory ORDER BY created_at DESC").all();
  res.json(rows.map(rowToItem));
});

// POST /api/inventory
router.post("/", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const { id = `inventory-${Date.now()}`, name, stock = 0, unit, safeStock = 0, memo } = req.body;
  if (!name || !unit) return res.status(400).json({ error: "품목명과 단위는 필수입니다." });

  const conflict = db.prepare("SELECT id FROM inventory WHERE name = ? AND id != ?").get(name, id);
  if (conflict) return res.status(409).json({ error: `"${name}" 이름의 재고 품목이 이미 존재합니다.` });

  db.prepare(`
    INSERT INTO inventory (id, name, stock, unit, safe_stock, memo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, stock, unit, safeStock, memo ?? null, now, now);

  const row = db.prepare("SELECT * FROM inventory WHERE id = ?").get(id);
  res.status(201).json(rowToItem(row));
});

// GET /api/inventory/logs — /:id 보다 먼저 등록해야 "logs"가 id로 매칭되지 않음
router.get("/logs", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM inventory_logs ORDER BY created_at DESC").all();
  res.json(rows.map(rowToLog));
});

// POST /api/inventory/logs
router.post("/logs", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const { id = `invlog-${Date.now()}`, product, quantity, orderCount, materials } = req.body;
  db.prepare(`
    INSERT INTO inventory_logs (id, product, quantity, order_count, materials, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, product ?? null, quantity ?? null, orderCount ?? null,
    Array.isArray(materials) ? JSON.stringify(materials) : null, now);
  res.status(201).json({ ok: true });
});

// DELETE /api/inventory/logs — 전체 이력 삭제 (/:id 보다 먼저 등록)
router.delete("/logs", requireAuth, (req, res) => {
  db.prepare("DELETE FROM inventory_logs").run();
  res.json({ ok: true });
});

// PUT /api/inventory/:id
router.put("/:id", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM inventory WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "재고 품목을 찾을 수 없습니다." });

  const name = req.body.name ?? existing.name;
  const unit = req.body.unit ?? existing.unit;
  if (!name || !unit) return res.status(400).json({ error: "품목명과 단위는 필수입니다." });

  const conflict = db.prepare("SELECT id FROM inventory WHERE name = ? AND id != ?").get(name, req.params.id);
  if (conflict) return res.status(409).json({ error: `"${name}" 이름의 재고 품목이 이미 존재합니다.` });

  db.prepare(`
    UPDATE inventory SET name=?, stock=?, unit=?, safe_stock=?, memo=?, updated_at=? WHERE id=?
  `).run(name, req.body.stock ?? existing.stock, unit,
    req.body.safeStock ?? existing.safe_stock, req.body.memo ?? existing.memo, now, req.params.id);

  const row = db.prepare("SELECT * FROM inventory WHERE id = ?").get(req.params.id);
  res.json(rowToItem(row));
});

// DELETE /api/inventory/:id
router.delete("/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM inventory WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "재고 품목을 찾을 수 없습니다." });
  db.prepare("DELETE FROM inventory WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// DELETE /api/inventory — 전체 삭제
router.delete("/", requireAuth, (req, res) => {
  db.prepare("DELETE FROM inventory").run();
  res.json({ ok: true });
});

module.exports = router;
