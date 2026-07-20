const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { normalizePhone, isValidPhone } = require("../utils/normalize");
const { sendSms } = require("../services/notify");

const router = express.Router();

const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000; // 5분
const MIN_RESEND_INTERVAL_MS = 60 * 1000; // 같은 번호 재전송 최소 간격
const MAX_ATTEMPTS = 5;

function isSolapiConfigured() {
  return Boolean(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && process.env.SOLAPI_SENDER_PHONE);
}

function generateCode() {
  if (process.env.NODE_ENV === "test") return process.env.PHONE_TEST_CODE || "123456";
  const min = 10 ** (CODE_LENGTH - 1);
  const max = 10 ** CODE_LENGTH;
  return String(Math.floor(min + Math.random() * (max - min)));
}

function codeHash(phone, code) {
  const pepper = process.env.AUTH_CODE_PEPPER || process.env.JWT_SECRET || "local-development-pepper";
  return crypto.createHmac("sha256", pepper).update(`${phone}:${code}`).digest("hex");
}

function safeCodeEqual(expected, phone, code) {
  if (!expected) return false;
  const actual = codeHash(phone, code);
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function cleanupExpiredRecords() {
  const consumedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM phone_verifications WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)")
    .run(new Date().toISOString(), consumedCutoff);
}

function makeLimiter(max) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: { error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
  });
}

const sendCodeLimiter = makeLimiter(10);
const verifyCodeLimiter = makeLimiter(20);

// POST /api/phone/send-code
router.post("/send-code", sendCodeLimiter, async (req, res) => {
  const { phone } = req.body || {};
  if (typeof phone !== "string") return res.status(400).json({ error: "휴대폰 번호를 입력해 주세요." });

  const normalizedPhone = normalizePhone(phone);
  if (!isValidPhone(normalizedPhone)) return res.status(400).json({ error: "휴대폰 번호 형식이 올바르지 않습니다." });

  cleanupExpiredRecords();
  if (process.env.NODE_ENV === "production" && !isSolapiConfigured()) {
    return res.status(503).json({ error: "휴대폰 인증 서비스를 사용할 수 없습니다. 고객센터로 문의해 주세요." });
  }

  const last = db.prepare(
    "SELECT created_at FROM phone_verifications WHERE phone = ? ORDER BY created_at DESC LIMIT 1",
  ).get(normalizedPhone);
  if (last && Date.now() - new Date(last.created_at).getTime() < MIN_RESEND_INTERVAL_MS) {
    return res.status(429).json({ error: "잠시 후 다시 시도해 주세요." });
  }

  const now = new Date();
  const code = generateCode();
  const id = `phoneverify-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();

  db.prepare(`
    INSERT INTO phone_verifications (id, phone, code, code_hash, expires_at, attempts, created_at)
    VALUES (?, ?, 'hashed', ?, ?, 0, ?)
  `).run(id, normalizedPhone, codeHash(normalizedPhone, code), expiresAt, now.toISOString());

  const expiresInSeconds = CODE_TTL_MS / 1000;

  if (!isSolapiConfigured()) {
    // 개발 모드: 실제 SMS 발송 대신 코드를 응답에 그대로 실어 보낸다.
    // SOLAPI_* 환경변수가 채워지는 순간 이 분기는 더 이상 타지 않는다.
    // 로컬에서도 원문 인증번호는 응답·로그 어디에도 노출하지 않는다.
    return res.json({ ok: true, devMode: true, expiresInSeconds });
  }

  const storeName = process.env.STORE_NAME || "따뜻한 떡집";
  const result = await sendSms(normalizedPhone, `[${storeName}] 인증번호는 [${code}]입니다. 5분 이내에 입력해 주세요.`);
  if (!result?.ok) {
    console.error("[phone] SMS 발송 실패:", result?.reason);
    return res.status(500).json({ error: "인증번호 발송에 실패했습니다. 잠시 후 다시 시도해 주세요." });
  }
  res.json({ ok: true, devMode: false, expiresInSeconds });
});

// POST /api/phone/verify-code
router.post("/verify-code", verifyCodeLimiter, (req, res) => {
  const { phone, code } = req.body || {};
  if (typeof phone !== "string" || typeof code !== "string") {
    return res.status(400).json({ error: "휴대폰 번호와 인증번호를 입력해 주세요." });
  }

  const normalizedPhone = normalizePhone(phone);
  const row = db.prepare(
    "SELECT * FROM phone_verifications WHERE phone = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
  ).get(normalizedPhone);

  if (!row) return res.status(400).json({ error: "인증번호를 먼저 요청해 주세요." });
  if (row.verified_at) return res.json({ verified: true });

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: "인증번호가 만료되었습니다. 다시 요청해 주세요." });
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return res.status(400).json({ error: "시도 횟수를 초과했습니다. 인증번호를 다시 요청해 주세요." });
  }

  if (!safeCodeEqual(row.code_hash, normalizedPhone, code.trim())) {
    db.prepare("UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    return res.status(400).json({ error: "인증번호가 올바르지 않습니다." });
  }

  db.prepare("UPDATE phone_verifications SET verified_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  res.json({ verified: true });
});

module.exports = router;
