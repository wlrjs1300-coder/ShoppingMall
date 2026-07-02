const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function rowToOrder(row) {
  return {
    id: row.id,
    inventoryId: row.inventory_id,
    name: row.name,
    amount: row.amount,
    unit: row.unit,
    supplier: row.supplier,
    unitCost: row.unit_cost,
    status: row.status,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/purchase-orders
router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM purchase_orders ORDER BY created_at DESC").all();
  res.json(rows.map(rowToOrder));
});

// POST /api/purchase-orders
router.post("/", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const {
    id = `purchase-${Date.now()}`,
    inventoryId, name, amount = 0, unit,
    supplier, unitCost = 0, status = "발주요청",
  } = req.body;
  if (!name) return res.status(400).json({ error: "품목명은 필수입니다." });

  db.prepare(`
    INSERT INTO purchase_orders (id, inventory_id, name, amount, unit, supplier, unit_cost, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, inventoryId ?? null, name, amount, unit ?? null, supplier ?? null, unitCost, status, now, now);

  const row = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id);
  res.status(201).json(rowToOrder(row));
});

// PUT /api/purchase-orders/:id
router.put("/:id", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "발주를 찾을 수 없습니다." });

  db.prepare(`
    UPDATE purchase_orders SET inventory_id=?, name=?, amount=?, unit=?, supplier=?, unit_cost=?, status=?, received_at=?, updated_at=?
    WHERE id=?
  `).run(
    req.body.inventoryId ?? existing.inventory_id,
    req.body.name ?? existing.name,
    req.body.amount ?? existing.amount,
    req.body.unit ?? existing.unit,
    req.body.supplier ?? existing.supplier,
    req.body.unitCost ?? existing.unit_cost,
    req.body.status ?? existing.status,
    req.body.receivedAt ?? existing.received_at,
    now, req.params.id,
  );

  const row = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  res.json(rowToOrder(row));
});

// DELETE /api/purchase-orders/:id
router.delete("/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "발주를 찾을 수 없습니다." });
  db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// DELETE /api/purchase-orders — 전체 삭제
router.delete("/", requireAuth, (req, res) => {
  db.prepare("DELETE FROM purchase_orders").run();
  res.json({ ok: true });
});

module.exports = router;
