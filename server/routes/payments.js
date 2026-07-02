const express = require("express");
const https = require("https");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function tossConfirm(paymentKey, orderId, amount) {
  return new Promise((resolve, reject) => {
    const secret = process.env.TOSS_SECRET_KEY || "";
    const encoded = Buffer.from(secret + ":").toString("base64");
    const body = JSON.stringify({ paymentKey, orderId, amount });

    const opts = {
      hostname: "api.tosspayments.com",
      path: "/v1/payments/confirm",
      method: "POST",
      headers: {
        Authorization: `Basic ${encoded}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// GET /api/payments/config — 클라이언트 키 (공개, pay.html에서 사용)
router.get("/config", (req, res) => {
  const clientKey = process.env.TOSS_CLIENT_KEY || "";
  res.json({ clientKey, ready: !!clientKey });
});

// GET /api/payments/info/:orderId — 결제 페이지용 주문 정보 (공개)
router.get("/info/:orderId", (req, res) => {
  const pay = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(req.params.orderId);
  if (!pay) return res.status(404).json({ error: "결제 정보를 찾을 수 없습니다." });
  res.json({
    orderId: pay.order_id,
    amount: pay.amount,
    orderName: pay.order_name,
    customerName: pay.customer_name,
    customerPhone: pay.customer_phone,
    status: pay.status,
  });
});

// POST /api/payments — 결제 요청 생성 (관리자)
router.post("/", requireAuth, (req, res) => {
  const { orderId, amount } = req.body;
  if (!orderId || !amount) return res.status(400).json({ error: "orderId, amount 필요" });

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });

  const now = new Date().toISOString();
  const id = `pay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const orderName = [order.product, order.quantity > 1 ? `외 ${order.quantity - 1}건` : ""].filter(Boolean).join(" ").trim() || "따뜻한 떡집 주문";

  // 이미 PENDING 상태 결제가 있으면 기존 것 반환
  const existing = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'PENDING'").get(orderId);
  if (existing) {
    return res.json({ id: existing.id, orderId, amount: existing.amount, orderName: existing.order_name, status: "PENDING" });
  }

  // DONE 상태면 이미 결제 완료
  const done = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'DONE'").get(orderId);
  if (done) return res.status(409).json({ error: "이미 결제가 완료된 주문입니다." });

  db.prepare(`
    INSERT INTO payments (id, order_id, amount, order_name, customer_name, customer_phone, status, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
  `).run(id, orderId, Number(amount), orderName, order.customer ?? null, order.phone ?? null, now);

  res.status(201).json({ id, orderId, amount: Number(amount), orderName, status: "PENDING" });
});

// POST /api/payments/confirm — Toss 결제 승인 (공개, pay.html에서 호출)
router.post("/confirm", async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ error: "paymentKey, orderId, amount 필요" });
  }

  const pay = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(orderId);
  if (!pay) return res.status(404).json({ error: "결제 정보를 찾을 수 없습니다." });
  if (pay.status === "DONE") return res.json({ ok: true, alreadyPaid: true });
  if (pay.amount !== Number(amount)) {
    return res.status(400).json({ error: "결제 금액이 일치하지 않습니다." });
  }

  const tossKey = process.env.TOSS_SECRET_KEY || "";
  if (!tossKey) return res.status(503).json({ error: "결제 서비스가 설정되지 않았습니다." });

  try {
    const result = await tossConfirm(paymentKey, orderId, Number(amount));
    const now = new Date().toISOString();

    if (result.status === 200) {
      db.prepare("UPDATE payments SET payment_key=?, status='DONE', paid_at=? WHERE order_id=?")
        .run(paymentKey, now, orderId);
      db.prepare("UPDATE orders SET status='결제완료', updated_at=? WHERE id=?").run(now, orderId);
      return res.json({ ok: true, data: result.data });
    } else {
      db.prepare("UPDATE payments SET status='FAILED' WHERE order_id=?").run(orderId);
      return res.status(result.status).json({ ok: false, error: result.data });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/:orderId — 결제 상태 조회 (관리자)
router.get("/:orderId", requireAuth, (req, res) => {
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
  });
});

// DELETE /api/payments/:orderId — 결제 취소/초기화 (관리자)
router.delete("/:orderId", requireAuth, (req, res) => {
  db.prepare("DELETE FROM payments WHERE order_id = ?").run(req.params.orderId);
  res.json({ ok: true });
});

module.exports = router;
