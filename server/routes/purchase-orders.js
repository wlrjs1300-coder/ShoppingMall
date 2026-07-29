const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function logBlockedDelete(req, entityId, reason) {
  try {
    db.prepare(`INSERT INTO activity_logs
      (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
      VALUES (?, 'SECURITY', ?, 'accounting', 'destructive_action_blocked', ?, 'retained', ?, ?, ?)`)
      .run(`activity-${crypto.randomUUID()}`, `${entityId} purchase order deletion blocked: ${reason}`,
        entityId, reason, req.admin?.id || "admin", new Date().toISOString());
  } catch {
    // The destructive action remains blocked even when its audit record cannot be written.
  }
}

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
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
    if (!current) {
      db.exec("ROLLBACK");
      return res.status(404).json({ error: "발주를 찾을 수 없습니다.", reason: "NOT_FOUND" });
    }
    if (current.received_at || !["발주요청", "초안", "DRAFT"].includes(current.status)) {
      db.exec("ROLLBACK");
      logBlockedDelete(req, current.id, "PURCHASE_ORDER_LOCKED");
      return res.status(409).json({
        error: "확정 또는 입고 처리된 발주는 삭제할 수 없습니다.",
        reason: "PURCHASE_ORDER_LOCKED",
      });
    }
    const deleted = db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(current.id);
    if (deleted.changes !== 1) throw new Error("CONCURRENT_STATE_CHANGE");
    db.prepare(`INSERT INTO activity_logs
      (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
      VALUES (?, 'PURCHASE', ?, 'accounting', 'purchase_order_deleted', ?, ?, 'DELETED', ?, ?)`)
      .run(`activity-${crypto.randomUUID()}`, `${current.id} draft purchase order deleted`,
        current.id, current.status, req.admin?.id || "admin", now);
    db.exec("COMMIT");
    return res.json({ ok: true });
  } catch {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "발주 삭제를 완료하지 못했습니다." });
  }
});

// DELETE /api/purchase-orders — 전체 삭제
router.delete("/", requireAuth, (req, res) => {
  logBlockedDelete(req, "purchase_orders", "DESTRUCTIVE_ACTION_DISABLED");
  res.status(405).json({
    error: "발주 전체 삭제 기능은 비활성화되어 있습니다.",
    reason: "DESTRUCTIVE_ACTION_DISABLED",
  });
});

module.exports = router;
