const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const toss = require("../services/toss-payments");

const router = express.Router();
const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;

const token = () => crypto.randomBytes(32).toString("base64url");
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const uuid = () => crypto.randomUUID();
const expired = (value) => !value || Date.parse(value) <= Date.now();
const maskName = (name) => {
  const chars = Array.from(String(name || ""));
  if (chars.length <= 1) return chars.length ? "*" : "-";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars.at(-1)}`;
};

function paymentForSession(req) {
  const session = req.get("X-Payment-Session") || req.body?.sessionToken;
  if (!session) return null;
  const pay = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(req.body?.orderId);
  if (!pay || pay.session_token_hash !== hash(session) || expired(pay.session_token_expires_at)) return null;
  return pay;
}

function itemsFor(orderId) {
  return db.prepare("SELECT product_id, product_name, quantity FROM order_items WHERE order_id = ? ORDER BY id ASC").all(orderId);
}

function inTransaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = callback();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function completeTransaction(pay, result, now) {
  return inTransaction(() => {
    db.prepare(`UPDATE payments SET payment_key=?, status='DONE', paid_at=?, last_error=NULL, toss_secret=?, payment_method=? WHERE order_id=?`)
      .run(result.paymentKey || pay.payment_key, now, result.secret || pay.toss_secret, result.method || null, pay.order_id);
    db.prepare("UPDATE orders SET payment_status='결제완료', workflow_status='접수대기', status='접수대기', updated_at=? WHERE id=?").run(now, pay.order_id);
    db.prepare(`INSERT INTO activity_logs
      (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
      VALUES (?, '결제', ?, 'logs', 'payment_status_change', ?, ?, '결제완료', 'system', ?)`)
      .run(`activity-${uuid()}`, `${pay.order_id} 결제가 승인되었습니다.`, pay.order_id, "결제대기", now);
  });
}

function cancelTransaction(pay, now, cancelAmount = pay.amount, reason = "고객 요청") {
  return inTransaction(() => {
    const accumulated = Math.min(pay.amount, Number(pay.canceled_amount || 0) + cancelAmount);
    const isFull = accumulated >= pay.amount;
    db.prepare("UPDATE payments SET status=?, canceled_amount=?, cancel_reason=?, canceled_at=?, last_error=NULL WHERE order_id=?")
      .run(isFull ? "CANCELED" : "PARTIAL_CANCELED", accumulated, reason, now, pay.order_id);
    db.prepare("UPDATE orders SET payment_status=?, workflow_status=CASE WHEN ? THEN '취소' ELSE workflow_status END, updated_at=? WHERE id=?")
      .run(isFull ? "결제취소" : "부분환불", isFull ? 1 : 0, now, pay.order_id);
    db.prepare(`INSERT INTO activity_logs
      (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
      VALUES (?, '결제', ?, 'logs', 'payment_status_change', ?, ?, ?, '관리자', ?)`)
      .run(`activity-${uuid()}`, `${pay.order_id} ${cancelAmount.toLocaleString("ko-KR")}원이 환불되었습니다. · 사유: ${reason}`, pay.order_id, "결제완료", isFull ? "결제취소" : "부분환불", now);
  });
}

router.get("/config", (req, res) => {
  const clientKey = process.env.TOSS_CLIENT_KEY || "";
  res.json({ clientKey, ready: Boolean(clientKey) });
});

// 일회성 링크 토큰을 결제 세션으로 교환한다. 고객 연락처는 응답하지 않는다.
router.get("/info/:orderId", (req, res) => {
  const linkToken = req.query.token;
  if (!linkToken) return res.status(401).json({ error: "결제 링크 토큰이 필요합니다." });
  const pay = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(req.params.orderId);
  if (!pay) return res.status(404).json({ error: "결제 정보를 찾을 수 없습니다." });
  if (pay.link_token_hash !== hash(linkToken)) return res.status(403).json({ error: "유효하지 않은 결제 링크입니다." });
  if (pay.link_token_used_at || expired(pay.link_token_expires_at)) return res.status(410).json({ error: "만료되었거나 이미 사용한 결제 링크입니다." });

  const sessionToken = token();
  const now = new Date().toISOString();
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare("UPDATE payments SET link_token_used_at=?, session_token_hash=?, session_token_expires_at=? WHERE order_id=?")
    .run(now, hash(sessionToken), sessionExpiresAt, pay.order_id);
  res.json({
    orderId: pay.order_id,
    amount: pay.amount,
    orderName: pay.order_name,
    customerName: maskName(pay.customer_name),
    status: pay.status,
    paymentMethod: pay.payment_method || "card",
    sessionToken,
    sessionExpiresAt,
  });
});

// 관리자는 주문 ID만 전달한다. 결제 금액은 orders.total_amount가 유일한 기준이다.
router.post("/", requireAuth, (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId가 필요합니다." });
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  if (!Number.isInteger(order.total_amount) || order.total_amount <= 0) return res.status(400).json({ error: "결제 가능한 주문 금액이 없습니다." });
  const items = itemsFor(orderId);
  if (!items.length) return res.status(400).json({ error: "주문 상품이 없습니다." });

  const existing = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(orderId);
  if (existing?.status === "DONE") return res.status(409).json({ error: "이미 결제가 완료된 주문입니다." });
  if (existing?.status === "CONFIRMING") return res.status(409).json({ error: "결제 승인 처리 중입니다." });

  const linkToken = token();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const orderName = `${items[0].product_name}${items.length > 1 ? ` 외 ${items.length - 1}건` : ""}`;
  if (existing) {
    db.prepare(`UPDATE payments SET amount=?, order_name=?, customer_name=?, customer_phone=?, status='PENDING', requested_at=?,
      link_token_hash=?, link_token_expires_at=?, link_token_used_at=NULL, session_token_hash=NULL, session_token_expires_at=NULL,
      confirm_idempotency_key=NULL, last_error=NULL WHERE order_id=?`)
      .run(order.total_amount, orderName, order.customer_name, order.customer_phone, now, hash(linkToken), expiresAt, orderId);
  } else {
    db.prepare(`INSERT INTO payments (id, order_id, amount, order_name, customer_name, customer_phone, status, requested_at, link_token_hash, link_token_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`)
      .run(`pay-${uuid()}`, orderId, order.total_amount, orderName, order.customer_name, order.customer_phone, now, hash(linkToken), expiresAt);
  }
  res.status(existing ? 200 : 201).json({ orderId, amount: order.total_amount, orderName, status: "PENDING", linkToken, expiresAt });
});

router.post("/confirm", async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;
  if (!paymentKey || !orderId) return res.status(400).json({ error: "paymentKey와 orderId가 필요합니다." });
  let pay = paymentForSession(req);
  if (!pay) return res.status(401).json({ error: "유효한 결제 세션이 필요합니다." });
  if (pay.status === "DONE") return res.json({ ok: true, alreadyPaid: true, productIds: itemsFor(orderId).map((item) => item.product_id).filter(Boolean) });
  if (pay.status === "CANCELED") return res.status(409).json({ error: "취소된 결제입니다." });
  if (pay.status === "CONFIRMING") return res.status(409).json({ error: "결제 승인 처리 중입니다." });
  if (amount !== undefined && Number(amount) !== pay.amount) return res.status(400).json({ error: "결제 금액이 일치하지 않습니다." });
  if (!process.env.TOSS_SECRET_KEY && process.env.TOSS_MOCK_MODE !== "true") return res.status(503).json({ error: "결제 서비스가 설정되지 않았습니다." });

  const idempotencyKey = pay.payment_key && pay.payment_key !== paymentKey ? uuid() : (pay.confirm_idempotency_key || uuid());
  const locked = db.prepare("UPDATE payments SET status='CONFIRMING', payment_key=?, confirm_idempotency_key=? WHERE order_id=? AND status IN ('PENDING','FAILED')")
    .run(paymentKey, idempotencyKey, orderId);
  if (!locked.changes) return res.status(409).json({ error: "결제 상태가 변경되어 다시 확인해 주세요." });

  try {
    const result = await toss.confirmPayment({ paymentKey, orderId, amount: pay.amount, idempotencyKey });
    pay = { ...pay, payment_key: paymentKey, order_status: db.prepare("SELECT status FROM orders WHERE id=?").get(orderId)?.status };
    if (result.status === 200 && result.data?.orderId === orderId && Number(result.data?.totalAmount) === pay.amount) {
      completeTransaction(pay, result.data, new Date().toISOString());
      return res.json({ ok: true, productIds: itemsFor(orderId).map((item) => item.product_id).filter(Boolean) });
    }
    const message = result.data?.message || "결제 승인에 실패했습니다.";
    db.prepare("UPDATE payments SET status='FAILED', retry_count=retry_count+1, last_error=?, confirm_idempotency_key=NULL WHERE order_id=?").run(message, orderId);
    return res.status(result.status >= 400 && result.status < 600 ? result.status : 502).json({ ok: false, error: message, retryable: true });
  } catch (error) {
    db.prepare("UPDATE payments SET status='FAILED', retry_count=retry_count+1, last_error=? WHERE order_id=?").run(error.message, orderId);
    return res.status(502).json({ error: "결제사 연결에 실패했습니다.", retryable: true });
  }
});

// Toss 일반 결제 웹훅에는 서명 헤더가 없으므로, 결제 조회 API 결과로 위변조를 검증한다.
router.post("/webhook", async (req, res) => {
  const event = req.body;
  const data = event?.data || event;
  const paymentKey = data?.paymentKey;
  if (!paymentKey) return res.status(400).json({ error: "paymentKey가 필요합니다." });
  const pay = db.prepare("SELECT p.*, o.status AS order_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.payment_key=?").get(paymentKey);
  if (!pay) return res.status(404).json({ error: "결제 정보를 찾을 수 없습니다." });
  if (data.secret && pay.toss_secret && data.secret !== pay.toss_secret) return res.status(403).json({ error: "웹훅 secret이 일치하지 않습니다." });

  const verified = await toss.getPayment(paymentKey);
  if (verified.status !== 200 || verified.data?.orderId !== pay.order_id || Number(verified.data?.totalAmount) !== pay.amount) {
    return res.status(403).json({ error: "결제사 조회 결과와 일치하지 않습니다." });
  }
  const status = verified.data.status;
  if (status === "DONE" && pay.status !== "DONE") completeTransaction(pay, verified.data, new Date().toISOString());
  if (["CANCELED", "PARTIAL_CANCELED"].includes(status) && pay.status !== "CANCELED") cancelTransaction(pay, new Date().toISOString());
  res.json({ ok: true });
});

router.get("/:orderId", requireAuth, (req, res) => {
  const pay = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(req.params.orderId);
  if (!pay) return res.json({ status: "NONE" });
  res.json({ id: pay.id, orderId: pay.order_id, amount: pay.amount, orderName: pay.order_name, paymentKey: pay.payment_key,
    status: pay.status, requestedAt: pay.requested_at, paidAt: pay.paid_at, canceledAt: pay.canceled_at,
    canceledAmount: pay.canceled_amount, remainingAmount: Math.max(0, pay.amount - Number(pay.canceled_amount || 0)),
    cancelReason: pay.cancel_reason, paymentMethod: pay.payment_method,
    retryCount: pay.retry_count, lastError: pay.last_error });
});

router.post("/:orderId/cancel", requireAuth, async (req, res) => {
  const pay = db.prepare("SELECT * FROM payments WHERE order_id=?").get(req.params.orderId);
  if (!pay) return res.status(404).json({ error: "결제 정보를 찾을 수 없습니다." });
  if (pay.status === "CANCELED") return res.json({ ok: true, alreadyCanceled: true });
  if (pay.status === "CONFIRMING") return res.status(409).json({ error: "승인 처리 중인 결제는 취소할 수 없습니다." });
  const reason = String(req.body.cancelReason || "고객 요청").trim().slice(0, 200);
  const remaining = pay.amount - Number(pay.canceled_amount || 0);
  const cancelAmount = req.body.cancelAmount === undefined ? remaining : Number(req.body.cancelAmount);
  if (!Number.isInteger(cancelAmount) || cancelAmount <= 0 || cancelAmount > remaining) return res.status(400).json({ error: "환불 금액을 확인해 주세요." });
  if (["DONE", "PARTIAL_CANCELED"].includes(pay.status)) {
    const idempotencyKey = uuid();
    db.prepare("UPDATE payments SET cancel_idempotency_key=? WHERE order_id=?").run(idempotencyKey, pay.order_id);
    const result = await toss.cancelPayment({ paymentKey: pay.payment_key, cancelReason: reason, cancelAmount, idempotencyKey });
    if (result.status !== 200) return res.status(result.status || 502).json({ error: result.data?.message || "결제 취소에 실패했습니다." });
  }
  cancelTransaction(pay, new Date().toISOString(), cancelAmount, reason);
  res.json({ ok: true, canceledAmount: Number(pay.canceled_amount || 0) + cancelAmount, remainingAmount: remaining - cancelAmount });
});

module.exports = router;
