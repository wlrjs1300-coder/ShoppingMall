const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const { ADMIN_ROLES, permissionsForRole } = require("../lib/admin-permissions");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("admin_users:manage"));

function activeSuperAdminCount() {
  return db.prepare(`SELECT COUNT(*) AS count FROM admin_accounts aa
    JOIN user_accounts ua ON ua.id=aa.user_id
    WHERE aa.role='super_admin' AND aa.is_active=1 AND ua.status='active'`).get().count;
}

function insertAudit(action, actor, message, entityId, previousValue = null, nextValue = null) {
  db.prepare(`INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
    VALUES (?, 'SECURITY', ?, 'admin', ?, ?, ?, ?, ?, ?)`)
    .run(`activity-${crypto.randomUUID()}`, message, action, entityId, previousValue, nextValue, actor, new Date().toISOString());
}

function rollback() {
  try {
    db.exec("ROLLBACK");
  } catch {}
}

router.get("/", (req, res) => {
  const rows = db.prepare(`SELECT aa.user_id, ua.username, ua.email, aa.role, aa.is_active,
    aa.last_login_at, aa.created_at, aa.updated_at
    FROM admin_accounts aa JOIN user_accounts ua ON ua.id=aa.user_id
    ORDER BY aa.created_at`).all();
  res.json({ admins: rows.map((row) => ({
    id: row.user_id, username: row.username, email: row.email, role: row.role,
    active: Boolean(row.is_active), lastLoginAt: row.last_login_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    permissions: permissionsForRole(row.role),
  })) });
});

router.patch("/:id", (req, res) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT user_id, role, is_active, token_version FROM admin_accounts WHERE user_id=?").get(req.params.id);
    if (!current) {
      rollback();
      return res.status(404).json({ error: "관리자 계정을 찾을 수 없습니다." });
    }
    const role = req.body?.role === undefined ? current.role : String(req.body.role);
    const active = req.body?.active === undefined ? Boolean(current.is_active) : req.body.active === true;
    if (!ADMIN_ROLES.includes(role)) {
      rollback();
      return res.status(400).json({ error: "관리자 역할이 올바르지 않습니다." });
    }
    if (current.user_id === req.admin.id && role !== current.role) {
      rollback();
      return res.status(409).json({ error: "현재 로그인한 관리자는 자신의 역할을 변경할 수 없습니다.", reason: "SELF_ROLE_CHANGE_BLOCKED" });
    }
    if (current.user_id === req.admin.id && !active) {
      rollback();
      return res.status(409).json({ error: "현재 로그인한 관리자 계정은 비활성화할 수 없습니다.", reason: "SELF_DEACTIVATION_BLOCKED" });
    }
    const removesSuperAdmin = current.role === "super_admin" && current.is_active && (role !== "super_admin" || !active);
    if (removesSuperAdmin && activeSuperAdminCount() <= 1) {
      rollback();
      return res.status(409).json({ error: "마지막 활성 최고 관리자는 비활성화하거나 강등할 수 없습니다.", reason: "LAST_ACTIVE_SUPER_ADMIN" });
    }

    const changed = role !== current.role || active !== Boolean(current.is_active);
    if (changed) {
      const updated = db.prepare(`UPDATE admin_accounts
        SET role=?, is_active=?, token_version=token_version+1, updated_at=?
        WHERE user_id=? AND token_version=?`)
        .run(role, active ? 1 : 0, new Date().toISOString(), current.user_id, current.token_version);
      if (updated.changes !== 1) throw new Error("ADMIN_ACCOUNT_CONCURRENT_CHANGE");
      insertAudit(active ? "admin_role_changed" : "admin_account_deactivated", req.admin.id,
        active ? "Administrator role changed" : "Administrator account deactivated",
        current.user_id, current.role, role);
      insertAudit("admin_sessions_revoked", req.admin.id, "Administrator sessions revoked", current.user_id);
    }
    db.exec("COMMIT");
    return res.json({ admin: { id: current.user_id, role, active, permissions: permissionsForRole(role) } });
  } catch {
    rollback();
    return res.status(500).json({ error: "관리자 계정 변경을 완료하지 못했습니다." });
  }
});

router.post("/:id/revoke-sessions", (req, res) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT user_id, token_version FROM admin_accounts WHERE user_id=?").get(req.params.id);
    if (!current) {
      rollback();
      return res.status(404).json({ error: "관리자 계정을 찾을 수 없습니다." });
    }
    const updated = db.prepare(`UPDATE admin_accounts SET token_version=token_version+1, updated_at=?
      WHERE user_id=? AND token_version=?`).run(new Date().toISOString(), current.user_id, current.token_version);
    if (updated.changes !== 1) throw new Error("ADMIN_ACCOUNT_CONCURRENT_CHANGE");
    insertAudit("admin_sessions_revoked", req.admin.id, "Administrator sessions revoked", current.user_id);
    db.exec("COMMIT");
    return res.json({ ok: true });
  } catch {
    rollback();
    return res.status(500).json({ error: "관리자 세션을 만료하지 못했습니다." });
  }
});

module.exports = router;
