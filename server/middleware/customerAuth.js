const jwt = require("jsonwebtoken");
const db = require("../db");

const COOKIE_NAME = "tteok_customer_token";
const TOKEN_TTL = "7d";
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 로그인·회원가입에서 쿠키를 설정할 때와 로그아웃에서 지울 때 옵션이 어긋나면
// 브라우저가 쿠키를 못 지울 수 있어, 두 곳 모두 이 함수로 옵션을 통일한다.
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

function issueCustomerToken(userId, role = "customer") {
  const safeRole = role === "admin" ? "admin" : "customer";
  return jwt.sign({ sub: userId, role: safeRole }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function setCustomerCookie(res, token) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: COOKIE_MAX_AGE_MS });
}

function clearCustomerCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

function requireCustomerAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "로그인이 필요합니다." });
  }
  if (!["customer", "admin"].includes(payload.role) || !payload.sub) {
    return res.status(401).json({ error: "로그인이 필요합니다." });
  }

  const user = db.prepare("SELECT id, role, status FROM user_accounts WHERE id = ?").get(payload.sub);
  if (!user || user.status !== "active") {
    return res.status(401).json({ error: "로그인이 필요합니다." });
  }

  req.user = { id: user.id, role: user.role };
  next();
}

function optionalCustomerAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!["customer", "admin"].includes(payload.role) || !payload.sub) return next();
    const user = db.prepare("SELECT id, role, status FROM user_accounts WHERE id = ?").get(payload.sub);
    if (user?.status === "active") req.user = { id: user.id, role: user.role };
  } catch {
    // 공개 주문은 비회원도 가능하므로 잘못되거나 만료된 쿠키는 비회원으로 처리한다.
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  issueCustomerToken,
  setCustomerCookie,
  clearCustomerCookie,
  optionalCustomerAuth,
  requireCustomerAuth,
};
