const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { notifyOrderReceived, notifyOrderReady } = require("../services/notify");

const router = express.Router();

function rowToOrder(row) {
  return {
    id: row.id,
    customer: row.customer,
    phone: row.phone,
    product: row.product,
    priceText: row.price_text,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    revenue: row.revenue,
    cost: row.cost,
    pickupDate: row.pickup_date,
    pickupTime: row.pickup_time,
    fulfillmentType: row.fulfillment_type,
    logisticsStatus: row.logistics_status,
    deliveryAddress: row.delivery_address,
    status: row.status,
    memo: row.memo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/orders — 전체 주문 조회 (관리자)
router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
  res.json(rows.map(rowToOrder));
});

// POST /api/orders — 주문 생성 (공개: 고객 주문 접수)
router.post("/", (req, res) => {
  const now = new Date().toISOString();
  const {
    id = `order-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    customer, phone, product, priceText, quantity = 1,
    unitPrice = 0, revenue = 0, cost = 0,
    pickupDate, pickupTime, fulfillmentType = "pickup",
    logisticsStatus, deliveryAddress, status = "접수대기", memo,
  } = req.body;

  const n = (v) => (v === undefined ? null : v);
  db.prepare(`
    INSERT INTO orders (id, customer, phone, product, price_text, quantity, unit_price, revenue, cost,
      pickup_date, pickup_time, fulfillment_type, logistics_status, delivery_address, status, memo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, n(customer), n(phone), n(product), n(priceText), quantity, unitPrice, revenue, cost,
    n(pickupDate), n(pickupTime), fulfillmentType, n(logisticsStatus), n(deliveryAddress), status, n(memo), now, now);

  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  const created = rowToOrder(row);
  notifyOrderReceived(created).catch(() => null);
  res.status(201).json(created);
});

// PUT /api/orders/:id — 주문 수정 (관리자)
router.put("/:id", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });

  const fields = {
    customer: req.body.customer ?? existing.customer,
    phone: req.body.phone ?? existing.phone,
    product: req.body.product ?? existing.product,
    price_text: req.body.priceText ?? existing.price_text,
    quantity: req.body.quantity ?? existing.quantity,
    unit_price: req.body.unitPrice ?? existing.unit_price,
    revenue: req.body.revenue ?? existing.revenue,
    cost: req.body.cost ?? existing.cost,
    pickup_date: req.body.pickupDate ?? existing.pickup_date,
    pickup_time: req.body.pickupTime ?? existing.pickup_time,
    fulfillment_type: req.body.fulfillmentType ?? existing.fulfillment_type,
    logistics_status: req.body.logisticsStatus ?? existing.logistics_status,
    delivery_address: req.body.deliveryAddress ?? existing.delivery_address,
    status: req.body.status ?? existing.status,
    memo: req.body.memo ?? existing.memo,
  };

  db.prepare(`
    UPDATE orders SET customer=?, phone=?, product=?, price_text=?, quantity=?, unit_price=?, revenue=?, cost=?,
      pickup_date=?, pickup_time=?, fulfillment_type=?, logistics_status=?, delivery_address=?, status=?, memo=?, updated_at=?
    WHERE id=?
  `).run(
    fields.customer, fields.phone, fields.product, fields.price_text, fields.quantity,
    fields.unit_price, fields.revenue, fields.cost, fields.pickup_date, fields.pickup_time,
    fields.fulfillment_type, fields.logistics_status, fields.delivery_address,
    fields.status, fields.memo, now, req.params.id,
  );

  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  const updated = rowToOrder(row);
  // 이전 상태에서 준비완료로 바뀐 경우에만 알림 발송
  if (
    req.body.status === "준비완료" &&
    existing.status !== "준비완료"
  ) {
    notifyOrderReady(updated).catch(() => null);
  }
  res.json(updated);
});

// DELETE /api/orders/:id — 주문 삭제 (관리자)
router.delete("/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// DELETE /api/orders — 전체 주문 삭제 (관리자)
router.delete("/", requireAuth, (req, res) => {
  db.prepare("DELETE FROM orders").run();
  res.json({ ok: true });
});

module.exports = router;
