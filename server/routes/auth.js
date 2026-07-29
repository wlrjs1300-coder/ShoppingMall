const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { audit, issueAdminToken, requireAuth } = require("../middleware/auth");
const { permissionsForRole } = require("../lib/admin-permissions");

const router = express.Router();
const GENERIC_LOGIN_ERROR = "관리자 로그인 정보를 확인해 주세요.";
const DUMMY_HASH = bcrypt.hashSync("not-a-real-admin-password", 10);

const adminLoginLimiter = rateLimit({
  windowMs: Number(process.env.ADMIN_LOGIN_RATE_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.ADMIN_LOGIN_RATE_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === "test",
  message: { error: "로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

function safeEqual(left, right) {
  const supplied = Buffer.from(String(left || ""));
  const expected = Buffer.from(String(right || ""));
  return supplied.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(supplied, expected);
}

router.post("/login", adminLoginLimiter, (req, res) => {
  const identifier = String(req.body?.identifier || req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const code = req.body?.code;

  if (code !== undefined) {
    if (process.env.NODE_ENV === "production") {
      audit("legacy_admin_login_blocked", "anonymous", "Blocked legacy administrator login");
      return res.status(403).json({ error: "운영 환경에서는 관리자 계정으로 로그인해 주세요.", reason: "LEGACY_ADMIN_LOGIN_DISABLED" });
    }
    if (!safeEqual(code, process.env.ADMIN_CODE)) {
      audit("admin_login_failed", "anonymous", "Administrator login failed");
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }
    const legacy = { id: "admin:legacy", role: "super_admin", tokenVersion: 0 };
    audit("admin_login_succeeded", legacy.id, "Legacy administrator login succeeded");
    return res.json({ token: issueAdminToken(legacy), admin: { id: legacy.id, role: legacy.role, permissions: permissionsForRole(legacy.role) } });
  }

  const account = identifier ? db.prepare(`
    SELECT ua.id, ua.username, ua.email, ua.password_hash, ua.status,
           aa.role, aa.is_active, aa.token_version
    FROM user_accounts ua JOIN admin_accounts aa ON aa.user_id=ua.id
    WHERE ua.username=? OR ua.email=?
  `).get(identifier, identifier) : null;
  const valid = bcrypt.compareSync(password, account?.password_hash || DUMMY_HASH);
  if (!account || !valid || !account.is_active || account.status !== "active") {
    audit(account && (!account.is_active || account.status !== "active") ? "admin_inactive_login" : "admin_login_failed",
      account?.id || "anonymous", "Administrator login failed");
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE admin_accounts SET last_login_at=?, updated_at=? WHERE user_id=?").run(now, now, account.id);
  const admin = { id: account.id, role: account.role, tokenVersion: account.token_version };
  audit("admin_login_succeeded", account.id, "Administrator login succeeded");
  res.json({ token: issueAdminToken(admin), admin: { id: admin.id, role: admin.role, permissions: permissionsForRole(admin.role) } });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ admin: { id: req.admin.id, role: req.admin.role, permissions: req.admin.permissions } });
});

module.exports = router;
