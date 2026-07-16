const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "인증이 필요합니다." });
  }
  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "토큰이 유효하지 않습니다." });
  }
  if (payload.role !== "admin") {
    return res.status(403).json({ error: "관리자 권한이 필요합니다." });
  }
  req.admin = payload;
  next();
}

module.exports = { requireAuth };
