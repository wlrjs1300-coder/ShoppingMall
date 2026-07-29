const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
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

function getPaymentActor(req, fallback = "system") {
  if (req.admin?.id) return req.admin.id;
  if (req.user?.id) return req.user.id;
  return fallback;
}

function reconciliationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function paymentContext(orderId) {
  return db.prepare(`
    SELECT p.*, o.total_amount AS order_amount, o.payment_status AS order_payment_status,
      o.status AS order_status, o.workflow_status AS order_workflow_status
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE p.order_id = ?
  `).get(orderId);
}

function paymentKeyConflict(paymentKey, orderId) {
  if (!paymentKey) return false;
  return Boolean(db.prepare("SELECT 1 FROM payments WHERE payment_key=? AND order_id<>? LIMIT 1").get(paymentKey, orderId));
}

function writeReconciliationLog({ orderId, previousStatus, nextValue, actor, action, message, now }) {
  db.prepare(
    `INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
    VALUES (?, 'PAYMENT', ?, 'logs', ?, ?, ?, ?, ?, ?)`
  ).run(`activity-${uuid()}`, message, action, orderId, previousStatus, nextValue, actor, now);
}

function recordReconciliationFailure(pay, reason, actor, now = new Date().toISOString()) {
  try {
    writeReconciliationLog({
      orderId: pay?.order_id || null,
      previousStatus: pay?.status || "UNKNOWN",
      nextValue: reason,
      actor,
      action: "payment_reconciliation_failed",
      message: `${pay?.order_id || "unknown-order"} payment reconciliation failed: ${reason}`,
      now,
    });
  } catch {
    // 감사 로그 저장 장애가 원래 재조정 오류를 가리지 않게 한다.
  }
}

function markReconciliationRequired(pay, reason, actor, now = new Date().toISOString()) {
  if (!pay) return;
  try {
    inTransaction(() => {
      const current = db.prepare("SELECT status FROM payments WHERE order_id=?").get(pay.order_id);
      if (!current || ["DONE", "CANCELED", "PARTIAL_CANCELED"].includes(current.status)) return;
      db.prepare(
        `UPDATE payments
         SET status='RECONCILE_REQUIRED', retry_count=retry_count+1, last_error=?
         WHERE order_id=? AND status IN ('PENDING','FAILED','CONFIRMING','RECONCILE_REQUIRED')`
      ).run(reason, pay.order_id);
      writeReconciliationLog({
        orderId: pay.order_id,
        previousStatus: current.status,
        nextValue: "RECONCILE_REQUIRED",
        actor,
        action: "payment_reconciliation_required",
        message: `${pay.order_id} payment requires provider reconciliation: ${reason}`,
        now,
      });
    });
  } catch {
    // 결제 완료로 잘못 기록하지 않는 것이 우선이며 후속 관리자 재조정이 가능하도록 둔다.
  }
}

function validateVerifiedPayment(pay, result) {
  if (!pay) throw reconciliationError("PAYMENT_NOT_FOUND");
  if (!result?.paymentKey) throw reconciliationError("PAYMENT_KEY_MISSING");
  if (result.orderId !== pay.order_id) throw reconciliationError("ORDER_ID_MISMATCH");
  if (Number(result.totalAmount) !== Number(pay.amount) || Number(pay.order_amount) !== Number(pay.amount)) {
    throw reconciliationError("AMOUNT_MISMATCH");
  }
  if (pay.payment_key && pay.payment_key !== result.paymentKey) throw reconciliationError("PAYMENT_KEY_MISMATCH");
  if (paymentKeyConflict(result.paymentKey, pay.order_id)) throw reconciliationError("PAYMENT_KEY_CONFLICT");
  if (["CANCELED", "PARTIAL_CANCELED"].includes(pay.status)
    || ["결제취소", "부분환불", "환불완료"].includes(pay.order_payment_status)
    || ["취소", "주문취소"].includes(pay.order_status)
    || pay.order_workflow_status === "취소") {
    throw reconciliationError("LOCAL_PAYMENT_CANCELED");
  }
  if (["CANCELED", "PARTIAL_CANCELED"].includes(result.status)) throw reconciliationError("PROVIDER_CANCELED");
  if (result.status !== "DONE") throw reconciliationError("PROVIDER_NOT_DONE");
}

function completeTransaction(pay, result, now, actor = "system") {
  return inTransaction(() => {
    const current = paymentContext(pay.order_id);
    validateVerifiedPayment(current, result);
    if (current.status === "DONE") return { alreadyDone: true, previousStatus: "DONE" };
    if (!["CONFIRMING", "RECONCILE_REQUIRED"].includes(current.status)) throw reconciliationError("INVALID_LOCAL_STATUS");

    const updated = db.prepare(
      `UPDATE payments
       SET payment_key=?, status='DONE', paid_at=?, last_error=NULL, toss_secret=?, payment_method=?
       WHERE order_id=? AND status IN ('CONFIRMING','RECONCILE_REQUIRED')`
    ).run(result.paymentKey, result.approvedAt || now, result.secret || current.toss_secret, result.method || null, pay.order_id);
    if (updated.changes !== 1) throw reconciliationError("CONCURRENT_STATE_CHANGE");

    const orderUpdated = db.prepare(
      `UPDATE orders
       SET payment_status='결제완료',
         workflow_status=CASE WHEN workflow_status='결제대기' THEN '접수대기' ELSE workflow_status END,
         updated_at=?
       WHERE id=? AND payment_status NOT IN ('결제취소','부분환불','환불완료')`
    ).run(now, pay.order_id);
    if (orderUpdated.changes !== 1) throw reconciliationError("ORDER_STATE_CONFLICT");

    writeReconciliationLog({
      orderId: pay.order_id,
      previousStatus: current.status,
      nextValue: "DONE",
      actor,
      action: actor === "customer" ? "payment_status_change" : "payment_reconciled",
      message: actor === "customer" ? `${pay.order_id} payment completed` : `${pay.order_id} payment reconciled`,
      now,
    });
    return { alreadyDone: false, previousStatus: current.status };
  });
}

async function reconcilePayment(orderId, actor) {
  let pay = paymentContext(orderId);
  if (!pay) {
    const order = db.prepare("SELECT id FROM orders WHERE id=?").get(orderId);
    recordReconciliationFailure({ order_id: orderId, status: "UNKNOWN" }, order ? "PAYMENT_NOT_FOUND" : "ORDER_NOT_FOUND", actor);
    return { status: 404, reason: order ? "PAYMENT_NOT_FOUND" : "ORDER_NOT_FOUND" };
  }
  if (!pay.payment_key) {
    markReconciliationRequired(pay, "PAYMENT_KEY_MISSING", actor);
    return { status: 409, reason: "PAYMENT_KEY_MISSING" };
  }
  if (paymentKeyConflict(pay.payment_key, pay.order_id)) {
    markReconciliationRequired(pay, "PAYMENT_KEY_CONFLICT", actor);
    return { status: 409, reason: "PAYMENT_KEY_CONFLICT" };
  }

  let verified;
  try {
    verified = await toss.getPayment(pay.payment_key);
  } catch (error) {
    const reason = error?.code === "ETIMEDOUT" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR";
    markReconciliationRequired(pay, reason, actor);
    return { status: 502, reason };
  }
  if (verified.status !== 200) {
    const reason = verified.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_LOOKUP_FAILED";
    markReconciliationRequired(pay, reason, actor);
    return { status: 502, reason };
  }

  pay = paymentContext(orderId);
  try {
    if (["CANCELED", "PARTIAL_CANCELED"].includes(verified.data.status) && Array.isArray(verified.data.cancels)) {
      const result = cancelTransaction(
        pay,
        verified.data,
        new Date().toISOString(),
        pay.cancel_reason || "Provider cancellation reconciliation",
        actor
      );
      return {
        status: 200,
        reconciled: !result.alreadyApplied,
        alreadyDone: result.alreadyApplied,
        paymentStatus: result.isFull ? "CANCELED" : "PARTIAL_CANCELED",
        orderPaymentStatus: result.isFull ? "결제취소" : "부분환불",
      };
    }
    validateVerifiedPayment(pay, verified.data);
    const result = completeTransaction(pay, verified.data, new Date().toISOString(), actor);
    return {
      status: 200,
      reconciled: !result.alreadyDone,
      alreadyDone: result.alreadyDone,
      paymentStatus: "DONE",
      orderPaymentStatus: "결제완료",
    };
  } catch (error) {
    const validationReasons = new Set([
      "PAYMENT_NOT_FOUND", "PAYMENT_KEY_MISSING", "ORDER_ID_MISMATCH", "AMOUNT_MISMATCH",
      "PAYMENT_KEY_MISMATCH", "PAYMENT_KEY_CONFLICT", "LOCAL_PAYMENT_CANCELED",
      "PROVIDER_CANCELED", "PROVIDER_NOT_DONE", "INVALID_LOCAL_STATUS",
      "CONCURRENT_STATE_CHANGE", "ORDER_STATE_CONFLICT",
    ]);
    const reason = validationReasons.has(error.code) ? error.code : "DB_RECONCILIATION_FAILED";
    if (reason !== "INVALID_LOCAL_STATUS") markReconciliationRequired(pay, reason, actor);
    recordReconciliationFailure(pay, reason, actor);
    return { status: 409, reason };
  }
}

function providerCancellation(result, expectedPayment) {
  if (!result || !["CANCELED", "PARTIAL_CANCELED"].includes(result.status)) {
    throw reconciliationError("PROVIDER_CANCEL_STATUS_MISMATCH");
  }
  const total = Number(result.totalAmount);
  const cancels = Array.isArray(result.cancels) ? result.cancels : [];
  const canceled = cancels.reduce((sum, item) => sum + Number(item?.cancelAmount), 0);
  if (!Number.isSafeInteger(total) || total !== Number(expectedPayment.amount)
    || cancels.some((item) => !Number.isSafeInteger(Number(item?.cancelAmount)) || Number(item.cancelAmount) <= 0)
    || !Number.isSafeInteger(canceled) || canceled < 0 || canceled > total
    || (result.balanceAmount !== undefined && Number(result.balanceAmount) !== total - canceled)
    || (result.status === "CANCELED" && canceled !== total)
    || (result.status === "PARTIAL_CANCELED" && (canceled <= 0 || canceled >= total))) {
    throw reconciliationError("PROVIDER_CANCEL_AMOUNT_MISMATCH");
  }
  return { canceled, isFull: result.status === "CANCELED" };
}

function cancelTransaction(pay, providerResult, now, reason = "일반 취소", actor = "system") {
  return inTransaction(() => {
    const current = paymentContext(pay.order_id);
    const { canceled: accumulated, isFull } = providerCancellation(providerResult, current);
    const previousAmount = Number(current.canceled_amount || 0);
    if (accumulated < previousAmount) throw reconciliationError("PROVIDER_CANCEL_AMOUNT_REGRESSION");
    if (current.status === (isFull ? "CANCELED" : "PARTIAL_CANCELED") && accumulated === previousAmount) {
      return { alreadyApplied: true, canceledAmount: accumulated, isFull };
    }
    const updated = db.prepare(
      `UPDATE payments SET status=?, canceled_amount=?, cancel_reason=?, canceled_at=?,
       last_error=NULL, cancel_idempotency_key=NULL
       WHERE order_id=? AND status IN ('CANCELING','DONE','PARTIAL_CANCELED','RECONCILE_REQUIRED')`
    ).run(isFull ? "CANCELED" : "PARTIAL_CANCELED", accumulated, reason, now, pay.order_id);
    if (updated.changes !== 1) throw reconciliationError("CONCURRENT_STATE_CHANGE");

    const orderUpdated = db.prepare(
      "UPDATE orders SET payment_status=?, workflow_status=CASE WHEN ? THEN '취소' ELSE workflow_status END, updated_at=? WHERE id=?"
    ).run(isFull ? "결제취소" : "부분환불", isFull ? 1 : 0, now, pay.order_id);
    if (orderUpdated.changes !== 1) throw reconciliationError("ORDER_STATE_CONFLICT");

    db.prepare(
      `INSERT INTO activity_logs
      (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
      VALUES (?, 'PAYMENT', ?, 'logs', 'payment_status_change', ?, ?, ?, ?, ?)`
    ).run(
      `activity-${uuid()}`,
      `${pay.order_id} cancellation ${current.status}->${isFull ? "CANCELED" : "PARTIAL_CANCELED"}; `
        + `canceledAmount ${previousAmount}->${accumulated}; scope=${isFull ? "full" : "partial"}; reason=${reason}`,
      pay.order_id,
      current.order_payment_status,
      isFull ? "결제취소" : "부분환불",
      actor,
      now
    );
    return { alreadyApplied: false, canceledAmount: accumulated, isFull };
  });
}

function markCancelReconciliationRequired(orderId, reason, actor) {
  const now = new Date().toISOString();
  try {
    inTransaction(() => {
      const current = paymentContext(orderId);
      if (!current) return;
      const updated = db.prepare(
        `UPDATE payments SET status='RECONCILE_REQUIRED', last_error=?, retry_count=retry_count+1
         WHERE order_id=? AND status='CANCELING'`
      ).run(reason, orderId);
      if (updated.changes) writeReconciliationLog({
        orderId, previousStatus: current.status, nextValue: "RECONCILE_REQUIRED", actor,
        action: "payment_reconciliation_required",
        message: `${orderId} cancellation requires provider reconciliation: ${reason}`, now,
      });
    });
  } catch {
    // Preserve the provider-success ambiguity for a later provider lookup.
  }
}

router.get("/config", (req, res) => {
  const clientKey = process.env.TOSS_CLIENT_KEY || "";
  res.json({ clientKey, ready: Boolean(clientKey) });
});

// Payment link info endpoint
router.get("/info/:orderId", (req, res) => {
  const linkToken = req.query.token;
  if (!linkToken) return res.status(401).json({ error: "결제 링크 토큰이 필요합니다." });

  const pay = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(req.params.orderId);
  if (!pay) return res.status(404).json({ error: "결제 정보를 찾을 수 없습니다." });
  if (pay.link_token_hash !== hash(linkToken)) return res.status(403).json({ error: "유효하지 않은 결제 링크입니다." });
  if (pay.link_token_used_at || expired(pay.link_token_expires_at)) return res.status(410).json({ error: "이미 사용했거나 만료된 결제 링크입니다." });

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

router.post("/", requireAuth, requirePermission("payments:reconcile"), (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId가 필요합니다." });

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return res.status(404).json({ error: "주문 정보를 찾을 수 없습니다." });
  if (!Number.isInteger(order.total_amount) || order.total_amount <= 0) return res.status(400).json({ error: "주문 금액이 유효하지 않습니다." });

  const items = itemsFor(orderId);
  if (!items.length) return res.status(400).json({ error: "주문 상품이 없습니다." });

  const existing = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(orderId);
  if (existing?.status === "DONE") return res.status(409).json({ error: "이미 결제가 완료된 주문입니다." });
  if (existing?.status === "CONFIRMING") return res.status(409).json({ error: "결제 확인이 진행 중입니다." });

  const linkToken = token();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const orderName = `${items[0].product_name}${items.length > 1 ? `외 ${items.length - 1}건` : ""}`;

  if (existing) {
    db.prepare(
      `UPDATE payments SET amount=?, order_name=?, customer_name=?, customer_phone=?, status='PENDING', requested_at=?,
      link_token_hash=?, link_token_expires_at=?, link_token_used_at=NULL, session_token_hash=NULL, session_token_expires_at=NULL,
      confirm_idempotency_key=NULL, last_error=NULL WHERE order_id=?`
    ).run(order.total_amount, orderName, order.customer_name, order.customer_phone, now, hash(linkToken), expiresAt, orderId);
  } else {
    db.prepare(
      `INSERT INTO payments (id, order_id, amount, order_name, customer_name, customer_phone, status, requested_at, link_token_hash, link_token_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
    ).run(`pay-${uuid()}`, orderId, order.total_amount, orderName, order.customer_name, order.customer_phone, now, hash(linkToken), expiresAt);
  }

  res.status(existing ? 200 : 201).json({ orderId, amount: order.total_amount, orderName, status: "PENDING", linkToken, expiresAt });
});

router.post("/confirm", async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;
  if (!paymentKey || !orderId) return res.status(400).json({ error: "paymentKey 또는 orderId가 필요합니다." });

  let pay = paymentForSession(req);
  if (!pay) return res.status(401).json({ error: "결제 세션이 만료되었거나 유효하지 않습니다." });

  if (pay.status === "DONE") return res.json({ ok: true, alreadyPaid: true, productIds: itemsFor(orderId).map((item) => item.product_id).filter(Boolean) });
  if (pay.status === "CANCELED") return res.status(409).json({ error: "취소된 결제입니다." });
  if (pay.status === "CONFIRMING") return res.status(409).json({ error: "결제 확인이 진행 중입니다." });
  if (pay.status === "RECONCILE_REQUIRED") return res.status(409).json({ error: "결제사 상태 확인이 필요한 주문입니다.", reconcileRequired: true });
  if (amount !== undefined && Number(amount) !== pay.amount) return res.status(400).json({ error: "결제 금액이 일치하지 않습니다." });
  if (!process.env.TOSS_SECRET_KEY && process.env.TOSS_MOCK_MODE !== "true") return res.status(503).json({ error: "결제 키 설정이 없습니다. 환경변수를 확인해 주세요." });

  const idempotencyKey = pay.payment_key && pay.payment_key !== paymentKey ? uuid() : (pay.confirm_idempotency_key || uuid());
  const locked = db.prepare(
    "UPDATE payments SET status='CONFIRMING', payment_key=?, confirm_idempotency_key=? WHERE order_id=? AND status IN ('PENDING','FAILED')"
  ).run(paymentKey, idempotencyKey, orderId);
  if (!locked.changes) return res.status(409).json({ error: "결제 상태가 변경되어 중복 확인할 수 없습니다." });

  try {
    const result = await toss.confirmPayment({ paymentKey, orderId, amount: pay.amount, idempotencyKey });
    pay = paymentContext(orderId);

    if (result.status === 200) {
      try {
        validateVerifiedPayment(pay, result.data);
        completeTransaction(pay, result.data, new Date().toISOString(), getPaymentActor(req, "customer"));
        return res.json({ ok: true, productIds: itemsFor(orderId).map((item) => item.product_id).filter(Boolean) });
      } catch {
        markReconciliationRequired(pay, "POST_CONFIRM_RECONCILIATION_REQUIRED", getPaymentActor(req, "customer"));
        return res.status(502).json({ error: "결제 승인 결과를 최종 반영하지 못했습니다. 관리자 확인이 필요합니다.", reconcileRequired: true });
      }
    }

    if (result.status >= 500) {
      markReconciliationRequired(pay, "CONFIRM_PROVIDER_UNAVAILABLE", getPaymentActor(req, "customer"));
      return res.status(502).json({
        error: "결제 승인 결과를 확인하지 못했습니다. 관리자 확인이 필요합니다.",
        retryable: false,
        reconcileRequired: true,
      });
    }
    const message = result.data?.message || "결제 승인 중 오류가 발생했습니다.";
    db.prepare("UPDATE payments SET status='FAILED', retry_count=retry_count+1, last_error=?, confirm_idempotency_key=NULL WHERE order_id=?")
      .run(message, orderId);
    return res.status(result.status >= 400 && result.status < 600 ? result.status : 502).json({ ok: false, error: message, retryable: true });
  } catch (error) {
    pay = paymentContext(orderId) || pay;
    const reason = error?.code === "ETIMEDOUT" ? "CONFIRM_TIMEOUT" : "CONFIRM_NETWORK_ERROR";
    markReconciliationRequired(pay, reason, getPaymentActor(req, "customer"));
    return res.status(502).json({
      error: "결제 승인 결과를 확인하지 못했습니다. 재승인하지 말고 관리자 확인을 요청해 주세요.",
      retryable: false,
      reconcileRequired: true,
    });
  }
});

router.post("/webhook", async (req, res) => {
  const event = req.body;
  const data = event?.data || event;
  const paymentKey = data?.paymentKey;
  if (!paymentKey) return res.status(400).json({ error: "paymentKey가 필요합니다." });

  const pay = db.prepare("SELECT p.*, o.status AS order_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.payment_key=?").get(paymentKey);
  if (!pay) return res.status(404).json({ error: "결제 정보를 찾을 수 없습니다." });
  if (data.secret && pay.toss_secret && data.secret !== pay.toss_secret) return res.status(403).json({ error: "요청 secret이 일치하지 않습니다." });

  let verified;
  try {
    verified = await toss.getPayment(paymentKey);
  } catch {
    markReconciliationRequired(pay, "WEBHOOK_PROVIDER_LOOKUP_FAILED", getPaymentActor(req, "toss-webhook"));
    return res.status(502).json({ error: "결제사 상태 조회에 실패했습니다." });
  }
  if (verified.status !== 200) {
    markReconciliationRequired(pay, verified.status >= 500 ? "WEBHOOK_PROVIDER_UNAVAILABLE" : "WEBHOOK_PROVIDER_LOOKUP_FAILED", getPaymentActor(req, "toss-webhook"));
    return res.status(502).json({ error: "결제사 상태 조회에 실패했습니다." });
  }
  if (verified.data?.orderId !== pay.order_id || Number(verified.data?.totalAmount) !== pay.amount) {
    markReconciliationRequired(pay, "WEBHOOK_PROVIDER_MISMATCH", getPaymentActor(req, "toss-webhook"));
    return res.status(403).json({ error: "결제 조회 결과가 주문 정보와 일치하지 않습니다." });
  }

  const status = verified.data.status;
  if (status === "DONE" && pay.status !== "DONE") {
    if (!["CONFIRMING", "RECONCILE_REQUIRED"].includes(pay.status)) {
      markReconciliationRequired(pay, "WEBHOOK_UNEXPECTED_LOCAL_STATUS", getPaymentActor(req, "toss-webhook"));
    } else {
      try {
        completeTransaction(paymentContext(pay.order_id), verified.data, new Date().toISOString(), getPaymentActor(req, "toss-webhook"));
      } catch {
        markReconciliationRequired(pay, "WEBHOOK_DB_RECONCILIATION_FAILED", getPaymentActor(req, "toss-webhook"));
        return res.status(500).json({ error: "결제 상태 반영에 실패했습니다." });
      }
    }
  } else if (["CANCELED", "PARTIAL_CANCELED"].includes(status)) {
    try {
      cancelTransaction(pay, verified.data, new Date().toISOString(), "Payment was canceled by Toss webhook", getPaymentActor(req, "toss-webhook"));
    } catch {
      markCancelReconciliationRequired(pay.order_id, "WEBHOOK_CANCEL_RECONCILIATION_FAILED", getPaymentActor(req, "toss-webhook"));
      return res.status(500).json({ error: "결제 취소 상태 반영에 실패했습니다." });
    }
  }

  return res.sendStatus(200);
});

router.post("/:orderId/reconcile", requireAuth, requirePermission("payments:reconcile"), async (req, res) => {
  const result = await reconcilePayment(req.params.orderId, getPaymentActor(req, "admin"));
  if (result.status !== 200) {
    return res.status(result.status).json({ reconciled: false, reason: result.reason });
  }
  return res.json({
    reconciled: result.reconciled,
    alreadyDone: result.alreadyDone,
    orderId: req.params.orderId,
    paymentStatus: result.paymentStatus,
    orderPaymentStatus: result.orderPaymentStatus,
  });
});

router.get("/:orderId", requireAuth, requirePermission("payments:read"), (req, res) => {
  const pay = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(req.params.orderId);
  if (!pay) return res.json({ status: "NONE" });

  res.json({
    id: pay.id,
    orderId: pay.order_id,
    amount: pay.amount,
    orderName: pay.order_name,
    paymentKey: pay.payment_key,
    status: pay.status,
    requestedAt: pay.requested_at,
    paidAt: pay.paid_at,
    canceledAt: pay.canceled_at,
    canceledAmount: pay.canceled_amount,
    remainingAmount: Math.max(0, pay.amount - Number(pay.canceled_amount || 0)),
    cancelReason: pay.cancel_reason,
    paymentMethod: pay.payment_method,
    retryCount: pay.retry_count,
    lastError: pay.last_error,
  });
});

router.post("/:orderId/cancel", requireAuth, requirePermission("payments:cancel"), async (req, res) => {
  let pay = db.prepare("SELECT * FROM payments WHERE order_id=?").get(req.params.orderId);
  if (!pay) return res.status(404).json({ error: "결제 정보를 찾을 수 없습니다." });
  if (pay.status === "CANCELED") return res.json({ ok: true, alreadyCanceled: true });
  if (["CONFIRMING", "RECONCILE_REQUIRED", "CANCELING"].includes(pay.status)) {
    return res.status(409).json({ error: "현재 결제 상태에서는 취소할 수 없습니다." });
  }

  const reason = String(req.body.cancelReason || "관리자 요청").trim().slice(0, 200);
  const remaining = pay.amount - Number(pay.canceled_amount || 0);
  const cancelAmount = req.body.cancelAmount === undefined ? remaining : Number(req.body.cancelAmount);
  if (!Number.isInteger(cancelAmount) || cancelAmount <= 0 || cancelAmount > remaining) return res.status(400).json({ error: "취소 금액이 올바르지 않습니다." });

  if (["DONE", "PARTIAL_CANCELED"].includes(pay.status)) {
    const previousStatus = pay.status;
    const idempotencyKey = pay.cancel_idempotency_key || uuid();
    const locked = db.prepare(
      `UPDATE payments SET status='CANCELING', cancel_idempotency_key=?, last_error=NULL
       WHERE order_id=? AND status IN ('DONE','PARTIAL_CANCELED')`
    ).run(idempotencyKey, pay.order_id);
    if (locked.changes !== 1) return res.status(409).json({ error: "다른 취소 요청이 처리 중입니다." });
    let result;
    try {
      result = await toss.cancelPayment({ paymentKey: pay.payment_key, cancelReason: reason, cancelAmount, idempotencyKey });
    } catch (error) {
      const failure = error?.code === "ETIMEDOUT" ? "CANCEL_TIMEOUT" : "CANCEL_NETWORK_ERROR";
      markCancelReconciliationRequired(pay.order_id, failure, getPaymentActor(req, "admin"));
      return res.status(502).json({ error: "결제 취소 결과를 확인하지 못했습니다.", reconcileRequired: true });
    }
    if (result.status !== 200) {
      if (result.status >= 500) {
        markCancelReconciliationRequired(pay.order_id, "CANCEL_PROVIDER_UNAVAILABLE", getPaymentActor(req, "admin"));
        return res.status(502).json({ error: "결제 취소 결과를 확인하지 못했습니다.", reconcileRequired: true });
      }
      db.prepare(
        `UPDATE payments SET status=?, last_error=?, cancel_idempotency_key=NULL
         WHERE order_id=? AND status='CANCELING'`
      ).run(previousStatus, "CANCEL_PROVIDER_REJECTED", pay.order_id);
      return res.status(result.status || 502).json({ error: result.data?.message || "결제 취소 요청이 실패했습니다." });
    }
    pay = paymentContext(pay.order_id);
    try {
      const applied = cancelTransaction(pay, result.data, new Date().toISOString(), reason, getPaymentActor(req, "admin"));
      return res.json({
        ok: true,
        canceledAmount: applied.canceledAmount,
        remainingAmount: pay.amount - applied.canceledAmount,
      });
    } catch {
      markCancelReconciliationRequired(pay.order_id, "CANCEL_POST_PROVIDER_RECONCILIATION_REQUIRED", getPaymentActor(req, "admin"));
      return res.status(502).json({ error: "취소 결과를 최종 반영하지 못했습니다.", reconcileRequired: true });
    }
  }
  return res.status(409).json({ error: "현재 결제 상태에서는 취소할 수 없습니다." });
});

module.exports = router;
