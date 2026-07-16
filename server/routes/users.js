const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { normalizeEmail, isValidEmail, normalizePhone, isValidPhone } = require("../utils/normalize");
const {
  issueCustomerToken,
  setCustomerCookie,
  clearCustomerCookie,
  requireCustomerAuth,
} = require("../middleware/customerAuth");

const router = express.Router();

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt는 72바이트를 넘는 입력을 조용히 잘라버리므로 그 이상은 의미가 없음
const NAME_MAX = 50;
const ADDRESS_MAX = 200;
const POSTAL_CODE_MAX = 20;

const UNIQUE_CONSTRAINT_ERRCODE = 2067; // SQLITE_CONSTRAINT_UNIQUE

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

const checkEmailLimiter = makeLimiter(30);
const signupLimiter = makeLimiter(10);
const loginLimiter = makeLimiter(10);

const GENERIC_LOGIN_ERROR = "이메일 또는 비밀번호가 올바르지 않습니다.";

function rowToUser(row) {
  return { id: row.id, email: row.email, name: row.name, phone: row.phone };
}

// 회원가입 입력값을 한 곳에서 검증·정규화한다 (라우터 핸들러에 검증 로직을 흩뿌리지 않기 위함).
function validateSignupPayload(body) {
  const { email, password, name, phone, postalCode, address, addressDetail, agreeTerms, agreePrivacy, agreeMarketing } = body || {};

  if (typeof email !== "string" || typeof password !== "string" || typeof name !== "string" || typeof phone !== "string" || typeof address !== "string") {
    return { error: "입력값이 올바르지 않습니다." };
  }

  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) return { error: "이메일 형식이 올바르지 않습니다." };

  // bcrypt는 72바이트를 넘는 입력을 조용히 잘라버린다. 문자 길이(.length)만 보면
  // 한글·이모지 등 멀티바이트 입력에서 "72자 이하"인데도 실제로는 72바이트를 넘어
  // 뒷부분이 해시에 반영되지 않는 문제가 생길 수 있어 UTF-8 바이트 길이로 검사한다.
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (password.length < PASSWORD_MIN || passwordBytes > PASSWORD_MAX) {
    return { error: `비밀번호는 ${PASSWORD_MIN}자 이상, 72바이트(영문 72자/한글 24자 이내) 이하로 입력해 주세요.` };
  }

  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > NAME_MAX) return { error: "이름을 확인해 주세요." };

  const normalizedPhone = normalizePhone(phone);
  if (!isValidPhone(normalizedPhone)) return { error: "휴대폰 번호 형식이 올바르지 않습니다." };

  const trimmedAddress = address.trim();
  if (!trimmedAddress || trimmedAddress.length > ADDRESS_MAX) return { error: "주소를 확인해 주세요." };

  const trimmedAddressDetail = typeof addressDetail === "string" ? addressDetail.trim().slice(0, ADDRESS_MAX) : null;
  const trimmedPostalCode = typeof postalCode === "string" ? postalCode.trim().slice(0, POSTAL_CODE_MAX) : null;

  if (agreeTerms !== true || agreePrivacy !== true) return { error: "필수 약관에 동의해 주세요." };

  return {
    data: {
      email: normalizedEmail,
      password,
      name: trimmedName,
      phone: normalizedPhone,
      address: trimmedAddress,
      addressDetail: trimmedAddressDetail || null,
      postalCode: trimmedPostalCode || null,
      marketingConsent: agreeMarketing === true ? 1 : 0,
    },
  };
}

// POST /api/users/check-email
router.post("/check-email", checkEmailLimiter, (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== "string") return res.status(400).json({ error: "이메일을 입력해 주세요." });

  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) return res.status(400).json({ error: "이메일 형식이 올바르지 않습니다." });

  const existing = db.prepare("SELECT id FROM user_accounts WHERE email = ?").get(normalizedEmail);
  res.json({ available: !existing });
});

// POST /api/users/signup
router.post("/signup", signupLimiter, (req, res) => {
  const { error, data } = validateSignupPayload(req.body);
  if (error) return res.status(400).json({ error });

  const existing = db.prepare("SELECT id FROM user_accounts WHERE email = ?").get(data.email);
  if (existing) return res.status(409).json({ error: "이미 가입된 이메일입니다." });

  const now = new Date().toISOString();
  const userId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const addressId = `addr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const passwordHash = bcrypt.hashSync(data.password, 10);

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO user_accounts
        (id, email, password_hash, name, phone, status, terms_agreed_at, privacy_agreed_at, marketing_consent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(userId, data.email, passwordHash, data.name, data.phone, now, now, data.marketingConsent, now, now);

    db.prepare(`
      INSERT INTO user_addresses
        (id, user_id, address_name, recipient_name, recipient_phone, postal_code, address, address_detail, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(addressId, userId, "기본 배송지", data.name, data.phone, data.postalCode, data.address, data.addressDetail, now, now);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    if (err.errcode === UNIQUE_CONSTRAINT_ERRCODE) {
      // 사전 조회와 INSERT 사이의 경쟁 상태(동시 가입 요청)로 인한 중복
      return res.status(409).json({ error: "이미 가입된 이메일입니다." });
    }
    console.error("[users.signup] 회원가입 처리 실패:", err);
    return res.status(500).json({ error: "회원가입 처리 중 오류가 발생했습니다." });
  }

  const token = issueCustomerToken(userId);
  setCustomerCookie(res, token);
  res.status(201).json({ user: { id: userId, email: data.email, name: data.name, phone: data.phone } });
});

// POST /api/users/login
router.post("/login", loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  const normalizedEmail = normalizeEmail(email);
  const user = db.prepare("SELECT * FROM user_accounts WHERE email = ?").get(normalizedEmail);

  if (!user || user.status !== "active" || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  const token = issueCustomerToken(user.id);
  setCustomerCookie(res, token);
  res.json({ user: rowToUser(user) });
});

// POST /api/users/logout — 쿠키가 없거나 만료됐어도 항상 성공으로 처리
router.post("/logout", (req, res) => {
  clearCustomerCookie(res);
  res.json({ ok: true });
});

// GET /api/users/me
router.get("/me", requireCustomerAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, name, phone, status, created_at FROM user_accounts WHERE id = ?").get(req.user.id);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      status: user.status,
      createdAt: user.created_at,
    },
  });
});

module.exports = router;
