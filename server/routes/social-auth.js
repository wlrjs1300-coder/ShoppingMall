const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { issueCustomerToken, setCustomerCookie } = require("../middleware/customerAuth");
const { createPendingSocialLink } = require("../services/social-link");

const router = express.Router();
const STATE_COOKIE = "tteok_social_state";
const SIGNUP_COOKIE = "tteok_social_signup";
const SIGNUP_TTL_MS = 10 * 60 * 1000;

const providers = {
  google: {
    label: "Google",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    authorizeParams: { prompt: "select_account" },
    profile: (body) => ({ id: String(body.sub || ""), email: body.email, emailVerified: body.email_verified === true, name: body.name }),
  },
  kakao: {
    label: "카카오",
    clientId: () => process.env.KAKAO_CLIENT_ID,
    clientSecret: () => process.env.KAKAO_CLIENT_SECRET,
    authorizeUrl: "https://kauth.kakao.com/oauth/authorize",
    tokenUrl: "https://kauth.kakao.com/oauth/token",
    profileUrl: "https://kapi.kakao.com/v2/user/me",
    scope: "",
    profile: (body) => ({
      id: String(body.id || ""),
      email: body.kakao_account?.email,
      emailVerified: body.kakao_account?.is_email_verified === true,
      name: body.kakao_account?.profile?.nickname || body.properties?.nickname,
    }),
  },
  naver: {
    label: "네이버",
    clientId: () => process.env.NAVER_CLIENT_ID,
    clientSecret: () => process.env.NAVER_CLIENT_SECRET,
    authorizeUrl: "https://nid.naver.com/oauth2.0/authorize",
    tokenUrl: "https://nid.naver.com/oauth2.0/token",
    profileUrl: "https://openapi.naver.com/v1/nid/me",
    scope: "",
    profile: (body) => ({ id: String(body.response?.id || ""), email: body.response?.email, emailVerified: true, name: body.response?.name || body.response?.nickname }),
  },
};

function publicOrigin(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function callbackUrl(req, provider) {
  return `${publicOrigin(req)}/api/auth/social/${provider}/callback`;
}

function isConfigured(provider) {
  const config = providers[provider];
  return Boolean(config?.clientId() && (provider === "kakao" || config.clientSecret()));
}

function redirectWithError(res, message) {
  res.redirect(`/login.html?social_error=${encodeURIComponent(message)}`);
}

function signupCookieOptions() {
  return { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" };
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createPendingSocialSignup(res, provider, profile, email) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SIGNUP_TTL_MS);
  db.prepare("DELETE FROM social_signup_attempts WHERE expires_at <= ? OR used_at IS NOT NULL").run(now.toISOString());
  db.prepare(`INSERT INTO social_signup_attempts
    (token_hash, provider, provider_user_id, email, display_name, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET token_hash=excluded.token_hash,
      email=excluded.email, display_name=excluded.display_name, expires_at=excluded.expires_at,
      used_at=NULL, created_at=excluded.created_at`)
    .run(tokenHash(token), provider, profile.id, email || null, profile.name || null, expiresAt.toISOString(), now.toISOString());
  res.cookie(SIGNUP_COOKIE, token, { ...signupCookieOptions(), maxAge: SIGNUP_TTL_MS });
}

function createSocialUser(provider, profile, email, marketingConsent = false) {
  const now = new Date().toISOString();
  const fingerprint = crypto.createHash("sha256").update(`${provider}:${profile.id}`).digest("hex");
  let username = `${provider.slice(0, 6)}_${fingerprint.slice(0, 10)}`;
  while (db.prepare("SELECT 1 FROM user_accounts WHERE username=?").get(username)) {
    username = `${provider.slice(0, 6)}_${crypto.randomBytes(5).toString("hex")}`;
  }
  const userId = `user-social-${provider}-${crypto.randomUUID()}`;
  const accountEmail = email || `${provider}.${fingerprint.slice(0, 20)}@social.invalid`;
  const name = String(profile.name || `${providers[provider].label} 회원`).trim().slice(0, 50);
  const passwordHash = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 10);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO user_accounts
      (id, username, email, password_hash, name, phone, role, status, terms_agreed_at, privacy_agreed_at,
       marketing_consent, profile_completed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', 'customer', 'active', ?, ?, ?, 0, ?, ?)`)
      .run(userId, username, accountEmail, passwordHash, name, now, now, marketingConsent ? 1 : 0, now, now);
    db.prepare(`INSERT INTO social_identities (provider, provider_user_id, user_id, email, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(provider, profile.id, userId, email || null, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db.prepare("SELECT * FROM user_accounts WHERE id=?").get(userId);
}

router.get("/providers", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ providers: Object.keys(providers).filter(isConfigured) });
});

router.get("/signup-session", (req, res) => {
  res.set("Cache-Control", "no-store");
  const token = req.cookies?.[SIGNUP_COOKIE];
  const attempt = token && db.prepare(`SELECT provider, display_name FROM social_signup_attempts
    WHERE token_hash=? AND used_at IS NULL AND expires_at > ?`).get(tokenHash(token), new Date().toISOString());
  if (!attempt) return res.status(404).json({ error: "소셜 인증 정보가 만료되었습니다. 다시 로그인해 주세요." });
  res.json({ provider: attempt.provider, displayName: attempt.display_name || null });
});

router.post("/signup-consent", (req, res) => {
  if (req.body?.agreeTerms !== true || req.body?.agreePrivacy !== true) {
    return res.status(400).json({ error: "필수 약관에 모두 동의해 주세요." });
  }
  const token = req.cookies?.[SIGNUP_COOKIE];
  const now = new Date().toISOString();
  const attempt = token && db.prepare(`SELECT * FROM social_signup_attempts
    WHERE token_hash=? AND used_at IS NULL AND expires_at > ?`).get(tokenHash(token), now);
  if (!attempt) return res.status(410).json({ error: "소셜 인증 정보가 만료되었습니다. 다시 로그인해 주세요." });
  const existingIdentity = db.prepare("SELECT user_id FROM social_identities WHERE provider=? AND provider_user_id=?")
    .get(attempt.provider, attempt.provider_user_id);
  if (existingIdentity) return res.status(409).json({ error: "이미 가입된 소셜 계정입니다. 로그인 화면에서 다시 시도해 주세요." });
  try {
    const user = createSocialUser(attempt.provider, { id: attempt.provider_user_id, name: attempt.display_name }, attempt.email || "", req.body?.agreeMarketing === true);
    db.prepare("UPDATE social_signup_attempts SET used_at=? WHERE token_hash=?").run(now, attempt.token_hash);
    res.clearCookie(SIGNUP_COOKIE, signupCookieOptions());
    setCustomerCookie(res, issueCustomerToken(user.id, user.role));
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error("[social-auth:signup-consent]", error);
    res.status(500).json({ error: "계정 생성 중 오류가 발생했습니다. 다시 시도해 주세요." });
  }
});

router.get("/:provider", (req, res) => {
  const { provider } = req.params;
  const config = providers[provider];
  if (!config) return redirectWithError(res, "지원하지 않는 소셜 로그인입니다.");
  if (!isConfigured(provider)) return redirectWithError(res, `${config.label} 로그인이 아직 설정되지 않았습니다.`);
  const state = crypto.randomBytes(24).toString("hex");
  res.cookie(STATE_COOKIE, `${provider}:${state}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
    path: "/api/auth/social",
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId(),
    redirect_uri: callbackUrl(req, provider),
    state,
  });
  if (config.scope) params.set("scope", config.scope);
  for (const [key, value] of Object.entries(config.authorizeParams || {})) params.set(key, value);
  res.redirect(`${config.authorizeUrl}?${params}`);
});

router.get("/:provider/callback", async (req, res) => {
  const { provider } = req.params;
  const config = providers[provider];
  const expectedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: "/api/auth/social" });

  if (req.query.error) {
    return redirectWithError(res, req.query.error === "access_denied" ? "소셜 로그인을 취소했습니다." : "소셜 로그인 제공자가 요청을 거절했습니다.");
  }

  if (!config || !req.query.code || !req.query.state || expectedState !== `${provider}:${req.query.state}`) {
    return redirectWithError(res, "소셜 로그인 요청이 만료되었거나 올바르지 않습니다.");
  }

  try {
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId(),
      code: String(req.query.code),
      redirect_uri: callbackUrl(req, provider),
    });
    if (config.clientSecret()) tokenParams.set("client_secret", config.clientSecret());
    if (provider === "naver") tokenParams.set("state", String(req.query.state));

    const tokenResponse = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams,
    });
    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenBody.access_token) throw new Error("token exchange failed");

    const profileResponse = await fetch(config.profileUrl, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    const profileBody = await profileResponse.json();
    if (!profileResponse.ok) throw new Error("profile request failed");
    const profile = config.profile(profileBody);
    if (!profile.id) throw new Error("provider id missing");

    let user = db.prepare(`
      SELECT u.* FROM social_identities s
      JOIN user_accounts u ON u.id = s.user_id
      WHERE s.provider = ? AND s.provider_user_id = ?
    `).get(provider, profile.id);

    if (!user) {
      const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
      const existingEmailUser = email && profile.emailVerified
        ? db.prepare("SELECT * FROM user_accounts WHERE email = ?").get(email)
        : null;
      if (existingEmailUser) {
        createPendingSocialLink(res, { provider, providerUserId: profile.id, email: email || null });
        return res.redirect(`/login.html?social_link=${encodeURIComponent(provider)}`);
      }
      createPendingSocialSignup(res, provider, profile, email && profile.emailVerified ? email : "");
      return res.redirect("/social-consent.html");
    }

    if (user.status !== "active") return redirectWithError(res, "사용할 수 없는 계정입니다.");
    setCustomerCookie(res, issueCustomerToken(user.id, user.role));
    res.redirect("/index.html");
  } catch (error) {
    console.error(`[social-auth:${provider}]`, error);
    redirectWithError(res, "소셜 로그인 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  }
});

module.exports = router;
