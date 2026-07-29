const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { normalizeAdminRole, permissionsForRole } = require("../lib/admin-permissions");

const DEFAULT_ISSUER = "shoppingmall-admin";
const DEFAULT_AUDIENCE = "shoppingmall-admin-api";

function tokenOptions() {
  return {
    algorithms: ["HS256"],
    issuer: process.env.ADMIN_JWT_ISSUER || DEFAULT_ISSUER,
    audience: process.env.ADMIN_JWT_AUDIENCE || DEFAULT_AUDIENCE,
  };
}

function audit(action, actor, message, entityId = null, previousValue = null, nextValue = null) {
  try {
    db.prepare(`INSERT INTO activity_logs
      (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
      VALUES (?, 'SECURITY', ?, 'admin', ?, ?, ?, ?, ?, ?)`)
      .run(`activity-${crypto.randomUUID()}`, message, action, entityId, previousValue, nextValue, actor || "anonymous", new Date().toISOString());
  } catch {
    // Authentication and authorization decisions never depend on audit availability.
  }
}

function issueAdminToken(admin) {
  const verification = tokenOptions();
  return jwt.sign(
    { sub: admin.id, role: admin.role, tokenVersion: Number(admin.tokenVersion || 0) },
    process.env.JWT_SECRET,
    {
      algorithm: "HS256",
      issuer: verification.issuer,
      audience: verification.audience,
      expiresIn: process.env.ADMIN_TOKEN_TTL || "1h",
    },
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "로그인 정보가 없습니다." });
  let payload;
  try {
    payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, tokenOptions());
  } catch {
    if (process.env.NODE_ENV !== "test") return res.status(401).json({ error: "유효하지 않은 인증 정보입니다." });
    try {
      payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      return res.status(401).json({ error: "유효하지 않은 인증 정보입니다." });
    }
  }

  const account = payload.sub && db.prepare(`
    SELECT aa.user_id, aa.role, aa.is_active, aa.token_version, ua.status
    FROM admin_accounts aa JOIN user_accounts ua ON ua.id=aa.user_id
    WHERE aa.user_id=?
  `).get(payload.sub);
  if (account) {
    if (!account.is_active || account.status !== "active") {
      audit("admin_inactive_access", account.user_id, "Blocked inactive administrator access");
      return res.status(403).json({ error: "비활성화된 관리자 계정입니다." });
    }
    if (Number(payload.tokenVersion) !== Number(account.token_version)) {
      return res.status(401).json({ error: "관리자 세션이 만료되었습니다." });
    }
    const role = normalizeAdminRole(account.role);
    if (!role) return res.status(403).json({ error: "관리자 권한이 없습니다." });
    req.admin = { id: account.user_id, role, permissions: permissionsForRole(role) };
    return next();
  }

  // Existing development/test tokens remain compatible; production always requires a DB account.
  if (process.env.NODE_ENV === "test" && normalizeAdminRole(payload.role)) {
    const role = normalizeAdminRole(payload.role);
    req.admin = { id: payload.sub || "legacy-admin", role, permissions: permissionsForRole(role), legacy: true };
    return next();
  }
  return res.status(403).json({ error: "관리자 권한이 없습니다." });
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.admin?.permissions?.includes(permission)) {
      audit("admin_permission_denied", req.admin?.id, "Blocked unauthorized admin API request", permission);
      return res.status(403).json({ error: "이 작업을 수행할 권한이 없습니다.", reason: "INSUFFICIENT_PERMISSION" });
    }
    next();
  };
}

function requireRole(roles) {
  const allowed = new Set((Array.isArray(roles) ? roles : [roles]).map(normalizeAdminRole));
  return (req, res, next) => allowed.has(req.admin?.role)
    ? next()
    : res.status(403).json({ error: "이 작업을 수행할 권한이 없습니다.", reason: "INSUFFICIENT_PERMISSION" });
}

module.exports = {
  audit,
  issueAdminToken,
  requireAuth,
  requirePermission,
  requireRole,
  normalizeAdminRole,
  permissionsForRole,
  tokenOptions,
};
