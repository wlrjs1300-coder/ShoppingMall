const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function rowToLog(row) {
  return {
    id: row.id,
    category: row.category,
    message: row.message,
    tab: row.tab,
    action: row.action,
    entityId: row.entity_id,
    previousValue: row.previous_value,
    nextValue: row.next_value,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

// GET /api/activity-logs
router.get("/", requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare("SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?").all(limit);
  res.json(rows.map(rowToLog));
});

// POST /api/activity-logs
router.post("/", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const { id = `activity-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, category, message, tab = "orders",
    action = null, entityId = null, previousValue = null, nextValue = null, actor = "관리자" } = req.body;
  db.prepare(`
    INSERT INTO activity_logs (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, category ?? null, message ?? null, tab, action, entityId, previousValue, nextValue, actor, now);
  res.status(201).json({ ok: true });
});

// DELETE /api/activity-logs — 전체 삭제
router.delete("/", requireAuth, (req, res) => {
  db.prepare("DELETE FROM activity_logs").run();
  res.json({ ok: true });
});

module.exports = router;
