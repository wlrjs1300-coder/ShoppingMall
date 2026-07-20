const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { isEmailConfigured, sendPasswordResetEmail } = require("../services/email");

const router = express.Router();
const TOKEN_TTL_MS = 15 * 60 * 1000;
const GENERIC_MESSAGE = "입력한 정보와 일치하는 계정이 있다면 비밀번호 재설정 안내가 생성됩니다.";

const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicOrigin(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

router.post("/request", requestLimiter, async (req, res) => {
  const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim().toLowerCase() : "";
  const user = identifier
    ? db.prepare("SELECT id, email FROM user_accounts WHERE (username = ? OR email = ?) AND status = 'active'").get(identifier, identifier)
    : null;

  let resetUrl;
  if (user) {
    const rawToken = process.env.NODE_ENV === "test" && process.env.PASSWORD_RESET_TEST_TOKEN
      ? process.env.PASSWORD_RESET_TEST_TOKEN
      : crypto.randomBytes(32).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now.toISOString(), user.id);
    db.prepare(`
      INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(`reset-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`, user.id, tokenHash(rawToken), expiresAt.toISOString(), now.toISOString());
    resetUrl = `${publicOrigin(req)}/reset-password.html?token=${rawToken}`;

  }

  const body = { ok: true, message: GENERIC_MESSAGE };
  if (resetUrl && isEmailConfigured()) {
    const emailResult = await sendPasswordResetEmail(user.email, resetUrl);
    if (!emailResult.ok) console.error("[password-reset] 이메일 발송 실패");
  }
  res.json(body);
});

router.get("/validate", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) return res.status(400).json({ valid: false });
  const row = db.prepare("SELECT expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?").get(tokenHash(token));
  const valid = Boolean(row && !row.used_at && new Date(row.expires_at).getTime() > Date.now());
  res.status(valid ? 200 : 400).json({ valid });
});

router.post("/confirm", requestLimiter, (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (password.length < 8 || passwordBytes > 72) {
    return res.status(400).json({ error: "비밀번호는 8자 이상, 72바이트 이내로 입력해 주세요." });
  }

  const row = token
    ? db.prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ?").get(tokenHash(token))
    : null;
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
    return res.status(400).json({ error: "재설정 링크가 만료되었거나 이미 사용되었습니다." });
  }

  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE user_accounts SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(bcrypt.hashSync(password, 10), now, row.user_id);
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
      .run(now, row.user_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("[password-reset]", error);
    return res.status(500).json({ error: "비밀번호 변경 중 오류가 발생했습니다." });
  }

  res.json({ ok: true });
});

module.exports = router;
