const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { optionalCustomerAuth } = require("../middleware/customerAuth");
const { notifyOrderReceived, notifyOrderReady } = require("../services/notify");
const {
  OrderPiiError,
  applyMaskedOrderFields,
  buildOrderPiiApiFields,
  buildOrderPiiColumns,
  buildOrderPiiStorage,
  buildMaskedOrderIdentity,
  maskOrderPii,
  readOrderPiiForOperation,
} = require("../services/order-pii-service");
const {
  getDefaultOrderPiiKeyring,
  isOrderPiiProtectionEnabled,
} = require("../lib/pii-keyring");
const { normalizePhone, isValidPhone } = require("../utils/normalize");
const {
  insertOrderPiiAudit,
  normalizeOrderPiiAccessReason,
  normalizeOrderPiiUpdateReason,
  normalizeRequestIp,
  orderPiiAccessLimiter,
  orderPiiUpdateLimiter,
  recordOrderPiiAccessFailure,
  recordOrderPiiUpdateFailure,
} = require("../lib/order-pii-access");

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
const ORDER_ITEM_QUANTITY_STEP = 0.5;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const DEFAULT_QUANTITY_UNIT = "pack";

function parseQuantityUnit(value, quantity = null) {
  if (value === "mal" || value === "pack") return value;
  const rawQuantity = Number(quantity);
  if (Number.isFinite(rawQuantity) && rawQuantity % 1 !== 0) return "mal";
  return DEFAULT_QUANTITY_UNIT;
}

function getQuantityStep(unit) {
  return unit === "mal" ? ORDER_ITEM_QUANTITY_STEP : 1;
}

function getQuantityMin(unit) {
  return unit === "mal" ? ORDER_ITEM_QUANTITY_STEP : 1;
}

function calculateMalLineTotal(quantity, halfMalPrice, malPrice) {
  const fullMalCount = Math.floor(quantity);
  const hasHalfMal = Math.abs(quantity - fullMalCount - 0.5) < 1e-8;
  return (fullMalCount * Number(malPrice)) + (hasHalfMal ? Number(halfMalPrice) : 0);
}

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
  const fulfillmentType = body?.fulfillmentType === "delivery" ? "delivery" : body?.fulfillmentType === "pickup" ? "pickup" : "";
  const pii = validateOrderCreationPii(body, fulfillmentType);
  const pickupDate = typeof body?.pickupDate === "string" ? body.pickupDate.trim() : "";
  const pickupTime = typeof body?.pickupTime === "string" ? body.pickupTime.trim() : "";
  const memo = typeof body?.memo === "string" ? body.memo.trim() : "";
  const paymentMethod = ["card", "transfer", "mobile", "onsite"].includes(body?.paymentMethod) ? body.paymentMethod : "onsite";
  if (!fulfillmentType) return { error: "수령 방식을 확인해 주세요." };
  if (pii.error) return pii;
  if (!isValidPickupDate(pickupDate)) return { error: "희망 날짜를 확인해 주세요." };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime)) return { error: "희망 시간을 확인해 주세요." };
  if (memo.length > 500) return { error: "요청사항은 500자 이하로 입력해 주세요." };
  return { data: { ...pii.data, fulfillmentType, pickupDate, pickupTime, memo, paymentMethod } };
}

function isProtectedPiiPlaceholder(value) {
  return typeof value === "string"
    && (value.includes("*") || value.toLowerCase().includes("[protected]"));
}

function validateOrderCreationPii(body, fulfillmentType) {
  const customer = typeof body?.customer === "string" ? body.customer.trim() : "";
  const rawPhone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const phone = normalizePhone(rawPhone);
  const deliveryAddress = typeof body?.deliveryAddress === "string"
    ? body.deliveryAddress.trim()
    : "";
  if (!customer || customer.length > 50 || isProtectedPiiPlaceholder(customer)) {
    return { error: "주문자 이름을 확인해 주세요." };
  }
  if (!rawPhone || !isValidPhone(phone) || isProtectedPiiPlaceholder(rawPhone)) {
    return { error: "연락처 형식이 올바르지 않습니다." };
  }
  if (fulfillmentType === "delivery"
    && (!deliveryAddress || deliveryAddress.length > 200 || isProtectedPiiPlaceholder(deliveryAddress))) {
    return { error: "배송 주소를 확인해 주세요." };
  }
  if (deliveryAddress.length > 200 || isProtectedPiiPlaceholder(deliveryAddress)) {
    return { error: "배송 주소는 200자 이하로 입력해 주세요." };
  }
  return {
    data: {
      customer,
      phone,
      deliveryAddress: fulfillmentType === "delivery" ? deliveryAddress : null,
    },
  };
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
    .run(`pay-${crypto.randomUUID()}`, order.id, order.totalAmount, orderName, null, null, now, linkHash, expiresAt, paymentMethod);
  return `pay.html?orderId=${encodeURIComponent(order.id)}&token=${encodeURIComponent(linkToken)}`;
}

function rotateCheckoutPaymentLink(orderId) {
  const payment = db.prepare("SELECT * FROM payments WHERE order_id=?").get(orderId);
  if (!payment || payment.status !== "PENDING" || payment.link_token_used_at
    || payment.session_token_hash) return null;
  const linkToken = crypto.randomBytes(32).toString("base64url");
  const linkHash = crypto.createHash("sha256").update(linkToken).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`UPDATE payments SET
    customer_name=NULL, customer_phone=NULL, link_token_hash=?, link_token_expires_at=?
    WHERE id=? AND status='PENDING' AND link_token_used_at IS NULL
      AND session_token_hash IS NULL`)
    .run(linkHash, expiresAt, payment.id);
  return result.changes === 1
    ? `pay.html?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(linkToken)}`
    : null;
}

function sendCheckoutReplay(res, checkoutId) {
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const order = getOrder(checkoutId);
    if (!order) throw new Error("CHECKOUT_REPLAY_ORDER_MISSING");
    const paymentUrl = rotateCheckoutPaymentLink(checkoutId);
    db.exec("COMMIT");
    transactionStarted = false;
    return res.status(200).set("Idempotency-Replayed", "true").json({
      checkoutId: order.id,
      order,
      orders: [order],
      totalQuantity: order.quantity,
      totalAmount: order.totalAmount,
      paymentUrl,
    });
  } catch {
    if (transactionStarted) db.exec("ROLLBACK");
    return res.status(503).json({ error: "기존 주문 정보를 안전하게 불러오지 못했습니다." });
  }
}


function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) {
    return { error: '주문 상품은 1개 이상 30개 이하로 넣어 주세요.' };
  }
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const productId = typeof item?.productId === "string" ? item.productId.trim() : "";
    const rawQuantity = Number(item?.quantity);
    const quantityUnit = parseQuantityUnit(item?.quantityUnit, rawQuantity);
    const step = getQuantityStep(quantityUnit);
    const minQuantity = getQuantityMin(quantityUnit);
    if (!productId || productId.length > 100) return { error: '상품을 다시 확인해 주세요.' };
    if (!Number.isFinite(rawQuantity) || rawQuantity < minQuantity || rawQuantity > MAX_QUANTITY) {
      return { error: `${quantityUnit === "mal" ? "말은" : "팩은"} ${minQuantity}~${MAX_QUANTITY} 단위로 입력해 주세요.` };
    }
    const quantity = Math.round(rawQuantity / step) * step;
    if (Math.abs(quantity - rawQuantity) > 1e-8) {
      return { error: `${quantityUnit === "mal" ? "말은 0.5 단위" : "팩은 정수"}로 입력해 주세요.` };
    }
    if (seen.has(productId)) return { error: '하나의 상품은 한번만 입력해 주세요.' };
    seen.add(productId);
    normalized.push({ productId, quantity, quantityUnit });
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
    quantityUnit: item.quantity_unit || DEFAULT_QUANTITY_UNIT,
    lineTotal: item.line_total,
    packWeightGrams: item.pack_weight_grams ?? null,
    halfMalWeightGrams: item.half_mal_weight_grams ?? null,
    malWeightGrams: item.mal_weight_grams ?? null,
    totalWeightGrams: item.total_weight_grams ?? null,
  }));
}


function rowToOrderBase(row, { includePaymentSummary = false } = {}) {
  const items = getOrderItems(row.id);
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const first = items[0];
  const productSummary = first ? `${first.productName}${items.length > 1 ? ` 외 ${items.length - 1}건` : ""}` : "상품 없음";
  const order = {
    id: row.id,
    checkoutId: row.id,
    userId: row.user_id,
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
  if (includePaymentSummary) {
    order.paymentInternalStatus = row.payment_internal_status || "NONE";
    order.paymentLastError = row.payment_last_error || null;
    order.paymentUpdatedAt = row.payment_updated_at || null;
  }
  return order;
}

function rowToOperationalOrder(row, options = {}) {
  const pii = readOrderPiiForOperation(row);
  return {
    ...rowToOrderBase(row, options),
    customer: pii.customerName,
    phone: pii.customerPhone,
    deliveryAddress: pii.deliveryAddress,
    guestAddress: pii.guestAddress,
  };
}

function rowToMaskedOrder(row, options = {}) {
  return applyMaskedOrderFields(
    rowToOrderBase(row, options),
    buildMaskedOrderIdentity(row),
  );
}

function rowToLegacyCompatibleOrder(row, options = {}) {
  return {
    ...rowToOrderBase(row, options),
    ...buildOrderPiiApiFields(row),
  };
}

function rowToPublicOrder(row, options = {}) {
  return isOrderPiiProtectionEnabled()
    ? rowToMaskedOrder(row, options)
    : rowToLegacyCompatibleOrder(row, options);
}

function getOrder(orderId) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  return row ? rowToPublicOrder(row) : null;
}

function getOperationalOrder(orderId) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  return row ? rowToOperationalOrder(row) : null;
}

function sendPiiAccessError(res) {
  return res.status(503).json({
    error: "주문 개인정보를 안전하게 확인할 수 없습니다.",
    reason: "ORDER_PII_ACCESS_FAILED",
  });
}

function setOrderPiiNoStoreHeaders(req, res, next) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}

function sendStrictPiiFailureAudit(req, res, { orderId = null, reason = null, failureCode, status }) {
  try {
    recordOrderPiiAccessFailure(req, { orderId, reason, failureCode });
  } catch {
    return res.status(503).json({
      error: "개인정보 접근 감사 기록을 완료하지 못했습니다.",
      reason: "ORDER_PII_AUDIT_FAILED",
    });
  }
  return res.status(status).json({
    error: "주문 개인정보에 접근할 수 없습니다.",
    reason: failureCode,
  });
}

const ORDER_PII_UPDATE_FIELDS = Object.freeze([
  "customer",
  "phone",
  "deliveryAddress",
  "guestAddress",
]);
const ORDER_PII_UPDATE_REQUEST_FIELDS = new Set([
  ...ORDER_PII_UPDATE_FIELDS,
  "reason",
  "expectedUpdatedAt",
]);

class OrderPiiUpdateError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function hasMaskedPiiInput(value) {
  return typeof value === "string"
    && (value.includes("*") || value.toLowerCase().includes("[protected]"));
}

function normalizeOrderPiiPatch(body, existingPii, fulfillmentType) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
  }
  if (Object.keys(body).some((field) => !ORDER_PII_UPDATE_REQUEST_FIELDS.has(field))) {
    throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
  }
  const suppliedFields = ORDER_PII_UPDATE_FIELDS.filter((field) => Object.hasOwn(body, field));
  if (!suppliedFields.length) throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);

  const next = { ...existingPii };
  for (const field of suppliedFields) {
    const value = body[field];
    if (hasMaskedPiiInput(value)) throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
    if (field === "customer") {
      if (typeof value !== "string") throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
      const customer = value.trim();
      if (!customer || customer.length > 50) throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
      next.customerName = customer;
    } else if (field === "phone") {
      if (typeof value !== "string") throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
      const phone = normalizePhone(value);
      if (!value.trim() || !isValidPhone(phone)) throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
      next.customerPhone = phone;
    } else {
      if (value === null) {
        if (field === "deliveryAddress" && fulfillmentType === "delivery") {
          throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
        }
        next[field] = null;
      } else {
        if (typeof value !== "string") throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
        const normalized = value.trim();
        if (!normalized || normalized.length > 200) {
          throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
        }
        next[field] = normalized;
      }
    }
  }
  if (fulfillmentType === "delivery" && !next.deliveryAddress) {
    throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
  }
  const changedFields = suppliedFields.filter((field) => {
    const piiField = field === "customer"
      ? "customerName"
      : field === "phone"
        ? "customerPhone"
        : field;
    return next[piiField] !== existingPii[piiField];
  });
  if (!changedFields.length) throw new OrderPiiUpdateError("ORDER_PII_UPDATE_INVALID", 400);
  return { next, changedFields };
}

function sendStrictPiiUpdateFailure(req, res, {
  orderId,
  reason = null,
  failureCode,
  status,
  changedFields = [],
}) {
  try {
    recordOrderPiiUpdateFailure(req, {
      orderId,
      reason,
      failureCode,
      changedFields,
    });
  } catch {
    return res.status(503).json({
      error: "개인정보 수정 감사 기록을 완료하지 못했습니다.",
      reason: "ORDER_PII_AUDIT_FAILED",
    });
  }
  return res.status(status).json({
    error: "주문 개인정보를 수정할 수 없습니다.",
    reason: failureCode,
  });
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
  const pii = buildOrderPiiStorage({
    customerName: fields.customer,
    customerPhone: fields.phone,
    deliveryAddress: fields.deliveryAddress,
    guestAddress: fields.guestAddress,
  });
  db.prepare(`
    INSERT INTO orders
      (id, user_id, customer_name, customer_phone, fulfillment_type, delivery_address, pickup_date, pickup_time,
       subtotal, delivery_fee, total_amount, cost, status, payment_status, amount_status, workflow_status, logistics_status, memo, created_at, updated_at,
       guest_password_hash, guest_address, pii_ciphertext, pii_iv, pii_auth_tag, pii_key_version,
       customer_name_masked, customer_phone_masked, delivery_region_masked, pii_migrated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.id, fields.userId || null, pii.customerName, pii.customerPhone, fields.fulfillmentType,
    pii.deliveryAddress, fields.pickupDate || null, fields.pickupTime || null,
    fields.subtotal, fields.deliveryFee || 0, fields.totalAmount, fields.cost || 0,
    fields.status || ORDER_STATUS, fields.paymentStatus || "결제대기", fields.amountStatus || "confirmed",
    fields.workflowStatus || "결제대기", fields.logisticsStatus || null, fields.memo || null, fields.createdAt, fields.createdAt,
    fields.guestPasswordHash || null, pii.guestAddress,
    pii.piiCiphertext, pii.piiIv, pii.piiAuthTag, pii.piiKeyVersion,
    pii.customerNameMasked, pii.customerPhoneMasked, pii.deliveryRegionMasked, pii.piiMigratedAt,
  );
}

function insertItem(orderId, item, index) {
  db.prepare(`
    INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, quantity_unit, line_total,
      pack_weight_grams, half_mal_weight_grams, mal_weight_grams, total_weight_grams)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`item-${orderId}-${index + 1}`, orderId, item.productId || null, item.productName, item.unitPrice, item.quantity, item.quantityUnit || DEFAULT_QUANTITY_UNIT, item.lineTotal,
    item.packWeightGrams ?? null, item.halfMalWeightGrams ?? null, item.malWeightGrams ?? null, item.totalWeightGrams ?? null);
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
    const quantity = requested.quantity;
    const isMal = requested.quantityUnit === "mal";
    const malPrice = Number(product.mal_price ?? Math.round(Number(product.price) * 32));
    const halfMalPrice = Number(product.half_mal_price ?? Math.round(malPrice / 2));
    const unitPrice = isMal ? malPrice : Number(product.price);
    const lineTotal = isMal
      ? calculateMalLineTotal(quantity, halfMalPrice, malPrice)
      : Math.round(unitPrice * quantity);
    const packWeightGrams = Number.isInteger(product.unit_weight_grams) ? product.unit_weight_grams : null;
    const halfMalWeightGrams = Number.isInteger(product.half_mal_weight_grams) ? product.half_mal_weight_grams : null;
    const malWeightGrams = Number.isInteger(product.mal_weight_grams) ? product.mal_weight_grams : null;
    const fullMalCount = Math.floor(quantity);
    const includesHalfMal = Math.round((quantity - fullMalCount) * 2) === 1;
    const totalWeightGrams = isMal
      ? (malWeightGrams !== null && (!includesHalfMal || halfMalWeightGrams !== null)
        ? (fullMalCount * malWeightGrams) + (includesHalfMal ? halfMalWeightGrams : 0)
        : null)
      : (packWeightGrams !== null ? Math.round(packWeightGrams * quantity) : null);
    return {
      productId: product.id,
      productName: product.name,
      quantityUnit: requested.quantityUnit || DEFAULT_QUANTITY_UNIT,
      unitPrice,
      quantity,
      lineTotal,
      packWeightGrams,
      halfMalWeightGrams,
      malWeightGrams,
      totalWeightGrams,
    };
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
  return { id, items, totalAmount: subtotal };
}

router.get("/", requireAuth, requirePermission("orders:read"), (req, res) => {
  const rows = db.prepare(`
    SELECT o.*,
      p.status AS payment_internal_status,
      p.last_error AS payment_last_error,
      COALESCE(p.canceled_at, p.paid_at, p.requested_at) AS payment_updated_at
    FROM orders o
    LEFT JOIN payments p ON p.order_id = o.id
    ORDER BY o.created_at DESC
  `).all();
  try {
    return res.json(rows.map((row) => rowToPublicOrder(row, { includePaymentSummary: true })));
  } catch (error) {
    if (error instanceof OrderPiiError) return sendPiiAccessError(res);
    throw error;
  }
});

router.get("/:id/history", requireAuth, requirePermission("orders:read"), (req, res) => {
  const existing = db.prepare("SELECT id FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  const rows = db.prepare("SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at DESC").all(req.params.id);
  res.json(rows.map((row) => ({
    id: row.id, previousStatus: row.previous_status, nextStatus: row.next_status,
    changedBy: row.changed_by, reason: row.reason, createdAt: row.created_at,
  })));
});

router.post(
  "/:id/pii-access",
  setOrderPiiNoStoreHeaders,
  requireAuth,
  requirePermission("orders:pii:read", { reason: "ORDER_PII_PERMISSION_DENIED" }),
  orderPiiAccessLimiter,
  (req, res) => {
    const reason = normalizeOrderPiiAccessReason(req.body?.reason);
    if (!reason) {
      return sendStrictPiiFailureAudit(req, res, {
        orderId: req.params.id,
        failureCode: "ORDER_PII_REASON_INVALID",
        status: 400,
      });
    }

    const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!row) {
      return sendStrictPiiFailureAudit(req, res, {
        orderId: req.params.id,
        reason,
        failureCode: "ORDER_PII_ACCESS_FAILED",
        status: 404,
      });
    }

    let pii;
    try {
      pii = readOrderPiiForOperation(row);
    } catch (error) {
      if (!(error instanceof OrderPiiError)) throw error;
      return sendStrictPiiFailureAudit(req, res, {
        orderId: row.id,
        reason,
        failureCode: "ORDER_PII_ACCESS_FAILED",
        status: 503,
      });
    }

    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      insertOrderPiiAudit({
        action: "order_pii_accessed",
        orderId: row.id,
        actor: req.admin.id,
        actorRole: req.admin.role,
        reason,
        outcome: "success",
        requestIp: normalizeRequestIp(req),
      });
      db.exec("COMMIT");
      transactionStarted = false;
    } catch {
      if (transactionStarted) db.exec("ROLLBACK");
      return res.status(503).json({
        error: "개인정보 접근 감사 기록을 완료하지 못했습니다.",
        reason: "ORDER_PII_AUDIT_FAILED",
      });
    }

    return res.json({
      orderId: row.id,
      customer: pii.customerName,
      phone: pii.customerPhone,
      deliveryAddress: pii.deliveryAddress,
    });
  },
);

router.post("/", publicOrderLimiter, optionalCustomerAuth, (req, res) => {
  const customer = validateCustomerFields(req.body);
  const items = normalizeItems([{ productId: req.body?.productId, quantity: req.body?.quantity, quantityUnit: req.body?.quantityUnit }]);
  if (customer.error || items.error) return res.status(400).json({ error: customer.error || items.error });
  const product = db.prepare("SELECT id, name, price, half_mal_price, mal_price, unit_weight_grams, half_mal_weight_grams, mal_weight_grams FROM products WHERE id = ? AND status = 'active'").get(items.data[0].productId);
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
  db.exec("BEGIN IMMEDIATE");
  try {
    createOrder({ id, userId: req.user?.id, customerData: customer.data, products: [product], requestedItems: items.data, memo: customer.data.memo, createdAt: now });
    if (key) db.prepare("INSERT INTO order_idempotency VALUES (?, ?, ?, ?)").run(key, hash, id, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error(`[orders] 주문 생성 실패: ${error instanceof OrderPiiError ? error.code : "ORDER_CREATE_FAILED"}`);
    return res.status(500).json({ error: "주문 접수 중 오류가 발생했습니다." });
  }
  const order = getOrder(id);
  notifyOrderReceived(getOperationalOrder(id)).catch(() => null);
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
    return sendCheckoutReplay(res, previous.checkout_id);
  }
  let guestData = null;
  if (!req.user && req.body?.guestPassword) {
    const password = String(req.body.guestPassword);
    const address = typeof req.body.guestAddress === "string" ? req.body.guestAddress.trim() : "";
    if (Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72) return res.status(400).json({ error: "비회원 주문 비밀번호를 확인해 주세요." });
    if (!address || address.length > 200 || isProtectedPiiPlaceholder(address)) {
      return res.status(400).json({ error: "비회원 주문 주소를 확인해 주세요." });
    }
    guestData = { passwordHash: bcrypt.hashSync(password, 10), address };
  }
  const productQuery = db.prepare("SELECT id, name, price, half_mal_price, mal_price, unit_weight_grams, half_mal_weight_grams, mal_weight_grams FROM products WHERE id = ? AND status = 'active' AND purchase_type = 'direct'");
  const products = items.data.map((item) => productQuery.get(item.productId));
  if (products.some((product) => !product)) return res.status(409).json({ error: "판매가 종료되었거나 장바구니로 주문할 수 없는 상품이 포함되어 있습니다." });
  const id = `checkout-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  let paymentUrl = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const concurrent = db.prepare("SELECT request_hash, checkout_id FROM checkout_idempotency WHERE idempotency_key = ?").get(key);
    if (concurrent) {
      if (concurrent.request_hash !== hash) throw new Error("CHECKOUT_IDEMPOTENCY_CONFLICT");
      db.exec("ROLLBACK");
      return sendCheckoutReplay(res, concurrent.checkout_id);
    }
    if (guestData) {
      const verification = db.prepare(`SELECT id FROM phone_verifications
        WHERE phone=? AND verified_at IS NOT NULL AND consumed_at IS NULL
        ORDER BY verified_at DESC LIMIT 1`).get(customer.data.phone);
      if (!verification) throw new Error("GUEST_VERIFICATION_REQUIRED");
      guestData.verificationId = verification.id;
    }
    const createdOrder = createOrder({ id, userId: req.user?.id, customerData: customer.data, products, requestedItems: items.data, memo: customer.data.memo, createdAt: now, guestData });
    db.prepare("INSERT INTO checkout_idempotency VALUES (?, ?, ?, ?)").run(key, hash, id, now);
    if (guestData?.verificationId) {
      const consumed = db.prepare("UPDATE phone_verifications SET consumed_at=? WHERE id=? AND consumed_at IS NULL")
        .run(now, guestData.verificationId);
      if (consumed.changes !== 1) throw new Error("GUEST_VERIFICATION_REQUIRED");
    }
    paymentUrl = createCheckoutPayment(createdOrder, customer.data.paymentMethod, now);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (error.message === "CHECKOUT_IDEMPOTENCY_CONFLICT") {
      return res.status(409).json({ error: "같은 중복 방지 키로 다른 주문을 요청할 수 없습니다." });
    }
    if (error.message === "GUEST_VERIFICATION_REQUIRED") {
      return res.status(400).json({ error: "휴대폰 인증을 완료해 주세요." });
    }
    console.error(`[orders.checkout] 주문 생성 실패: ${error instanceof OrderPiiError ? error.code : "CHECKOUT_CREATE_FAILED"}`);
    return res.status(500).json({ error: "주문 접수 중 오류가 발생했습니다." });
  }
  const operationalOrder = getOperationalOrder(id);
  const order = getOrder(id);
  notifyOrderReceived(operationalOrder).catch(() => null);
  res.status(201).json({ checkoutId: id, order, orders: [order], totalQuantity: order.quantity, totalAmount: order.totalAmount, paymentUrl });
});

router.post("/guest/lookup", publicOrderLimiter, (req, res) => {
  const orderId = typeof req.body?.orderId === "string" ? req.body.orderId.trim() : "";
  const phone = normalizePhone(typeof req.body?.phone === "string" ? req.body.phone : "");
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const row = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id IS NULL AND guest_password_hash IS NOT NULL").get(orderId);
  if (!row) return res.status(401).json({ error: "주문 정보를 확인해 주세요." });
  let pii;
  try {
    pii = readOrderPiiForOperation(row);
  } catch (error) {
    if (error instanceof OrderPiiError) return sendPiiAccessError(res);
    throw error;
  }
  const suppliedPhoneHash = crypto.createHash("sha256").update(phone).digest();
  const storedPhoneHash = crypto.createHash("sha256").update(pii.customerPhone).digest();
  const phoneMatches = crypto.timingSafeEqual(suppliedPhoneHash, storedPhoneHash);
  const passwordMatches = bcrypt.compareSync(password, row.guest_password_hash);
  if (!phoneMatches || !passwordMatches) return res.status(401).json({ error: "주문 정보를 확인해 주세요." });
  return res.json(rowToPublicOrder(row));
});

router.post("/admin", requireAuth, requirePermission("orders:write"), (req, res) => {
  const now = new Date().toISOString();
  const id = typeof req.body.id === "string" && req.body.id ? req.body.id : `order-${crypto.randomUUID()}`;
  const parsedQuantity = Number(req.body.quantity);
  const quantityUnit = parseQuantityUnit(req.body.quantityUnit, parsedQuantity);
  const step = getQuantityStep(quantityUnit);
  const minQuantity = getQuantityMin(quantityUnit);
  const quantity = Number.isFinite(parsedQuantity) ? Math.min(MAX_QUANTITY, Math.max(minQuantity, Math.round(parsedQuantity / step) * step)) : minQuantity;
  const unitPrice = Math.max(0, Number(req.body.unitPrice || 0));
  const status = ORDER_STATUSES.has(req.body.status) ? req.body.status : ORDER_STATUS;
  const paymentStatus = PAYMENT_STATUSES.has(req.body.paymentStatus) ? req.body.paymentStatus : "결제대기";
  const fulfillmentType = req.body.fulfillmentType === "delivery" ? "delivery" : "pickup";
  const pii = validateOrderCreationPii(req.body, fulfillmentType);
  if (pii.error) return res.status(400).json({ error: pii.error });
  if (req.body.pickupDate && !isValidPickupDate(req.body.pickupDate)) return res.status(400).json({ error: "희망 날짜는 오늘 이후의 올바른 날짜여야 합니다." });
  db.exec("BEGIN IMMEDIATE");
  try {
    insertHeader({
      id, customer: pii.data.customer, phone: pii.data.phone,
      fulfillmentType,
      deliveryAddress: pii.data.deliveryAddress, pickupDate: req.body.pickupDate, pickupTime: req.body.pickupTime,
      subtotal: Math.round(unitPrice * quantity), totalAmount: Math.round(unitPrice * quantity), cost: Math.max(0, Number(req.body.cost || 0)),
      status, paymentStatus, amountStatus: req.body.amountStatus === "pending" || unitPrice === 0 ? "pending" : "confirmed",
      workflowStatus: WORKFLOW_STATUSES.has(req.body.workflowStatus) ? req.body.workflowStatus : (paymentStatus === "결제완료" ? "접수대기" : "결제대기"),
      logisticsStatus: req.body.logisticsStatus, memo: req.body.memo, createdAt: now,
    });
    insertItem(id, {
      productId: null,
      productName: String(req.body.product || "상품"),
      quantityUnit,
      unitPrice,
      quantity,
      lineTotal: Math.round(unitPrice * quantity),
    }, 0);
    addStatusHistory(id, null, status, getActorLabel(req), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "주문 등록 중 오류가 발생했습니다." });
  }
  res.status(201).json(getOrder(id));
});

// 생산 완료와 원재료 차감은 반드시 이 API의 단일 트랜잭션에서 처리한다.
router.post("/production/complete", requireAuth, requirePermission("orders:write"), (req, res) => {
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

  const incompleteOnlinePayment = db.prepare(`
    SELECT payments.order_id
    FROM payments
    JOIN orders ON orders.id = payments.order_id
    WHERE payments.order_id IN (${placeholders})
      AND (payments.status <> 'DONE' OR orders.payment_status <> '결제완료')
    LIMIT 1
  `).get(...orderIds);
  if (incompleteOnlinePayment) {
    return res.status(409).json({ error: "결제가 완료되지 않은 온라인 주문은 생산 완료 처리할 수 없습니다." });
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

router.patch(
  "/:id/pii",
  setOrderPiiNoStoreHeaders,
  requireAuth,
  requirePermission("orders:pii:write", { reason: "ORDER_PII_UPDATE_FORBIDDEN" }),
  orderPiiUpdateLimiter,
  (req, res) => {
    const reason = normalizeOrderPiiUpdateReason(req.body?.reason);
    const requestedFields = ORDER_PII_UPDATE_FIELDS.filter((field) => Object.hasOwn(req.body || {}, field));
    if (!reason) {
      return sendStrictPiiUpdateFailure(req, res, {
        orderId: req.params.id,
        failureCode: "ORDER_PII_UPDATE_INVALID",
        status: 400,
        changedFields: requestedFields,
      });
    }

    let transactionStarted = false;
    let auditPhase = false;
    let result;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
      if (!existing) throw new OrderPiiUpdateError("ORDER_PII_UPDATE_FAILED", 404);
      if (Object.hasOwn(req.body, "expectedUpdatedAt")) {
        if (typeof req.body.expectedUpdatedAt !== "string"
          || req.body.expectedUpdatedAt !== existing.updated_at) {
          throw new OrderPiiUpdateError("ORDER_PII_UPDATE_CONFLICT", 409);
        }
      }

      const encryptedExisting = [
        existing.pii_ciphertext,
        existing.pii_iv,
        existing.pii_auth_tag,
        existing.pii_key_version,
      ].some((value) => value !== null && value !== undefined && value !== "");
      const protectionEnabled = isOrderPiiProtectionEnabled();
      if (!protectionEnabled && encryptedExisting) {
        throw new OrderPiiUpdateError("ORDER_PII_UPDATE_FORBIDDEN", 403);
      }

      let currentPii;
      try {
        currentPii = readOrderPiiForOperation(existing);
      } catch (error) {
        if (error instanceof OrderPiiError) {
          throw new OrderPiiUpdateError("ORDER_PII_UPDATE_FAILED", 503);
        }
        throw error;
      }
      const { next, changedFields } = normalizeOrderPiiPatch(
        req.body,
        currentPii,
        existing.fulfillment_type,
      );
      const now = new Date().toISOString();
      let updateResult;
      if (protectionEnabled) {
        let protectedColumns;
        try {
          protectedColumns = buildOrderPiiColumns(
            next,
            getDefaultOrderPiiKeyring(),
            existing.pii_migrated_at || now,
          );
        } catch (error) {
          if (error instanceof OrderPiiError) {
            throw new OrderPiiUpdateError("ORDER_PII_UPDATE_FAILED", 503);
          }
          throw error;
        }
        updateResult = db.prepare(`UPDATE orders SET
          customer_name='[protected]', customer_phone='[protected]',
          delivery_address=NULL, guest_address=NULL,
          pii_ciphertext=?, pii_iv=?, pii_auth_tag=?, pii_key_version=?,
          customer_name_masked=?, customer_phone_masked=?, delivery_region_masked=?,
          pii_migrated_at=?, updated_at=? WHERE id=?`)
          .run(
            protectedColumns.piiCiphertext,
            protectedColumns.piiIv,
            protectedColumns.piiAuthTag,
            protectedColumns.piiKeyVersion,
            protectedColumns.customerNameMasked,
            protectedColumns.customerPhoneMasked,
            protectedColumns.deliveryRegionMasked,
            protectedColumns.piiMigratedAt,
            now,
            existing.id,
          );
      } else {
        const masked = maskOrderPii(next);
        updateResult = db.prepare(`UPDATE orders SET
          customer_name=?, customer_phone=?, delivery_address=?, guest_address=?,
          customer_name_masked=?, customer_phone_masked=?, delivery_region_masked=?,
          updated_at=? WHERE id=?`)
          .run(
            next.customerName,
            next.customerPhone,
            next.deliveryAddress,
            next.guestAddress,
            masked.customerNameMasked,
            masked.customerPhoneMasked,
            masked.deliveryRegionMasked,
            now,
            existing.id,
          );
      }
      if (updateResult.changes !== 1) {
        throw new OrderPiiUpdateError("ORDER_PII_UPDATE_FAILED", 503);
      }

      auditPhase = true;
      insertOrderPiiAudit({
        action: "order_pii_updated",
        orderId: existing.id,
        actor: req.admin.id,
        actorRole: req.admin.role,
        reason,
        outcome: "success",
        requestIp: normalizeRequestIp(req),
        changedFields,
      });
      const masked = maskOrderPii(next);
      result = {
        orderId: existing.id,
        customer: masked.customerNameMasked,
        phone: masked.customerPhoneMasked,
        deliveryAddress: null,
        customerNameMasked: masked.customerNameMasked,
        customerPhoneMasked: masked.customerPhoneMasked,
        deliveryRegionMasked: masked.deliveryRegionMasked,
        updatedFields: changedFields,
        updatedAt: now,
      };
      db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) db.exec("ROLLBACK");
      if (auditPhase && !(error instanceof OrderPiiUpdateError)) {
        return res.status(503).json({
          error: "개인정보 수정 감사 기록을 완료하지 못했습니다.",
          reason: "ORDER_PII_AUDIT_FAILED",
        });
      }
      const safeError = error instanceof OrderPiiUpdateError
        ? error
        : new OrderPiiUpdateError("ORDER_PII_UPDATE_FAILED", 503);
      return sendStrictPiiUpdateFailure(req, res, {
        orderId: req.params.id,
        reason,
        failureCode: safeError.code,
        status: safeError.status,
        changedFields: requestedFields,
      });
    }
    return res.json(result);
  },
);

router.put("/:id", requireAuth, requirePermission("orders:write"), (req, res) => {
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
    const onlinePayment = db.prepare("SELECT status FROM payments WHERE order_id=?").get(existing.id);
    if (onlinePayment && req.body.paymentStatus !== undefined && req.body.paymentStatus !== existing.payment_status) {
      throw new Error("ONLINE_PAYMENT_STATUS_LOCKED");
    }
    if (items.length === 1 && (req.body.product !== undefined || req.body.unitPrice !== undefined || req.body.quantity !== undefined)) {
      const productName = String(req.body.product ?? items[0].productName);
      const unitPrice = Math.max(0, Number(req.body.unitPrice ?? items[0].unitPrice));
      const normalizedQuantity = Number(req.body.quantity ?? items[0].quantity);
      const requestedQuantityUnit = parseQuantityUnit(req.body.quantityUnit ?? items[0].quantityUnit, normalizedQuantity ?? items[0].quantity);
      const requestedQuantityStep = getQuantityStep(requestedQuantityUnit);
      const requestedQuantityMin = getQuantityMin(requestedQuantityUnit);
      const quantity = Number.isFinite(normalizedQuantity)
        ? Math.min(MAX_QUANTITY, Math.max(requestedQuantityMin, Math.round(normalizedQuantity / requestedQuantityStep) * requestedQuantityStep))
        : requestedQuantityMin;
      db.prepare("UPDATE order_items SET product_name=?, unit_price=?, quantity=?, quantity_unit=?, line_total=? WHERE id=?")
        .run(productName, unitPrice, quantity, requestedQuantityUnit, Math.round(unitPrice * quantity), items[0].id);
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
    if ((nextStatus !== existing.status && ["취소", "주문취소"].includes(nextStatus) || nextWorkflow !== existing.workflow_status && nextWorkflow === "취소") && !changeReason) throw new Error("CHANGE_REASON_REQUIRED");
    const workflowOrderStatus = ({ 접수대기: "접수대기", 접수완료: "준비중", 배송중: "배송중", 배송완료: "배송완료", 픽업준비완료: "준비완료", 픽업완료: "픽업완료", 취소: "취소" })[nextWorkflow] || nextStatus;
    if (["픽업완료", "배송완료"].includes(nextStatus) && nextPaymentStatus === "결제대기") throw new Error("INVALID_STATE_COMBINATION");
    const requestedTotal = req.body.revenue === undefined ? subtotal + existing.delivery_fee : Math.max(0, Number(req.body.revenue) || 0);
    const amountStatus = req.body.amountStatus === "pending" || req.body.amountStatus === "confirmed"
      ? req.body.amountStatus : (requestedTotal > 0 ? "confirmed" : existing.amount_status || "pending");
    const productionStatus = req.body.productionStatus === undefined ? existing.production_status : (PRODUCTION_STATUSES.has(req.body.productionStatus) ? req.body.productionStatus : null);
    if (!productionStatus) throw new Error("INVALID_PRODUCTION_STATUS");
    const isCancelTransition = ["취소", "주문취소"].includes(nextStatus) || nextWorkflow === "취소";
    const onlinePaymentIncomplete = onlinePayment
      && (onlinePayment.status !== "DONE" || existing.payment_status !== "결제완료");
    const advancesUnpaidOnlineOrder = onlinePaymentIncomplete && !isCancelTransition && (
      !["결제대기", "접수대기"].includes(nextWorkflow)
      || !["접수대기"].includes(nextStatus)
      || productionStatus !== "생산 대기"
      || (req.body.logisticsStatus !== undefined && req.body.logisticsStatus !== existing.logistics_status)
    );
    if (advancesUnpaidOnlineOrder) throw new Error("ONLINE_PAYMENT_NOT_COMPLETED");
    const productionAssignee = String(req.body.productionAssignee ?? existing.production_assignee ?? "").trim().slice(0, 50);
    const packagingType = String(req.body.packagingType ?? existing.packaging_type ?? "기본 포장").trim().slice(0, 50) || "기본 포장";
    const maskedInput = (value) => typeof value === "string"
      && (value.includes("*") || value.trim() === "[protected]");
    const hasOwn = (field) => Object.hasOwn(req.body, field);
    const hasExplicitPiiChange = ["customer", "phone", "deliveryAddress", "guestAddress"].some((field) => {
      if (!hasOwn(field)) return false;
      const value = req.body[field];
      if (value === null || value === undefined || maskedInput(value)) return false;
      return true;
    });
    if (hasExplicitPiiChange) {
      throw new Error("PII_UPDATE_FORBIDDEN");
    }
    db.prepare(`
      UPDATE orders SET customer_name=?, customer_phone=?, fulfillment_type=?, delivery_address=?, pickup_date=?, pickup_time=?,
        subtotal=?, total_amount=?, cost=?, status=?, payment_status=?, amount_status=?, workflow_status=?, logistics_status=?, memo=?,
        production_status=?, production_assignee=?, packaging_type=?, updated_at=? WHERE id=?
    `).run(
      existing.customer_name, existing.customer_phone,
      req.body.fulfillmentType ?? existing.fulfillment_type, existing.delivery_address,
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
    if (error.message === "ONLINE_PAYMENT_STATUS_LOCKED") {
      return res.status(409).json({ error: "온라인 결제 주문의 결제 상태는 Toss 승인·재조정·취소 API에서만 변경할 수 있습니다." });
    }
    if (error.message === "ONLINE_PAYMENT_NOT_COMPLETED") {
      return res.status(409).json({ error: "결제가 완료되지 않은 온라인 주문은 생산·배송 단계로 진행할 수 없습니다." });
    }
    if (["INVALID_ORDER_STATUS", "INVALID_STATUS_TRANSITION", "INVALID_WORKFLOW_STATUS", "INVALID_WORKFLOW_TRANSITION", "INVALID_STATE_COMBINATION", "CHANGE_REASON_REQUIRED"].includes(error.message)) {
      return res.status(400).json({ error: "주문·결제 상태 조합을 확인해 주세요." });
    }
    if (error.message === "PII_UPDATE_FORBIDDEN") {
      return res.status(400).json({
        error: "주문 개인정보는 개인정보 수정 기능에서만 변경할 수 있습니다.",
        reason: "ORDER_PII_UPDATE_FORBIDDEN",
      });
    }
    return res.status(500).json({ error: "주문 수정 중 오류가 발생했습니다." });
  }
  const updated = getOrder(existing.id);
  if (req.body.status === "준비완료" && existing.status !== "준비완료") {
    notifyOrderReady(getOperationalOrder(existing.id)).catch(() => null);
  }
  res.json(updated);
});

function recordBlockedOrderDeleteSafely({ entityId, previousValue, reason, actor, message }) {
  try {
    addAuditLog({
      category: "SECURITY", action: "destructive_action_blocked", entityId,
      previousValue, nextValue: reason, actor, createdAt: new Date().toISOString(), message,
    });
  } catch {
    // The destructive action remains blocked even when its audit record cannot be written.
  }
}

router.delete("/:id", requireAuth, requirePermission("orders:write"), (req, res) => {
  const actor = getActorLabel(req);
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!current) {
      db.exec("ROLLBACK");
      return res.status(404).json({ error: "주문을 찾을 수 없습니다.", reason: "NOT_FOUND" });
    }
    const payment = db.prepare("SELECT status FROM payments WHERE order_id=?").get(current.id);
    const historyCount = db.prepare("SELECT COUNT(*) AS count FROM order_status_history WHERE order_id=?").get(current.id).count;
    const productionCount = db.prepare("SELECT COUNT(*) AS count FROM production_completions WHERE order_id=?").get(current.id).count;
    let reason = null;
    let message = null;
    if (payment) {
      reason = "PAYMENT_HISTORY_EXISTS";
      message = "결제 이력이 있는 주문은 삭제할 수 없습니다.";
    } else if (historyCount > 0) {
      reason = "ORDER_HISTORY_EXISTS";
      message = "상태 변경 이력이 있는 주문은 삭제할 수 없습니다.";
    } else if (productionCount > 0
      || !Number.isFinite(Date.parse(current.created_at))
      || Date.now() - Date.parse(current.created_at) > 24 * 60 * 60 * 1000
      || current.status !== "접수대기"
      || current.workflow_status !== "결제대기"
      || current.payment_status !== "결제대기"
      || !["생산 대기", null].includes(current.production_status)
      || ![null, "픽업대기", "배송대기"].includes(current.logistics_status)) {
      reason = "INVALID_DELETE_STATE";
      message = "처리가 시작된 주문은 삭제할 수 없습니다.";
    }
    if (reason) {
      db.exec("ROLLBACK");
      recordBlockedOrderDeleteSafely({
        entityId: current.id, previousValue: current.status, reason, actor,
        message: `${current.id} order deletion blocked: ${reason}`,
      });
      return res.status(409).json({ error: message, reason });
    }
    const deleted = db.prepare("DELETE FROM orders WHERE id = ?").run(current.id);
    if (deleted.changes !== 1) throw new Error("CONCURRENT_STATE_CHANGE");
    addAuditLog({
      category: "ORDER", action: "order_deleted", entityId: current.id,
      previousValue: current.status, nextValue: "DELETED", actor, createdAt: now,
      message: `${current.id} unused initial order deleted`,
    });
    db.exec("COMMIT");
    return res.json({ ok: true });
  } catch {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "주문 삭제를 완료하지 못했습니다." });
  }
});

router.delete("/", requireAuth, requirePermission("orders:write"), (req, res) => {
  recordBlockedOrderDeleteSafely({
    entityId: "orders", previousValue: "retained", reason: "DESTRUCTIVE_ACTION_DISABLED",
    actor: getActorLabel(req), message: "Bulk order deletion blocked",
  });
  res.status(405).json({
    error: "운영 주문 전체 삭제 기능은 비활성화되어 있습니다.",
    reason: "DESTRUCTIVE_ACTION_DISABLED",
  });
});

module.exports = router;
