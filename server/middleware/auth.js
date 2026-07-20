const jwt = require("jsonwebtoken");

const ROLE_PRIORITY = {
  owner: 300,
  manager: 200,
  staff: 100,
  admin: 300,
  customer: 0,
};

function normalizeRole(role) {
  if (role === "owner" || role === "manager" || role === "staff" || role === "admin" || role === "customer") return role;
  return "customer";
}

function normalizeAdminRole(role) {
  if (role === "owner" || role === "manager" || role === "staff") return role;
  if (role === "admin") return "owner";
  return "customer";
}

function requireRole(allowedRoles) {
  const allow = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return (req, res, next) => {
    const role = normalizeRole(req.admin?.role || "customer");
    const allowed = new Set((allow || ["owner"]).map(normalizeRole));

    const maxLevel = (value) => ROLE_PRIORITY[value] ?? 0;
    const currentLevel = maxLevel(role);
    const neededLevel = Math.max(...[...allowed].map(maxLevel));

    if (currentLevel < neededLevel) {
      return res.status(403).json({ error: "권한이 부족합니다." });
    }
    next();
  };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "로그인 정보가 없습니다." });
  }
  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "유효하지 않은 인증 정보입니다." });
  }

  const normalized = normalizeAdminRole(payload.role);
  if (!ROLE_PRIORITY.hasOwnProperty(normalized) || normalized === "customer") {
    return res.status(403).json({ error: "관리자 권한이 없습니다." });
  }

  req.admin = {
    id: payload.sub || `admin:${payload.role || "admin"}`,
    role: normalized,
    payload,
  };
  next();
}

module.exports = { requireAuth, requireRole, normalizeRole, normalizeAdminRole };
