const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { optionalCustomerAuth } = require("../middleware/customerAuth");
const { notifyOrderReceived, notifyOrderReady } = require("../services/notify");
const { normalizePhone, isValidPhone } = require("../utils/normalize");

const router = express.Router();
const ORDER_STATUS = "접수대기";
const ORDER_STATUSES = new Set(["접수대기", "준비중", "준비완료", "픽업완료", "배송중", "배송완료", "취소", "주문취소"]);
const PAYMENT_STATUSES = new Set(["결제대기", "결제완료", "부분환불", "결제취소", "환불완료"]);
const WORKFLOW_STATUSES = new Set(["결제대기", "접수대기", "접수완료", "배송중", "배송완료", "픽업준비완료", "픽업완료", "취소"]);
const PRODUCTION_STATUSES = new Set(["생산 대기", "생산 중", "생산 완료"]);
function getWorkflowTransitions(status, fulfillmentType) {
  if (status === "취소") return [];
  const sequence = fulfillmentType === "delivery"
    ? ["결제대기", "접수대기", "접수완료", "배송중", "배송완료"]
    : ["결제대기", "접수대기", "접수완료", "픽업준비완료", "픽업완료"];
  const currentIndex = sequence.indexOf(status);
  if (currentIndex < 0 || currentIndex === sequence.length - 1) return [];
  return [...sequence.slice(currentIndex + 1), "취소"];
}
const STATUS_TRANSITIONS = {
  접수대기: ["준비중", "취소"], 준비중: ["준비완료", "픽업완료", "배송완료", "취소"],
  준비완료: ["픽업완료", "배송중", "배송완료", "취소"], 배송중: ["배송완료", "취소"],
  픽업완료: [], 배송완료: [], 취소: [], 주문취소: [],
};
const MAX_QUANTITY = 99;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function getActorLabel(req) {
  if (!req?.admin) return "admin";
  if (req.admin.id) return req.admin.id;
  return req.admin.role ? `${req.admin.role}:admin` : "admin";
}

function makeChangeMeta(req) {
  return {
    actor: getActorLabel(req),
    adminRole: req.admin?.role || "admin",
  };
}

const publicOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { error: "주문 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

function isValidPickupDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return false;
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return value >= today;
}

function validateCustomerFields(body) {
  const customer = typeof body?.customer === "string" ? body.customer.trim() : "";
  const phone = normalizePhone(typeof body?.phone === "string" ? body.phone : "");
  const fulfillmentType = body?.fulfillmentType === "delivery" ? "delivery" : body?.fulfillmentType === "pickup" ? "pickup" : "";
  const deliveryAddress = typeof body?.deliveryAddress === "string" ? body.deliveryAddress.trim() : "";
  const pickupDate = typeof body?.pickupDate === "string" ? body.pickupDate.trim() : "";
  const pickupTime = typeof body?.pickupTime === "string" ? body.pickupTime.trim() : "";
  const memo = typeof body?.memo === "string" ? body.memo.trim() : "";
  const paymentMethod = ["card", "transfer", "onsite"].includes(body?.paymentMethod) ? body.paymentMethod : "onsite";
  if (!customer || customer.length > 50) return { error: "주문자 이름을 확인해 주세요." };
  if (!isValidPhone(phone)) return { error: "연락처 형식이 올바르지 않습니다." };
  if (!fulfillmentType) return { error: "수령 방식을 확인해 주세요." };
  if (!isValidPickupDate(pickupDate)) return { error: "희망 날짜를 확인해 주세요." };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime)) return { error: "희망 시간을 확인해 주세요." };
  if (fulfillmentType === "delivery" && (!deliveryAddress || deliveryAddress.length > 200)) return { error: "배송 주소를 확인해 주세요." };
  if (deliveryAddress.length > 200) return { error: "배송 주소는 200자 이하로 입력해 주세요." };
  if (memo.length > 500) return { error: "요청사항은 500자 이하로 입력해 주세요." };
  return { data: { customer, phone, fulfillmentType, deliveryAddress, pickupDate, pickupTime, memo, paymentMethod } };
}

function createCheckoutPayment(order, paymentMethod, now) {
  if (paymentMethod === "onsite") return null;
  const linkToken = crypto.randomBytes(32).toString("base64url");
  const linkHash = crypto.createHash("sha256").update(linkToken).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const orderName = `${order.items[0]?.productName || "주문 상품"}${order.items.length > 1 ? ` 외 ${order.items.length - 1}건` : ""}`;
  db.prepare(`INSERT INTO payments
    (id, order_id, amount, order_name, customer_name, customer_phone, status, requested_at, link_token_hash, link_token_expires_at, payment_method)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`)
    .run(`pay-${crypto.randomUUID()}`, order.id, order.totalAmount, orderName, order.customer, order.phone, now, linkHash, expiresAt, paymentMethod);
  return `pay.html?orderId=${encodeURIComponent(order.id)}&token=${encodeURIComponent(linkToken)}`;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) return { error: "주문 상품은 1개 이상 30개 이하로 선택해 주세요." };
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const productId = typeof item?.productId === "string" ? item.productId.trim() : "";
    const quantity = Number(item?.quantity);
    if (!productId || productId.length > 100) return { error: "상품을 선택해 주세요." };
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return { error: `수량은 1개 이상 ${MAX_QUANTITY}개 이하로 입력해 주세요.` };
    if (seen.has(productId)) return { error: "같은 상품이 중복되어 있습니다." };
    seen.add(productId);
    normalized.push({ productId, quantity });
  }
  return { data: normalized };
}

function getOrderItems(orderId) {
  return db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC").all(orderId).map((item) => ({
    id: item.id,
    productId: item.product_id,
    productName: item.product_name,
    unitPrice: item.unit_price,
    quantity: item.quantity,
    lineTotal: item.line_total,
  }));
}

function rowToOrder(row) {
  const items = getOrderItems(row.id);
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const first = items[0];
  const productSummary = first ? `${first.productName}${items.length > 1 ? ` 외 ${items.length - 1}건` : ""}` : "상품 없음";
  return {
    id: row.id,
    checkoutId: row.id,
    userId: row.user_id,
    customer: row.customer_name,
    phone: row.customer_phone,
    product: productSummary,
    productId: items.length === 1 ? first.productId : null,
    priceText: `${Number(row.total_amount).toLocaleString("ko-KR")}원`,
    quantity: totalQuantity,
    unitPrice: items.length === 1 ? first.unitPrice : 0,
    revenue: row.total_amount,
    cost: row.cost,
    pickupDate: row.pickup_date,
    pickupTime: row.pickup_time,
    fulfillmentType: row.fulfillment_type,
    logisticsStatus: row.logistics_status,
    deliveryAddress: row.delivery_address,
    status: row.status,
    paymentStatus: row.payment_status,
    amountStatus: row.amount_status,
    workflowStatus: row.workflow_status,
    productionStatus: row.production_status,
    productionAssignee: row.production_assignee,
    packagingType: row.packaging_type,
    memo: row.memo,
    subtotal: row.subtotal,
    deliveryFee: row.delivery_fee,
    totalAmount: row.total_amount,
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getOrder(orderId) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  return row ? rowToOrder(row) : null;
}

function normalizeProductionProductName(value) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

function getProductionRecipe(productName) {
  const rows = db.prepare("SELECT product, ingredient, amount, unit FROM recipes ORDER BY length(product) DESC").all();
  const matchingProduct = rows.find((row) => productName.includes(row.product))?.product;
  return matchingProduct ? rows.filter((row) => row.product === matchingProduct) : [];
}

function insertHeader(fields) {
  db.prepare(`
    INSERT INTO orders
      (id, user_id, customer_name, customer_phone, fulfillment_type, delivery_address, pickup_date, pickup_time,
       subtotal, delivery_fee, total_amount, cost, status, payment_status, amount_status, workflow_status, logistics_status, memo, created_at, updated_at,
       guest_password_hash, guest_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.id, fields.userId || null, fields.customer, fields.phone, fields.fulfillmentType,
    fields.deliveryAddress || null, fields.pickupDate || null, fields.pickupTime || null,
    fields.subtotal, fields.deliveryFee || 0, fields.totalAmount, fields.cost || 0,
    fields.status || ORDER_STATUS, fields.paymentStatus || "결제대기", fields.amountStatus || "confirmed",
    fields.workflowStatus || "결제대기", fields.logisticsStatus || null, fields.memo || null, fields.createdAt, fields.createdAt,
    fields.guestPasswordHash || null, fields.guestAddress || null,
  );
}

function insertItem(orderId, item, index) {
  db.prepare(`
    INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, line_total)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`item-${orderId}-${index + 1}`, orderId, item.productId || null, item.productName, item.unitPrice, item.quantity, item.lineTotal);
}

function addStatusHistory(orderId, previousStatus, nextStatus, changedBy = "system", createdAt = new Date().toISOString(), reason = null) {
  db.prepare(`INSERT INTO order_status_history (id, order_id, previous_status, next_status, changed_by, created_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`history-${crypto.randomUUID()}`, orderId, previousStatus || null, nextStatus, changedBy, createdAt, reason);
}

function addAuditLog({ category, message, action, entityId, previousValue, nextValue, actor = "관리자", createdAt }) {
  db.prepare(`INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
    VALUES (?, ?, ?, 'logs', ?, ?, ?, ?, ?, ?)`)
    .run(`activity-${crypto.randomUUID()}`, category, message, action, entityId, previousValue, nextValue, actor, createdAt);
}

function createOrder({ id, userId, customerData, products, requestedItems, memo, createdAt, guestData = null }) {
  const items = requestedItems.map((requested, index) => {
    const product = products[index];
    const unitPrice = Number(product.price);
    return { productId: product.id, productName: product.name, unitPrice, quantity: requested.quantity, lineTotal: unitPrice * requested.quantity };
  });
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  insertHeader({
    id, userId, customer: customerData.customer, phone: customerData.phone,
    fulfillmentType: customerData.fulfillmentType,
    deliveryAddress: customerData.fulfillmentType === "delivery" ? customerData.deliveryAddress : null,
    pickupDate: customerData.pickupDate, pickupTime: customerData.pickupTime,
    subtotal, deliveryFee: 0, totalAmount: subtotal, cost: 0, status: ORDER_STATUS,
    logisticsStatus: customerData.fulfillmentType === "delivery" ? "배송대기" : "픽업대기",
    memo: memo || null, createdAt,
    guestPasswordHash: guestData?.passwordHash,
    guestAddress: guestData?.address,
  });
  items.forEach((item, index) => insertItem(id, item, index));
  addStatusHistory(id, null, ORDER_STATUS, "customer", createdAt);
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all().map(rowToOrder));
});

router.get("/:id/history", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  const rows = db.prepare("SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at DESC").all(req.params.id);
  res.json(rows.map((row) => ({
    id: row.id, previousStatus: row.previous_status, nextStatus: row.next_status,
    changedBy: row.changed_by, reason: row.reason, createdAt: row.created_at,
  })));
});

router.post("/", publicOrderLimiter, optionalCustomerAuth, (req, res) => {
  const customer = validateCustomerFields(req.body);
  const items = normalizeItems([{ productId: req.body?.productId, quantity: req.body?.quantity }]);
  if (customer.error || items.error) return res.status(400).json({ error: customer.error || items.error });
  const product = db.prepare("SELECT id, name, price FROM products WHERE id = ? AND status = 'active'").get(items.data[0].productId);
  if (!product || product.price === null) return res.status(404).json({ error: "주문 가능한 상품을 찾을 수 없습니다." });
  const key = req.get("Idempotency-Key");
  if (key && !IDEMPOTENCY_KEY_RE.test(key)) return res.status(400).json({ error: "중복 방지 키 형식이 올바르지 않습니다." });
  const hash = crypto.createHash("sha256").update(JSON.stringify({ ...customer.data, items: items.data, userId: req.user?.id || null })).digest("hex");
  if (key) {
    const previous = db.prepare("SELECT request_hash, order_id FROM order_idempotency WHERE idempotency_key = ?").get(key);
    if (previous) {
      if (previous.request_hash !== hash) return res.status(409).json({ error: "같은 중복 방지 키로 다른 주문을 요청할 수 없습니다." });
      return res.status(200).set("Idempotency-Replayed", "true").json(getOrder(previous.order_id));
    }
  }
  const id = `order-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    createOrder({ id, userId: req.user?.id, customerData: customer.data, products: [product], requestedItems: items.data, memo: customer.data.memo, createdAt: now });
    if (key) db.prepare("INSERT INTO order_idempotency VALUES (?, ?, ?, ?)").run(key, hash, id, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("[orders] 주문 생성 실패:", error);
    return res.status(500).json({ error: "주문 접수 중 오류가 발생했습니다." });
  }
  const order = getOrder(id);
  notifyOrderReceived(order).catch(() => null);
  res.status(201).json(order);
});

router.post("/checkout", publicOrderLimiter, optionalCustomerAuth, (req, res) => {
  const customer = validateCustomerFields(req.body);
  const items = normalizeItems(req.body?.items);
  if (customer.error || items.error) return res.status(400).json({ error: customer.error || items.error });
  if (!customer.data.paymentMethod) return res.status(400).json({ error: "결제 방법을 선택해 주세요." });
  const key = req.get("Idempotency-Key");
  if (!key || !IDEMPOTENCY_KEY_RE.test(key)) return res.status(400).json({ error: "주문 중복 방지 키가 필요합니다." });
  const canonical = { ...customer.data, items: items.data, userId: req.user?.id || null };
  if (!req.user && req.body?.guestPassword) {
    canonical.guestAccess = {
      address: String(req.body.guestAddress || "").trim(),
      passwordDigest: crypto.createHash("sha256").update(String(req.body.guestPassword)).digest("hex"),
    };
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  const previous = db.prepare("SELECT request_hash, checkout_id FROM checkout_idempotency WHERE idempotency_key = ?").get(key);
  if (previous) {
    if (previous.request_hash !== hash) return res.status(409).json({ error: "같은 중복 방지 키로 다른 주문을 요청할 수 없습니다." });
    const order = getOrder(previous.checkout_id);
    return res.status(200).set("Idempotency-Replayed", "true").json({ checkoutId: order.id, order, orders: [order], totalQuantity: order.quantity, totalAmount: order.totalAmount });
  }
  let guestData = null;
  if (!req.user && req.body?.guestPassword) {
    const password = String(req.body.guestPassword);
    const address = typeof req.body.guestAddress === "string" ? req.body.guestAddress.trim() : "";
    if (Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72) return res.status(400).json({ error: "비회원 주문 비밀번호를 확인해 주세요." });
    if (!address || address.length > 200) return res.status(400).json({ error: "비회원 주문 주소를 확인해 주세요." });
    const verification = db.prepare("SELECT id FROM phone_verifications WHERE phone = ? AND verified_at IS NOT NULL AND consumed_at IS NULL ORDER BY verified_at DESC LIMIT 1").get(customer.data.phone);
    if (!verification) return res.status(400).json({ error: "휴대폰 인증을 완료해 주세요." });
    guestData = { verificationId: verification.id, passwordHash: bcrypt.hashSync(password, 10), address };
  }
  const productQuery = db.prepare("SELECT id, name, price FROM products WHERE id = ? AND status = 'active' AND purchase_type = 'direct'");
  const products = items.data.map((item) => productQuery.get(item.productId));
  if (products.some((product) => !product)) return res.status(409).json({ error: "판매가 종료되었거나 장바구니로 주문할 수 없는 상품이 포함되어 있습니다." });
  const id = `checkout-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    createOrder({ id, userId: req.user?.id, customerData: customer.data, products, requestedItems: items.data, memo: customer.data.memo, createdAt: now, guestData });
    db.prepare("INSERT INTO checkout_idempotency VALUES (?, ?, ?, ?)").run(key, hash, id, now);
    if (guestData?.verificationId) db.prepare("UPDATE phone_verifications SET consumed_at = ? WHERE id = ?").run(now, guestData.verificationId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("[orders.checkout] 주문 생성 실패:", error);
    return res.status(500).json({ error: "주문 접수 중 오류가 발생했습니다." });
  }
  const order = getOrder(id);
  const paymentUrl = createCheckoutPayment(order, customer.data.paymentMethod, now);
  notifyOrderReceived(order).catch(() => null);
  res.status(201).json({ checkoutId: id, order, orders: [order], totalQuantity: order.quantity, totalAmount: order.totalAmount, paymentUrl });
});

router.post("/guest/lookup", publicOrderLimiter, (req, res) => {
  const orderId = typeof req.body?.orderId === "string" ? req.body.orderId.trim() : "";
  const phone = normalizePhone(typeof req.body?.phone === "string" ? req.body.phone : "");
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const row = db.prepare("SELECT * FROM orders WHERE id = ? AND customer_phone = ? AND user_id IS NULL AND guest_password_hash IS NOT NULL").get(orderId, phone);
  if (!row || !bcrypt.compareSync(password, row.guest_password_hash)) return res.status(401).json({ error: "주문 정보를 확인해 주세요." });
  res.json(rowToOrder(row));
});

router.post("/admin", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const id = typeof req.body.id === "string" && req.body.id ? req.body.id : `order-${crypto.randomUUID()}`;
  const quantity = Math.max(1, Math.min(MAX_QUANTITY, Number(req.body.quantity) || 1));
  const unitPrice = Math.max(0, Number(req.body.unitPrice || 0));
  const status = ORDER_STATUSES.has(req.body.status) ? req.body.status : ORDER_STATUS;
  const paymentStatus = PAYMENT_STATUSES.has(req.body.paymentStatus) ? req.body.paymentStatus : "결제대기";
  if (req.body.pickupDate && !isValidPickupDate(req.body.pickupDate)) return res.status(400).json({ error: "희망 날짜는 오늘 이후의 올바른 날짜여야 합니다." });
  db.exec("BEGIN");
  try {
    insertHeader({
      id, customer: String(req.body.customer || "고객"), phone: String(req.body.phone || ""),
      fulfillmentType: req.body.fulfillmentType === "delivery" ? "delivery" : "pickup",
      deliveryAddress: req.body.deliveryAddress, pickupDate: req.body.pickupDate, pickupTime: req.body.pickupTime,
      subtotal: unitPrice * quantity, totalAmount: unitPrice * quantity, cost: Math.max(0, Number(req.body.cost || 0)),
      status, paymentStatus, amountStatus: req.body.amountStatus === "pending" || unitPrice === 0 ? "pending" : "confirmed",
      workflowStatus: WORKFLOW_STATUSES.has(req.body.workflowStatus) ? req.body.workflowStatus : (paymentStatus === "결제완료" ? "접수대기" : "결제대기"),
      logisticsStatus: req.body.logisticsStatus, memo: req.body.memo, createdAt: now,
    });
    insertItem(id, { productId: null, productName: String(req.body.product || "상품"), unitPrice, quantity, lineTotal: unitPrice * quantity }, 0);
    addStatusHistory(id, null, status, getActorLabel(req), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "주문 등록 중 오류가 발생했습니다." });
  }
  res.status(201).json(getOrder(id));
});

// 생산 완료와 원재료 차감은 반드시 이 API의 단일 트랜잭션에서 처리한다.
router.post("/production/complete", requireAuth, (req, res) => {
  const orderIds = Array.isArray(req.body?.orderIds)
    ? [...new Set(req.body.orderIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))]
    : [];
  const productName = normalizeProductionProductName(req.body?.productName);
  if (!orderIds.length || orderIds.length > 100 || !productName) {
    return res.status(400).json({ error: "생산 완료할 주문과 상품을 확인해 주세요." });
  }

  const placeholders = orderIds.map(() => "?").join(",");
  const orders = db.prepare(`SELECT * FROM orders WHERE id IN (${placeholders})`).all(...orderIds);
  if (orders.length !== orderIds.length || orders.some((order) => ["취소", "주문취소"].includes(order.status))) {
    return res.status(400).json({ error: "취소됐거나 존재하지 않는 주문이 포함되어 있습니다." });
  }

  const matchingItems = db.prepare(`
    SELECT order_id, product_name, quantity
    FROM order_items
    WHERE order_id IN (${placeholders}) AND product_name = ?
  `).all(...orderIds, productName);
  if (!matchingItems.length || new Set(matchingItems.map((item) => item.order_id)).size !== orderIds.length) {
    return res.status(400).json({ error: "선택한 주문의 생산 상품이 일치하지 않습니다." });
  }

  const recipe = getProductionRecipe(productName);
  if (!recipe.length) return res.status(409).json({ error: `"${productName}"의 배합 기준이 없습니다.` });

  const quantity = matchingItems.reduce((sum, item) => sum + Number(item.quantity), 0);
  const requirements = recipe.map((row) => ({
    name: row.ingredient,
    amount: Number((Number(row.amount) * quantity).toFixed(4)),
    unit: row.unit,
  }));
  const inventoryRows = requirements.map((material) => db.prepare("SELECT * FROM inventory WHERE name = ?").get(material.name));
  const missing = requirements.filter((_, index) => !inventoryRows[index]).map((item) => item.name);
  const unitMismatch = requirements.filter((item, index) => inventoryRows[index] && inventoryRows[index].unit !== item.unit);
  const insufficient = requirements.filter((item, index) => inventoryRows[index] && inventoryRows[index].unit === item.unit && Number(inventoryRows[index].stock) < item.amount);
  if (missing.length || unitMismatch.length || insufficient.length) {
    return res.status(409).json({
      error: "원재료가 부족하거나 배합 단위가 일치하지 않아 생산 완료할 수 없습니다.",
      details: {
        missing,
        unitMismatch: unitMismatch.map((item) => `${item.name} (${item.unit})`),
        insufficient: insufficient.map((item) => {
          const stock = inventoryRows[requirements.indexOf(item)]?.stock ?? 0;
          return `${item.name} (필요 ${item.amount}${item.unit}, 재고 ${stock}${item.unit})`;
        }),
      },
    });
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertCompletion = db.prepare(`
      INSERT OR IGNORE INTO production_completions (order_id, product_name, quantity, completed_at)
      VALUES (?, ?, ?, ?)
    `);
    const newlyCompletedOrderIds = [];
    for (const item of matchingItems) {
      const result = insertCompletion.run(item.order_id, productName, item.quantity, now);
      if (result.changes) newlyCompletedOrderIds.push(item.order_id);
    }

    if (!newlyCompletedOrderIds.length) {
      db.exec("COMMIT");
      return res.json({ ok: true, alreadyCompleted: true, quantity, materials: [], orders: orderIds.map(getOrder) });
    }
    if (newlyCompletedOrderIds.length !== orderIds.length) throw new Error("PARTIAL_COMPLETION_CONFLICT");

    for (const material of requirements) {
      const result = db.prepare(`
        UPDATE inventory SET stock = ROUND(stock - ?, 4), updated_at = ?
        WHERE name = ? AND unit = ? AND stock >= ?
      `).run(material.amount, now, material.name, material.unit, material.amount);
      if (result.changes !== 1) throw new Error("INVENTORY_CHANGED");
    }

    for (const orderId of orderIds) {
      const remaining = db.prepare(`
        SELECT COUNT(*) AS count FROM order_items item
        WHERE item.order_id = ? AND NOT EXISTS (
          SELECT 1 FROM production_completions completion
          WHERE completion.order_id = item.order_id AND completion.product_name = item.product_name
        )
      `).get(orderId).count;
      db.prepare("UPDATE orders SET production_status=?, status=?, updated_at=? WHERE id=?")
        .run(remaining ? "생산 중" : "생산 완료", remaining ? "준비중" : "준비완료", now, orderId);
    }

    const materials = requirements.map((item) => `${item.name} ${item.amount}${item.unit}`);
    db.prepare(`
      INSERT INTO inventory_logs (id, product, quantity, order_count, materials, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`invlog-${crypto.randomUUID()}`, productName, quantity, orderIds.length, JSON.stringify(materials), now);
    addAuditLog({
      category: "생산", action: "production_complete", entityId: orderIds.join(","),
      previousValue: "생산 진행", nextValue: "생산 완료", actor: getActorLabel(req), createdAt: now,
      message: `${productName} ${quantity}개 생산 완료 · 원재료 차감`,
    });
    db.exec("COMMIT");
    res.json({
      ok: true, alreadyCompleted: false, quantity, materials,
      orders: orderIds.map(getOrder),
      inventory: db.prepare("SELECT * FROM inventory ORDER BY created_at DESC").all().map((row) => ({
        id: row.id, name: row.name, stock: row.stock, unit: row.unit,
        safeStock: row.safe_stock, memo: row.memo, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    });
  } catch (error) {
    db.exec("ROLLBACK");
    if (["PARTIAL_COMPLETION_CONFLICT", "INVENTORY_CHANGED"].includes(error.message)) {
      return res.status(409).json({ error: "생산 완료가 이미 처리됐거나 재고가 변경되었습니다. 새로고침 후 다시 시도해 주세요." });
    }
    return res.status(500).json({ error: "생산 완료 처리에 실패해 변경 내용을 모두 되돌렸습니다." });
  }
});

router.put("/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  const now = new Date().toISOString();
  const pickupDate = req.body.pickupDate ?? existing.pickup_date;
  const createdDate = String(existing.created_at || now).slice(0, 10);
  if (pickupDate && (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate) || pickupDate < createdDate)) {
    return res.status(400).json({ error: "희망 날짜는 주문 접수일 이후여야 합니다." });
  }
  const items = getOrderItems(existing.id);
  db.exec("BEGIN");
  try {
    if (items.length === 1 && (req.body.product !== undefined || req.body.unitPrice !== undefined || req.body.quantity !== undefined)) {
      const productName = String(req.body.product ?? items[0].productName);
      const unitPrice = Math.max(0, Number(req.body.unitPrice ?? items[0].unitPrice));
      const quantity = Math.max(1, Math.min(MAX_QUANTITY, Number(req.body.quantity ?? items[0].quantity)));
      db.prepare("UPDATE order_items SET product_name=?, unit_price=?, quantity=?, line_total=? WHERE id=?")
        .run(productName, unitPrice, quantity, unitPrice * quantity, items[0].id);
    }
    const subtotal = db.prepare("SELECT COALESCE(SUM(line_total), 0) AS total FROM order_items WHERE order_id = ?").get(existing.id).total;
    const nextStatus = req.body.status === undefined ? existing.status : (ORDER_STATUSES.has(req.body.status) ? req.body.status : null);
    if (!nextStatus) throw new Error("INVALID_ORDER_STATUS");
    if (nextStatus !== existing.status && !(STATUS_TRANSITIONS[existing.status] || []).includes(nextStatus)) throw new Error("INVALID_STATUS_TRANSITION");
    const changeReason = String(req.body.changeReason || "").trim();
    let nextPaymentStatus = PAYMENT_STATUSES.has(req.body.paymentStatus) ? req.body.paymentStatus : existing.payment_status;
    const requestedWorkflow = req.body.workflowStatus;
    const nextWorkflow = requestedWorkflow === undefined ? existing.workflow_status : (WORKFLOW_STATUSES.has(requestedWorkflow) ? requestedWorkflow : null);
    if (!nextWorkflow) throw new Error("INVALID_WORKFLOW_STATUS");
    if (nextWorkflow !== existing.workflow_status && !getWorkflowTransitions(existing.workflow_status, req.body.fulfillmentType ?? existing.fulfillment_type).includes(nextWorkflow)) throw new Error("INVALID_WORKFLOW_TRANSITION");
    if (existing.workflow_status === "결제대기" && !["결제대기", "취소"].includes(nextWorkflow)) nextPaymentStatus = "결제완료";
    if ((nextStatus !== existing.status && ["취소", "주문취소"].includes(nextStatus) || nextWorkflow !== existing.workflow_status && nextWorkflow === "취소") && !changeReason) throw new Error("CHANGE_REASON_REQUIRED");
    const workflowOrderStatus = ({ 접수대기: "접수대기", 접수완료: "준비중", 배송중: "배송중", 배송완료: "배송완료", 픽업준비완료: "준비완료", 픽업완료: "픽업완료", 취소: "취소" })[nextWorkflow] || nextStatus;
    if (["픽업완료", "배송완료"].includes(nextStatus) && nextPaymentStatus === "결제대기") throw new Error("INVALID_STATE_COMBINATION");
    const requestedTotal = req.body.revenue === undefined ? subtotal + existing.delivery_fee : Math.max(0, Number(req.body.revenue) || 0);
    const amountStatus = req.body.amountStatus === "pending" || req.body.amountStatus === "confirmed"
      ? req.body.amountStatus : (requestedTotal > 0 ? "confirmed" : existing.amount_status || "pending");
    const productionStatus = req.body.productionStatus === undefined ? existing.production_status : (PRODUCTION_STATUSES.has(req.body.productionStatus) ? req.body.productionStatus : null);
    if (!productionStatus) throw new Error("INVALID_PRODUCTION_STATUS");
    const productionAssignee = String(req.body.productionAssignee ?? existing.production_assignee ?? "").trim().slice(0, 50);
    const packagingType = String(req.body.packagingType ?? existing.packaging_type ?? "기본 포장").trim().slice(0, 50) || "기본 포장";
    db.prepare(`
      UPDATE orders SET customer_name=?, customer_phone=?, fulfillment_type=?, delivery_address=?, pickup_date=?, pickup_time=?,
        subtotal=?, total_amount=?, cost=?, status=?, payment_status=?, amount_status=?, workflow_status=?, logistics_status=?, memo=?,
        production_status=?, production_assignee=?, packaging_type=?, updated_at=? WHERE id=?
    `).run(
      req.body.customer ?? existing.customer_name, req.body.phone ?? existing.customer_phone,
      req.body.fulfillmentType ?? existing.fulfillment_type, req.body.deliveryAddress ?? existing.delivery_address,
      pickupDate, req.body.pickupTime ?? existing.pickup_time,
      subtotal, requestedTotal, Math.max(0, Number(req.body.cost ?? existing.cost)),
      workflowOrderStatus, nextPaymentStatus, amountStatus, nextWorkflow, req.body.logisticsStatus ?? existing.logistics_status, req.body.memo ?? existing.memo,
      productionStatus, productionAssignee, packagingType, now, existing.id,
    );
    if (workflowOrderStatus !== existing.status || nextWorkflow !== existing.workflow_status) {
      const historyPrevious = requestedWorkflow === undefined ? existing.status : existing.workflow_status;
      const historyNext = requestedWorkflow === undefined ? workflowOrderStatus : nextWorkflow;
      addStatusHistory(existing.id, historyPrevious, historyNext, getActorLabel(req), now, changeReason || null);
      addAuditLog({
        category: "주문 상태", action: "status_change", entityId: existing.id,
        previousValue: historyPrevious, nextValue: historyNext, actor: getActorLabel(req), createdAt: now,
        message: `${existing.id} 상태 변경${changeReason ? ` · 사유: ${changeReason}` : ""}`,
      });
    }
    if (requestedTotal !== existing.total_amount) {
      addAuditLog({ category: "견적", action: "amount_change", entityId: existing.id,
        previousValue: String(existing.total_amount), nextValue: String(requestedTotal), actor: getActorLabel(req), createdAt: now,
        message: `${existing.id} 주문 금액을 변경했습니다.` });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (["INVALID_ORDER_STATUS", "INVALID_STATUS_TRANSITION", "INVALID_WORKFLOW_STATUS", "INVALID_WORKFLOW_TRANSITION", "INVALID_STATE_COMBINATION", "CHANGE_REASON_REQUIRED"].includes(error.message)) {
      return res.status(400).json({ error: "주문·결제 상태 조합을 확인해 주세요." });
    }
    return res.status(500).json({ error: "주문 수정 중 오류가 발생했습니다." });
  }
  const updated = getOrder(existing.id);
  if (req.body.status === "준비완료" && existing.status !== "준비완료") notifyOrderReady(updated).catch(() => null);
  res.json(updated);
});

router.delete("/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.delete("/", requireAuth, (req, res) => {
  db.prepare("DELETE FROM orders").run();
  res.json({ ok: true });
});

module.exports = router;
