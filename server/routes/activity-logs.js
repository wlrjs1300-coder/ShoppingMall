const express = require("express");
const crypto = require("crypto");
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

router.delete("/", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO activity_logs
      (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
      VALUES (?, 'SECURITY', 'Blocked activity log deletion attempt', 'logs',
        'destructive_action_blocked', 'activity_logs', 'retained', 'retained', ?, ?)`)
      .run(`activity-${crypto.randomUUID()}`, req.admin?.id || "admin", now);
  } catch {
    // The immutable response must not depend on recording the blocked attempt.
  }
  res.status(405).json({
    error: "활동 로그는 운영 감사 목적으로 삭제할 수 없습니다.",
    reason: "AUDIT_LOG_IMMUTABLE",
  });
});

module.exports = router;
