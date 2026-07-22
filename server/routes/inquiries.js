const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { optionalCustomerAuth, requireCustomerAuth } = require("../middleware/customerAuth");
const { normalizePhone, isValidPhone } = require("../utils/normalize");

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, skip: () => process.env.NODE_ENV === "test" });

function inquiryPhotos(row) {
  let photos = [];
  try {
    const parsed = JSON.parse(row.photos_json || "[]");
    if (Array.isArray(parsed)) photos = parsed.slice(0, 3);
  } catch {}
  return photos;
}

function validInquiryPhoto(photo) {
  if (typeof photo !== "string" || photo.length > 2_000_000) return false;
  if (/^data:image\/(?:jpeg|png|webp);base64,/.test(photo)) return true;
  return /^assets\/products\/[A-Za-z0-9._/-]+$/.test(photo) && !photo.includes("..");
}

function publicInquiry(row) {
  const photos = inquiryPhotos(row);
  return {
    id: row.id, productName: row.product_name, customerName: row.customer_name,
    quantity: row.quantity, desiredDate: row.desired_date, message: row.message,
    status: row.status, adminReply: row.admin_reply, createdAt: row.created_at,
    respondedAt: row.responded_at, readAt: row.customer_read_at, photos,
  };
}

function claimMemberInquiries(userId) {
  const user = db.prepare("SELECT phone FROM user_accounts WHERE id = ?").get(userId);
  if (user?.phone) db.prepare("UPDATE product_inquiries SET user_id = ? WHERE user_id IS NULL AND customer_phone = ?").run(userId, normalizePhone(user.phone));
}

router.post("/", limiter, optionalCustomerAuth, (req, res) => {
  const productId = typeof req.body?.productId === "string" ? req.body.productId.trim() : "";
  const customer = typeof req.body?.customer === "string" ? req.body.customer.trim() : "";
  const phone = normalizePhone(typeof req.body?.phone === "string" ? req.body.phone : "");
  const quantity = Number(req.body?.quantity);
  const desiredDate = typeof req.body?.desiredDate === "string" ? req.body.desiredDate.trim() : "";
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const agreedPrivacy = req.body?.agreePrivacy === true || req.body?.agreePrivacy === "on";
  const photos = Array.isArray(req.body?.photos) ? req.body.photos.slice(0, 3) : [];

  if (!customer || customer.length > 50) return res.status(400).json({ error: "이름을 확인해 주세요." });
  if (!isValidPhone(phone)) return res.status(400).json({ error: "연락처를 확인해 주세요." });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) return res.status(400).json({ error: "예상 수량을 확인해 주세요." });
  if (desiredDate && !/^\d{4}-\d{2}-\d{2}$/.test(desiredDate)) return res.status(400).json({ error: "희망 날짜를 확인해 주세요." });
  if (!message || message.length > 1000) return res.status(400).json({ error: "문의 내용을 확인해 주세요." });
  if (!agreedPrivacy) return res.status(400).json({ error: "개인정보 처리방침에 동의해 주세요." });
  if (photos.some((photo) => !validInquiryPhoto(photo))) {
    return res.status(400).json({ error: "첨부 사진 형식이나 용량을 확인해 주세요." });
  }
  if (photos.reduce((total, photo) => total + photo.length, 0) > 4_500_000) return res.status(400).json({ error: "첨부 사진의 전체 용량이 너무 큽니다." });

  const product = db.prepare("SELECT id, name FROM products WHERE id = ? AND status = 'active'").get(productId);
  if (!product) return res.status(404).json({ error: "문의할 상품을 찾지 못했습니다." });

  const id = `inquiry-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO product_inquiries (id, product_id, product_name, customer_name, customer_phone, quantity, desired_date, message, photos_json, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, product.id, product.name, customer, phone, quantity, desiredDate || null, message, JSON.stringify(photos), req.user?.id || null, new Date().toISOString());
  res.status(201).json({ id, ok: true });
});

router.get("/mine", requireCustomerAuth, (req, res) => {
  claimMemberInquiries(req.user.id);
  const rows = db.prepare("SELECT * FROM product_inquiries WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json({ inquiries: rows.map(publicInquiry) });
});

router.get("/mine/unread", requireCustomerAuth, (req, res) => {
  claimMemberInquiries(req.user.id);
  const row = db.prepare("SELECT COUNT(*) AS count FROM product_inquiries WHERE user_id = ? AND status = '답변완료' AND admin_reply IS NOT NULL AND customer_read_at IS NULL").get(req.user.id);
  res.json({ count: Number(row?.count || 0) });
});

router.post("/mine/read", requireCustomerAuth, (req, res) => {
  claimMemberInquiries(req.user.id);
  const now = new Date().toISOString();
  const result = db.prepare("UPDATE product_inquiries SET customer_read_at = ? WHERE user_id = ? AND status = '답변완료' AND admin_reply IS NOT NULL AND customer_read_at IS NULL").run(now, req.user.id);
  res.json({ ok: true, updated: Number(result.changes || 0) });
});

router.patch("/mine/:id", requireCustomerAuth, (req, res) => {
  const inquiry = db.prepare("SELECT * FROM product_inquiries WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!inquiry) return res.status(404).json({ error: "문의 내역을 찾을 수 없습니다." });
  if (inquiry.status !== "접수" || inquiry.admin_reply) return res.status(409).json({ error: "답변이 시작된 문의는 수정할 수 없습니다." });

  const quantity = Number(req.body?.quantity);
  const desiredDate = typeof req.body?.desiredDate === "string" ? req.body.desiredDate.trim() : "";
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const photos = Array.isArray(req.body?.photos) ? req.body.photos.slice(0, 3) : inquiryPhotos(inquiry);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) return res.status(400).json({ error: "예상 수량을 확인해 주세요." });
  if (desiredDate && !/^\d{4}-\d{2}-\d{2}$/.test(desiredDate)) return res.status(400).json({ error: "희망 날짜를 확인해 주세요." });
  if (!message || message.length > 1000) return res.status(400).json({ error: "문의 내용은 1,000자 이내로 입력해 주세요." });
  if (photos.some((photo) => !validInquiryPhoto(photo)) || photos.reduce((total, photo) => total + photo.length, 0) > 4_500_000) {
    return res.status(400).json({ error: "첨부 사진 형식이나 용량을 확인해 주세요." });
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE product_inquiries SET quantity = ?, desired_date = ?, message = ?, photos_json = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(quantity, desiredDate || null, message, JSON.stringify(photos), now, inquiry.id, req.user.id);
  const updated = db.prepare("SELECT * FROM product_inquiries WHERE id = ?").get(inquiry.id);
  res.json({ inquiry: publicInquiry(updated) });
});

router.delete("/mine/:id", requireCustomerAuth, (req, res) => {
  const result = db.prepare("DELETE FROM product_inquiries WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: "문의 내역을 찾을 수 없습니다." });
  res.json({ ok: true });
});

router.post("/guest/lookup", limiter, (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const phone = normalizePhone(typeof req.body?.phone === "string" ? req.body.phone : "");
  if (!id || !isValidPhone(phone)) return res.status(400).json({ error: "접수번호와 연락처를 확인해 주세요." });
  const row = db.prepare("SELECT * FROM product_inquiries WHERE id = ? AND customer_phone = ? AND user_id IS NULL").get(id, phone);
  if (!row) return res.status(404).json({ error: "일치하는 비회원 문의를 찾지 못했습니다." });
  res.json({ inquiry: publicInquiry(row) });
});

router.get("/product/:productId", (req, res) => {
  const product = db.prepare("SELECT id FROM products WHERE id = ? AND status = 'active'").get(req.params.productId);
  if (!product) return res.status(404).json({ error: "상품을 찾을 수 없습니다." });
  const inquiries = db.prepare(`SELECT id, customer_name, message, status, admin_reply, created_at, responded_at
    FROM product_inquiries WHERE product_id = ? ORDER BY created_at DESC LIMIT 30`).all(product.id).map((row) => {
    const name = String(row.customer_name || "고객");
    return {
      id: row.id,
      customerName: name.length > 1 ? `${name[0]}${"*".repeat(Math.min(2, name.length - 1))}` : `${name}*`,
      message: row.message,
      status: row.status,
      adminReply: row.admin_reply || "",
      createdAt: row.created_at,
      respondedAt: row.responded_at,
    };
  });
  res.json({ inquiries });
});

router.get("/", requireAuth, (req, res) => {
  const inquiries = db.prepare("SELECT * FROM product_inquiries ORDER BY created_at DESC").all()
    .map((row) => ({ ...row, photos: inquiryPhotos(row) }));
  res.json({ inquiries });
});

router.patch("/:id", requireAuth, (req, res) => {
  const inquiry = db.prepare("SELECT * FROM product_inquiries WHERE id = ?").get(req.params.id);
  if (!inquiry) return res.status(404).json({ error: "문의 내역을 찾을 수 없습니다." });

  const allowedStatuses = new Set(["접수", "답변완료"]);
  const status = typeof req.body?.status === "string" ? req.body.status.trim() : inquiry.status;
  const adminReply = typeof req.body?.adminReply === "string" ? req.body.adminReply.trim() : (inquiry.admin_reply || "");
  const adminMemo = typeof req.body?.adminMemo === "string" ? req.body.adminMemo.trim() : (inquiry.admin_memo || "");
  if (!allowedStatuses.has(status)) return res.status(400).json({ error: "올바른 문의 상태를 선택해 주세요." });
  if (adminReply.length > 2000) return res.status(400).json({ error: "답변은 2,000자 이내로 입력해 주세요." });
  if (adminMemo.length > 500) return res.status(400).json({ error: "관리 메모는 500자 이내로 입력해 주세요." });
  if (status === "답변완료" && !adminReply) return res.status(400).json({ error: "답변 완료 전 답변 내용을 입력해 주세요." });

  const now = new Date().toISOString();
  const respondedAt = status === "답변완료" ? (inquiry.responded_at || now) : null;
  db.prepare(`UPDATE product_inquiries
    SET status = ?, admin_reply = ?, admin_memo = ?, responded_at = ?, updated_at = ?, customer_read_at = NULL
    WHERE id = ?`).run(status, adminReply || null, adminMemo || null, respondedAt, now, inquiry.id);
  const updated = db.prepare("SELECT * FROM product_inquiries WHERE id = ?").get(inquiry.id);
  res.json({ inquiry: { ...updated, photos: inquiryPhotos(updated) } });
});

module.exports = router;
