const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { normalizeEmail, isValidEmail, normalizePhone, isValidPhone } = require("../utils/normalize");
const {
  issueCustomerToken,
  setCustomerCookie,
  clearCustomerCookie,
  requireCustomerAuth,
} = require("../middleware/customerAuth");
const { requireAuth: requireAdminAuth } = require("../middleware/auth");
const { consumePendingSocialLink } = require("../services/social-link");

const router = express.Router();

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt는 72바이트를 넘는 입력을 조용히 잘라버리므로 그 이상은 의미가 없음
const NAME_MAX = 50;
const ADDRESS_MAX = 200;
const POSTAL_CODE_MAX = 20;
const USERNAME_RE = /^[a-z0-9_]{4,20}$/;
const CANCELABLE_ORDER_STATUSES = new Set(["접수대기"]);

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
const findUsernameLimiter = makeLimiter(10);
const LOGIN_FAILURE_LIMIT = 5;

router.get("/admin/directory", requireAdminAuth, (req, res) => {
  const now = new Date();
  const users = db.prepare(`
    SELECT id, name, phone, status, login_locked_until
    FROM user_accounts
    WHERE role='customer'
  `).all().map((user) => ({
    id: user.id,
    name: user.name,
    phone: user.phone,
    status: user.status,
    suspended: Boolean(user.login_locked_until && new Date(user.login_locked_until) > now),
  }));
  res.json({ users });
});

router.post("/admin/:id/suspension", requireAdminAuth, (req, res) => {
  const user = db.prepare("SELECT id, role, status, login_locked_until FROM user_accounts WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
  if (user.role === "admin") return res.status(403).json({ error: "관리자 계정은 이 화면에서 정지할 수 없습니다." });
  if (user.status !== "active") return res.status(409).json({ error: "활성 회원만 정지할 수 있습니다." });
  const currentlySuspended = Boolean(user.login_locked_until && new Date(user.login_locked_until) > new Date());
  const suspended = req.body?.suspended === undefined ? !currentlySuspended : Boolean(req.body.suspended);
  const lockedUntil = suspended ? "9999-12-31T23:59:59.999Z" : null;
  db.prepare("UPDATE user_accounts SET login_failed_count=0, login_locked_until=?, updated_at=? WHERE id=?")
    .run(lockedUntil, new Date().toISOString(), user.id);
  res.json({ ok: true, suspended });
});

router.post("/admin/:id/withdraw", requireAdminAuth, (req, res) => {
  const user = db.prepare("SELECT id, role, status FROM user_accounts WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
  if (user.role === "admin") return res.status(403).json({ error: "관리자 계정은 이 화면에서 탈퇴시킬 수 없습니다." });
  if (user.status === "withdrawn") return res.json({ ok: true, alreadyWithdrawn: true });
  const activeOrder = db.prepare(`SELECT id FROM orders WHERE user_id=? AND workflow_status NOT IN ('취소','배송완료','픽업완료') LIMIT 1`).get(user.id);
  if (activeOrder) return res.status(409).json({ error: "진행 중인 주문이 있어 탈퇴 처리할 수 없습니다." });
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM social_identities WHERE user_id=?").run(user.id);
    db.prepare("DELETE FROM user_addresses WHERE user_id=?").run(user.id);
    db.prepare(`UPDATE user_accounts SET username=NULL, email=?, name='탈퇴회원', phone='', status='withdrawn', marketing_consent=0, login_locked_until=NULL, updated_at=? WHERE id=?`)
      .run(`withdrawn-${user.id}@deleted.local`, now, user.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "회원 탈퇴 처리 중 오류가 발생했습니다." });
  }
  res.json({ ok: true });
});
const LOGIN_LOCK_MS = 15 * 60 * 1000;
// 존재하지 않는 계정도 동일한 bcrypt 비용을 사용해 응답 시간 차이를 줄인다.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("authentication-timing-placeholder", 10);

const GENERIC_LOGIN_ERROR = "아이디 또는 비밀번호가 올바르지 않습니다.";

function rowToUser(row) {
  return { id: row.id, username: row.username, email: row.email, name: row.name, phone: row.phone, role: row.role || "customer", profileCompleted: Boolean(row.profile_completed) };
}

function refreshProfileCompletion(userId) {
  const user = db.prepare("SELECT name, phone FROM user_accounts WHERE id=?").get(userId);
  const address = db.prepare("SELECT 1 FROM user_addresses WHERE user_id=? AND is_default=1 LIMIT 1").get(userId);
  const completed = Boolean(user?.name && isValidPhone(user.phone) && address);
  db.prepare("UPDATE user_accounts SET profile_completed=? WHERE id=?").run(completed ? 1 : 0, userId);
}

// 회원가입 입력값을 한 곳에서 검증·정규화한다 (라우터 핸들러에 검증 로직을 흩뿌리지 않기 위함).
function validateSignupPayload(body) {
  const { username, email, password, name, phone, postalCode, address, addressDetail, agreeTerms, agreePrivacy, agreeMarketing } = body || {};

  if (typeof username !== "string" || typeof email !== "string" || typeof password !== "string" || typeof name !== "string" || typeof phone !== "string" || typeof address !== "string") {
    return { error: "입력값이 올바르지 않습니다." };
  }

  const normalizedUsername = username.trim().toLowerCase();
  if (!USERNAME_RE.test(normalizedUsername)) return { error: "아이디는 영문 소문자, 숫자, 밑줄을 사용해 4~20자로 입력해 주세요." };

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
      username: normalizedUsername,
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

router.post("/check-username", checkEmailLimiter, (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "아이디는 영문 소문자, 숫자, 밑줄을 사용해 4~20자로 입력해 주세요." });
  }
  const existing = db.prepare("SELECT id FROM user_accounts WHERE username = ?").get(username);
  res.json({ available: !existing });
});

router.post("/find-username", findUsernameLimiter, (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const phone = normalizePhone(req.body?.phone);
  if (!name || name.length > NAME_MAX || !isValidPhone(phone)) {
    return res.status(400).json({ error: "이름과 휴대폰 번호를 정확히 입력해 주세요." });
  }

  const verification = db.prepare(`
    SELECT id
    FROM phone_verifications
    WHERE phone = ? AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ?
    ORDER BY verified_at DESC
    LIMIT 1
  `).get(phone, new Date().toISOString());
  if (!verification) {
    return res.status(403).json({ error: "휴대폰 인증을 먼저 완료해 주세요." });
  }

  const user = db.prepare(`
    SELECT username
    FROM user_accounts
    WHERE name = ? AND phone = ? AND status = 'active'
    LIMIT 1
  `).get(name, phone);

  if (!user?.username) {
    return res.status(404).json({ error: "입력한 정보와 일치하는 회원을 찾지 못했습니다." });
  }
  db.prepare("UPDATE phone_verifications SET consumed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), verification.id);
  res.json({ username: user.username });
});

// POST /api/users/signup
router.post("/signup", signupLimiter, (req, res) => {
  const { error, data } = validateSignupPayload(req.body);
  if (error) return res.status(400).json({ error });

  const existing = db.prepare("SELECT id, email, username FROM user_accounts WHERE email = ? OR username = ?").get(data.email, data.username);
  if (existing) {
    return res.status(409).json({ error: existing.username === data.username ? "이미 사용 중인 아이디입니다." : "이미 가입된 이메일입니다." });
  }

  // 휴대폰 인증은 회원가입 필수 단계 — 검증된(verified_at) 뒤 아직 다른 가입에 쓰이지 않은
  // (consumed_at IS NULL) 인증 기록이 있어야 가입을 진행한다.
  const phoneVerification = db.prepare(
    "SELECT id FROM phone_verifications WHERE phone = ? AND verified_at IS NOT NULL AND consumed_at IS NULL ORDER BY verified_at DESC LIMIT 1",
  ).get(data.phone);
  if (!phoneVerification) {
    return res.status(400).json({ error: "휴대폰 인증을 먼저 완료해 주세요." });
  }

  const now = new Date().toISOString();
  const userId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const addressId = `addr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const passwordHash = bcrypt.hashSync(data.password, 10);

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO user_accounts
        (id, username, email, password_hash, name, phone, status, terms_agreed_at, privacy_agreed_at, marketing_consent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(userId, data.username, data.email, passwordHash, data.name, data.phone, now, now, data.marketingConsent, now, now);

    db.prepare(`
      INSERT INTO user_addresses
        (id, user_id, address_name, recipient_name, recipient_phone, postal_code, address, address_detail, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(addressId, userId, "기본 배송지", data.name, data.phone, data.postalCode, data.address, data.addressDetail, now, now);

    db.prepare("UPDATE phone_verifications SET consumed_at = ? WHERE id = ?").run(now, phoneVerification.id);

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
  res.status(201).json({ user: { id: userId, username: data.username, email: data.email, name: data.name, phone: data.phone } });
});

// POST /api/users/login
router.post("/login", loginLimiter, (req, res) => {
  const { identifier, email, password } = req.body || {};
  const rawIdentifier = typeof identifier === "string" ? identifier : email;
  if (typeof rawIdentifier !== "string" || typeof password !== "string") {
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  const normalizedIdentifier = rawIdentifier.trim().toLowerCase();
  const user = db.prepare("SELECT * FROM user_accounts WHERE username = ? OR email = ?").get(normalizedIdentifier, normalizedIdentifier);

  const now = Date.now();
  const locked = user?.login_locked_until && Date.parse(user.login_locked_until) > now;
  const eligible = Boolean(user && !locked && user.status === "active");
  const passwordCorrect = bcrypt.compareSync(password, eligible ? user.password_hash : DUMMY_PASSWORD_HASH);
  const passwordMatches = eligible && passwordCorrect;
  if (!passwordMatches) {
    if (user && user.status === "active" && !locked) {
      const failures = Number(user.login_failed_count || 0) + 1;
      const lockUntil = failures >= LOGIN_FAILURE_LIMIT ? new Date(now + LOGIN_LOCK_MS).toISOString() : null;
      db.prepare("UPDATE user_accounts SET login_failed_count=?, login_locked_until=?, updated_at=? WHERE id=?")
        .run(failures >= LOGIN_FAILURE_LIMIT ? 0 : failures, lockUntil, new Date(now).toISOString(), user.id);
    }
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  db.prepare("UPDATE user_accounts SET login_failed_count=0, login_locked_until=NULL, updated_at=? WHERE id=?")
    .run(new Date().toISOString(), user.id);
  let socialLinked = null;
  try {
    socialLinked = consumePendingSocialLink(req, res, user.id);
  } catch (error) {
    console.error("[users.login] 소셜 계정 연결 실패:", error);
    return res.status(500).json({ error: "로그인은 확인됐지만 소셜 계정을 연결하지 못했습니다. 다시 시도해 주세요." });
  }
  const token = issueCustomerToken(user.id, user.role);
  setCustomerCookie(res, token);
  res.json({
    user: rowToUser(user),
    socialLinked: socialLinked && socialLinked !== "conflict" ? socialLinked : null,
    socialLinkError: socialLinked === "conflict" ? "이 소셜 계정은 다른 회원에게 이미 연결되어 있습니다." : null,
  });
});

// POST /api/users/logout — 쿠키가 없거나 만료됐어도 항상 성공으로 처리
router.post("/logout", (req, res) => {
  clearCustomerCookie(res);
  res.json({ ok: true });
});

// GET /api/users/me
router.get("/me", requireCustomerAuth, (req, res) => {
  const user = db.prepare("SELECT id, username, email, name, phone, role, status, marketing_consent, profile_completed, created_at FROM user_accounts WHERE id = ?").get(req.user.id);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      status: user.status,
      marketingConsent: Boolean(user.marketing_consent),
      profileCompleted: Boolean(user.profile_completed),
      createdAt: user.created_at,
    },
  });
});

// 관리자 회원 쿠키를 기존 관리자 API용 단기 토큰으로 교환합니다.
router.post("/admin-session", requireCustomerAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "관리자 권한이 필요합니다." });
  const token = jwt.sign({ sub: req.user.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "24h" });
  res.json({ token });
});

function getMemberOrderStatusHistory(orderId) {
  return db.prepare(`
    SELECT previous_status, next_status, created_at
    FROM order_status_history
    WHERE order_id = ?
    ORDER BY created_at ASC
  `).all(orderId);
}

function applyMemberOrderHistory(order) {
  const statusHistory = getMemberOrderStatusHistory(order.id);
  if (!statusHistory.length) return order;
  const entries = statusHistory.map((entry) => ({
    previousStatus: entry.previous_status,
    nextStatus: entry.next_status,
    createdAt: entry.created_at,
  }));
  const latest = String(statusHistory[statusHistory.length - 1]?.next_status || "").trim();
  return {
    ...order,
    workflowStatus: latest || order.workflowStatus,
    statusHistory: entries,
  };
}

function rowToMemberOrder(row, includeAddress = false) {
  const items = db.prepare(`
    SELECT
      oi.product_id,
      oi.product_name,
      oi.unit_price,
      oi.quantity,
      oi.quantity_unit,
      oi.line_total,
      p.image_url
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id=?
    ORDER BY oi.id ASC
  `).all(row.id).map((item) => ({
    productId: item.product_id,
    productName: item.product_name,
    unitPrice: item.unit_price,
    quantity: item.quantity,
    quantityUnit: item.quantity_unit || "pack",
    lineTotal: item.line_total,
    productImage: item.image_url || null,
  }));
  const result = {
    id: row.id, items, productSummary: items.length ? `${items[0].productName}${items.length > 1 ? ` 외 ${items.length - 1}건` : ""}` : "상품 없음",
    totalAmount: row.total_amount, status: row.status, fulfillmentType: row.fulfillment_type,
    paymentStatus: row.payment_status, workflowStatus: row.workflow_status,
    pickupDate: row.pickup_date, pickupTime: row.pickup_time, memo: row.memo,
    createdAt: row.created_at, updatedAt: row.updated_at,
    cancelable: CANCELABLE_ORDER_STATUSES.has(row.status),
  };
  if (includeAddress) result.deliveryAddress = row.delivery_address;
  return result;
}

// 아래 /me/* API는 URL의 회원 ID를 신뢰하지 않고 인증 쿠키의 req.user.id만 사용한다.
router.get("/me/orders", requireCustomerAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC").all(req.user.id);
  res.json({ orders: rows.map((row) => applyMemberOrderHistory(rowToMemberOrder(row))) });
});

router.get("/me/orders/:orderId", requireCustomerAuth, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(req.params.orderId, req.user.id);
  if (!order) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  res.json({ order: applyMemberOrderHistory(rowToMemberOrder(order, true)) });
});

router.post("/me/orders/:orderId/cancel", requireCustomerAuth, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(req.params.orderId, req.user.id);
  if (!order) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  if (!CANCELABLE_ORDER_STATUSES.has(order.status)) {
    return res.status(409).json({ error: "접수대기 상태의 주문만 직접 취소할 수 있습니다. 이후에는 고객센터로 문의해 주세요." });
  }
  const payment = db.prepare("SELECT status FROM payments WHERE order_id=?").get(order.id);
  if (payment && ["DONE", "CONFIRMING"].includes(payment.status)) {
    return res.status(409).json({ error: "결제가 진행된 주문은 고객센터를 통해 취소해 주세요." });
  }
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE orders SET status='주문취소', updated_at=? WHERE id=? AND user_id=?").run(now, order.id, req.user.id);
    if (payment) db.prepare("UPDATE payments SET status='CANCELED', canceled_at=? WHERE order_id=?").run(now, order.id);
    db.prepare(`INSERT INTO order_status_history (id, order_id, previous_status, next_status, changed_by, created_at)
      VALUES (?, ?, ?, '주문취소', 'customer', ?)`)
      .run(`history-${Date.now()}-${Math.random().toString(36).slice(2)}`, order.id, order.status, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "주문 취소 중 오류가 발생했습니다." });
  }
  res.json({ ok: true, status: "주문취소" });
});

router.get("/me/address", requireCustomerAuth, (req, res) => {
  const address = db.prepare(`SELECT id, address_name, recipient_name, recipient_phone, postal_code, address, address_detail
    FROM user_addresses WHERE user_id=? AND is_default=1 ORDER BY created_at ASC LIMIT 1`).get(req.user.id);
  res.json({ address: address ? {
    id: address.id, addressName: address.address_name, recipientName: address.recipient_name,
    recipientPhone: address.recipient_phone, postalCode: address.postal_code,
    address: address.address, addressDetail: address.address_detail,
  } : null });
});

router.patch("/me/address", requireCustomerAuth, (req, res) => {
  const recipientName = String(req.body?.recipientName || "").trim();
  const recipientPhone = normalizePhone(String(req.body?.recipientPhone || ""));
  const address = String(req.body?.address || "").trim();
  const addressDetail = String(req.body?.addressDetail || "").trim();
  const postalCode = String(req.body?.postalCode || "").trim();
  if (!recipientName || recipientName.length > NAME_MAX || !isValidPhone(recipientPhone)) return res.status(400).json({ error: "수령인 정보를 확인해 주세요." });
  if (!address || address.length > ADDRESS_MAX || addressDetail.length > ADDRESS_MAX || postalCode.length > POSTAL_CODE_MAX) return res.status(400).json({ error: "배송지 정보를 확인해 주세요." });
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM user_addresses WHERE user_id=? AND is_default=1 ORDER BY created_at ASC LIMIT 1").get(req.user.id);
  if (existing) {
    db.prepare(`UPDATE user_addresses SET recipient_name=?, recipient_phone=?, postal_code=?, address=?, address_detail=?, updated_at=? WHERE id=? AND user_id=?`)
      .run(recipientName, recipientPhone, postalCode || null, address, addressDetail || null, now, existing.id, req.user.id);
  } else {
    db.prepare(`INSERT INTO user_addresses (id,user_id,address_name,recipient_name,recipient_phone,postal_code,address,address_detail,is_default,created_at,updated_at)
      VALUES (?,?, '기본 배송지',?,?,?,?,?,1,?,?)`)
      .run(`addr-${Date.now()}-${Math.random().toString(36).slice(2)}`, req.user.id, recipientName, recipientPhone, postalCode || null, address, addressDetail || null, now, now);
  }
  refreshProfileCompletion(req.user.id);
  res.json({ ok: true });
});

router.patch("/me/profile", requireCustomerAuth, (req, res) => {
  const name = String(req.body?.name || "").trim();
  const phone = normalizePhone(String(req.body?.phone || ""));
  if (!name || name.length > NAME_MAX || !isValidPhone(phone)) return res.status(400).json({ error: "회원 정보를 확인해 주세요." });
  db.prepare("UPDATE user_accounts SET name=?, phone=?, marketing_consent=?, updated_at=? WHERE id=?")
    .run(name, phone, req.body?.marketingConsent === true ? 1 : 0, new Date().toISOString(), req.user.id);
  refreshProfileCompletion(req.user.id);
  res.json({ ok: true });
});

router.post("/me/password", requireCustomerAuth, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  const bytes = Buffer.byteLength(newPassword, "utf8");
  if (newPassword.length < PASSWORD_MIN || bytes > PASSWORD_MAX) return res.status(400).json({ error: "새 비밀번호는 8자 이상 72바이트 이하로 입력해 주세요." });
  const user = db.prepare("SELECT password_hash FROM user_accounts WHERE id=?").get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(400).json({ error: "현재 비밀번호가 올바르지 않습니다." });
  db.prepare("UPDATE user_accounts SET password_hash=?, updated_at=? WHERE id=?")
    .run(bcrypt.hashSync(newPassword, 10), new Date().toISOString(), req.user.id);
  res.json({ ok: true });
});

router.get("/me/social-identities", requireCustomerAuth, (req, res) => {
  const connected = db.prepare("SELECT provider, email, created_at FROM social_identities WHERE user_id=? ORDER BY provider").all(req.user.id);
  const map = new Map(connected.map((identity) => [identity.provider, identity]));
  res.json({ providers: ["kakao", "naver", "google"].map((provider) => ({
    provider, connected: map.has(provider), email: map.get(provider)?.email || null, connectedAt: map.get(provider)?.created_at || null,
  })) });
});

router.delete("/me", requireCustomerAuth, (req, res) => {
  const password = String(req.body?.password || "");
  const user = db.prepare("SELECT password_hash FROM user_accounts WHERE id=?").get(req.user.id);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(400).json({ error: "비밀번호가 올바르지 않습니다." });
  const activeOrder = db.prepare(`SELECT id FROM orders WHERE user_id=? AND status NOT IN ('주문취소','결제취소','수령완료','배송완료') LIMIT 1`).get(req.user.id);
  if (activeOrder) return res.status(409).json({ error: "진행 중인 주문이 있어 탈퇴할 수 없습니다." });
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM social_identities WHERE user_id=?").run(req.user.id);
    db.prepare("DELETE FROM user_addresses WHERE user_id=?").run(req.user.id);
    db.prepare(`UPDATE user_accounts SET username=NULL, email=?, name='탈퇴회원', phone='', status='withdrawn', marketing_consent=0, updated_at=? WHERE id=?`)
      .run(`withdrawn-${req.user.id}@deleted.local`, now, req.user.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "회원 탈퇴 중 오류가 발생했습니다." });
  }
  clearCustomerCookie(res);
  res.json({ ok: true });
});

module.exports = router;
