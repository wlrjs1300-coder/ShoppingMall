const crypto = require("crypto");
const db = require("../db");

const PENDING_COOKIE = "tteok_social_link";
const PENDING_TTL_MS = 10 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createPendingSocialLink(res, { provider, providerUserId, email = null }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_TTL_MS);
  db.prepare("DELETE FROM social_link_attempts WHERE expires_at <= ? OR used_at IS NOT NULL").run(now.toISOString());
  db.prepare(`
    INSERT INTO social_link_attempts (token_hash, provider, provider_user_id, email, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET
      token_hash=excluded.token_hash, email=excluded.email, expires_at=excluded.expires_at, used_at=NULL, created_at=excluded.created_at
  `).run(hashToken(token), provider, providerUserId, email, expiresAt.toISOString(), now.toISOString());
  res.cookie(PENDING_COOKIE, token, { ...cookieOptions(), maxAge: PENDING_TTL_MS });
}

function consumePendingSocialLink(req, res, userId) {
  const token = req.cookies?.[PENDING_COOKIE];
  if (!token) return null;
  res.clearCookie(PENDING_COOKIE, cookieOptions());
  const now = new Date().toISOString();
  const attempt = db.prepare(`
    SELECT * FROM social_link_attempts
    WHERE token_hash=? AND used_at IS NULL AND expires_at > ?
  `).get(hashToken(token), now);
  if (!attempt) return null;

  db.exec("BEGIN");
  try {
    const existing = db.prepare("SELECT user_id FROM social_identities WHERE provider=? AND provider_user_id=?")
      .get(attempt.provider, attempt.provider_user_id);
    if (existing && existing.user_id !== userId) throw new Error("SOCIAL_IDENTITY_CONFLICT");
    if (!existing) {
      db.prepare(`
        INSERT INTO social_identities (provider, provider_user_id, user_id, email, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(attempt.provider, attempt.provider_user_id, userId, attempt.email, now);
    }
    db.prepare("UPDATE social_link_attempts SET used_at=? WHERE token_hash=?").run(now, attempt.token_hash);
    db.exec("COMMIT");
    return attempt.provider;
  } catch (error) {
    db.exec("ROLLBACK");
    if (error.message === "SOCIAL_IDENTITY_CONFLICT") return "conflict";
    throw error;
  }
}

module.exports = { createPendingSocialLink, consumePendingSocialLink, PENDING_COOKIE };
