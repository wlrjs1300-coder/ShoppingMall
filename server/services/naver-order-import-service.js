const crypto = require("node:crypto");
const { canonicalize, encryptPii, maskName, maskPhone } = require("../lib/pii-crypto");

const POSITIVE_ID = /^[1-9]\d*$/;

class NaverOrderImportError extends Error {
  constructor(code, safeMessage = "네이버 주문 정보를 처리하지 못했습니다.") {
    super(safeMessage);
    this.name = "NaverOrderImportError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

function externalId(value, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
    return null;
  }
  // Even safe numeric values have already lost their original lexical form.
  if (typeof value !== "string" || !POSITIVE_ID.test(value)) {
    throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
  }
  return value;
}

function optionalText(value, maximum = 4000) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
  }
  return value.trim() || null;
}

function externalTextId(value, maximum = 1000) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
  }
  return value;
}

function nonNegativeInteger(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
  }
  return value;
}

function dateTime(value, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
    return null;
  }
  const match = typeof value === "string" && value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) {
    throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
  }
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const validCalendar = calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
    && calendar.getUTCHours() === hour && calendar.getUTCMinutes() === minute
    && calendar.getUTCSeconds() === second;
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!validCalendar || (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59))) {
    throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
  }
  // Preserve the provider's original offset-bearing representation.
  return value;
}

function normalizeChangeFeedItem(raw) {
  if (!raw || typeof raw !== "object") throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
  return {
    orderId: externalId(raw.orderId, { required: true }),
    productOrderId: externalId(raw.productOrderId, { required: true }),
    lastChangedType: optionalText(raw.lastChangedType, 250),
    lastChangedAt: dateTime(raw.lastChangedDate, { required: true }),
    paymentAt: dateTime(raw.paymentDate),
    productOrderStatus: optionalText(raw.productOrderStatus, 250),
    claimType: optionalText(raw.claimType, 250),
    claimStatus: optionalText(raw.claimStatus, 250),
    receiverAddressChanged: raw.receiverAddressChanged === true,
  };
}

function currentClaim(productOrder) {
  const claim = productOrder?.currentClaim;
  if (!claim || typeof claim !== "object") return {};
  for (const type of ["cancel", "return", "exchange"]) {
    if (claim[type] && typeof claim[type] === "object") {
      return { type: type.toUpperCase(), value: claim[type] };
    }
  }
  return {};
}

function normalizeDetailedProductOrder(raw, feedItem = null) {
  if (!raw || typeof raw !== "object" || !raw.order || !raw.productOrder) {
    throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
  }
  const order = raw.order;
  const product = raw.productOrder;
  const orderId = externalId(order.orderId, { required: true });
  const productOrderId = externalId(product.productOrderId, { required: true });
  if (feedItem && (feedItem.orderId !== orderId || feedItem.productOrderId !== productOrderId)) {
    throw new NaverOrderImportError("NAVER_ORDER_IDENTIFIER_MISMATCH");
  }
  const claim = currentClaim(product);
  const claimValue = claim.value || {};
  const shipping = product.shippingAddress && typeof product.shippingAddress === "object"
    ? product.shippingAddress : {};
  const sourceChangedAt = feedItem?.lastChangedAt
    || dateTime(product.lastChangedDate)
    || dateTime(order.orderDate, { required: true });
  const orderPii = {
    ordererName: optionalText(order.ordererName, 300),
    ordererPhone: optionalText(order.ordererTel, 45),
  };
  const itemPii = {
    recipientName: optionalText(shipping.name, 150),
    recipientPhone: optionalText(shipping.tel1, 45),
    postalCode: optionalText(shipping.zipCode, 45),
    baseAddress: optionalText(shipping.baseAddress, 300),
    detailedAddress: optionalText(shipping.detailedAddress, 300),
    shippingMemo: optionalText(product.shippingMemo, 4000),
    entryMethod: optionalText(shipping.entryMethod, 250),
    entryMethodContent: optionalText(shipping.entryMethodContent, 300),
  };
  return {
    header: {
      externalOrderId: orderId,
      importStatus: "IMPORTED",
      externalPaymentStatus: optionalText(order.paymentStatus, 250),
      paymentMethod: optionalText(order.paymentMeans, 300),
      orderAmount: nonNegativeInteger(order.totalOrderAmount ?? product.totalProductAmount),
      paymentAmount: nonNegativeInteger(order.totalPaymentAmount ?? product.totalPaymentAmount),
      orderedAt: dateTime(order.orderDate, { required: true }),
      paidAt: dateTime(order.paymentDate),
      sourceChangedAt,
      pii: orderPii,
      ordererNameMasked: maskName(orderPii.ordererName),
      ordererPhoneMasked: maskPhone(orderPii.ordererPhone),
    },
    item: {
      externalOrderId: orderId,
      externalProductOrderId: productOrderId,
      externalChannelProductNo: externalId(product.productId),
      externalOriginProductNo: externalId(product.originalProductId),
      externalClaimId: externalId(claimValue.claimId ?? product.claimId),
      groupProductId: externalId(product.groupProductId),
      packageNumber: externalId(product.packageNumber),
      itemNo: externalTextId(product.itemNo),
      optionManageCode: externalTextId(product.optionManageCode),
      sellerProductCode: externalTextId(product.sellerProductCode),
      productNameSnapshot: optionalText(product.productName, 4000),
      optionNameSnapshot: optionalText(product.productOption, 4000),
      initialQuantity: nonNegativeInteger(product.initialQuantity ?? product.quantity),
      remainingQuantity: nonNegativeInteger(product.remainQuantity),
      unitPrice: nonNegativeInteger(product.unitPrice),
      initialPaymentAmount: nonNegativeInteger(product.initialPaymentAmount ?? product.totalPaymentAmount),
      remainingPaymentAmount: nonNegativeInteger(product.remainPaymentAmount),
      externalProductOrderStatus: optionalText(product.productOrderStatus, 250),
      externalClaimType: optionalText(product.claimType, 250) || claim.type || null,
      externalClaimStatus: optionalText(product.claimStatus, 250) || optionalText(claimValue.claimStatus, 250),
      lastChangedType: feedItem?.lastChangedType || null,
      sourceChangedAt,
      pii: itemPii,
      recipientNameMasked: maskName(itemPii.recipientName),
      recipientPhoneMasked: maskPhone(itemPii.recipientPhone),
    },
  };
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}

function compareSnapshot(existing, sourceChangedAt, payloadHash) {
  if (!existing) return "insert";
  const incoming = Date.parse(sourceChangedAt);
  const current = Date.parse(existing.source_changed_at);
  if (!Number.isFinite(incoming) || !Number.isFinite(current)) {
    throw new NaverOrderImportError("NAVER_ORDER_TIMESTAMP_INVALID");
  }
  if (incoming < current) return "stale";
  if (incoming === current) return existing.payload_hash === payloadHash ? "noop" : "conflict";
  return "update";
}

function resolveProductMapping(db, externalChannelProductNo) {
  if (!externalChannelProductNo) return {
    productMappingId: null, internalProductId: null, mappingStatus: "UNMAPPED",
  };
  const mapping = db.prepare(`SELECT id, internal_product_id FROM sales_channel_product_mappings
    WHERE channel='naver' AND external_channel_product_no=? AND mapping_status='ACTIVE'`).get(externalChannelProductNo);
  return mapping
    ? { productMappingId: mapping.id, internalProductId: mapping.internal_product_id, mappingStatus: "MAPPED" }
    : { productMappingId: null, internalProductId: null, mappingStatus: "UNMAPPED" };
}

function audit(db, actor, action, entityId, previousValue, nextValue, detail) {
  db.prepare(`INSERT INTO activity_logs
    (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
    VALUES (?, 'INTEGRATION', ?, 'sales-channels', ?, ?, ?, ?, ?, ?)`).run(
    `activity-${crypto.randomUUID()}`,
    JSON.stringify(detail),
    action,
    entityId,
    previousValue,
    nextValue,
    actor || "system",
    new Date().toISOString(),
  );
}

function encryptedColumns(pii, cryptoOptions) {
  if (!Object.values(pii).some(Boolean)) {
    return { ciphertext: null, iv: null, authTag: null, keyVersion: null };
  }
  return encryptPii(pii, cryptoOptions);
}

function createNaverOrderImportRepository({ db, piiKey, piiKeyVersion = "v1" }) {
  function validateHeaderItems(header, items) {
    if (!header || !Array.isArray(items) || !items.length) {
      throw new NaverOrderImportError("NAVER_ORDER_IMPORT_INVALID");
    }
    if (typeof header.externalOrderId !== "string"
      || items.some((item) => !item || typeof item.externalOrderId !== "string"
        || item.externalOrderId !== header.externalOrderId)) {
      throw new NaverOrderImportError("NAVER_ORDER_HEADER_CONFLICT");
    }
  }

  function upsertOrderImport({ header, items, actor = "system" }) {
    validateHeaderItems(header, items);
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      validateHeaderItems(header, items);
      let headerRow = db.prepare(`SELECT * FROM sales_channel_order_imports
        WHERE channel='naver' AND external_order_id=?`).get(header.externalOrderId);
      const previousHeaderStatus = headerRow?.import_status ?? null;
      const headerHash = canonicalHash({ ...header, pii: header.pii });
      const headerDecision = compareSnapshot(headerRow, header.sourceChangedAt, headerHash);
      let headerChanged = false;
      let appliedHeaderStatus = previousHeaderStatus;
      if (headerDecision === "insert") {
        const encrypted = encryptedColumns(header.pii, { key: piiKey, keyVersion: piiKeyVersion });
        const id = `channel-order-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO sales_channel_order_imports (
          id, channel, external_order_id, import_status, external_payment_status, payment_method,
          order_amount, payment_amount, ordered_at, paid_at, orderer_name_masked, orderer_phone_masked,
          order_pii_ciphertext, order_pii_iv, order_pii_auth_tag, order_pii_key_version,
          source_changed_at, last_synced_at, payload_hash, created_at, updated_at
        ) VALUES (?, 'naver', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, header.externalOrderId, header.importStatus, header.externalPaymentStatus,
          header.paymentMethod, header.orderAmount, header.paymentAmount, header.orderedAt, header.paidAt,
          header.ordererNameMasked, header.ordererPhoneMasked, encrypted.ciphertext, encrypted.iv,
          encrypted.authTag, encrypted.keyVersion, header.sourceChangedAt, now, headerHash, now, now,
        );
        headerRow = db.prepare("SELECT * FROM sales_channel_order_imports WHERE id=?").get(id);
        headerChanged = true;
        appliedHeaderStatus = header.importStatus;
      } else if (headerDecision === "update") {
        const encrypted = encryptedColumns(header.pii, { key: piiKey, keyVersion: piiKeyVersion });
        db.prepare(`UPDATE sales_channel_order_imports SET
          import_status=?, external_payment_status=?, payment_method=?, order_amount=?, payment_amount=?,
          ordered_at=?, paid_at=?, orderer_name_masked=?, orderer_phone_masked=?,
          order_pii_ciphertext=?, order_pii_iv=?, order_pii_auth_tag=?, order_pii_key_version=?,
          source_changed_at=?, last_synced_at=?, payload_hash=?, last_error_code=NULL, updated_at=?
          WHERE id=?`).run(
          header.importStatus, header.externalPaymentStatus, header.paymentMethod, header.orderAmount,
          header.paymentAmount, header.orderedAt, header.paidAt, header.ordererNameMasked,
          header.ordererPhoneMasked, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
          encrypted.keyVersion, header.sourceChangedAt, now, headerHash, now, headerRow.id,
        );
        headerChanged = true;
        appliedHeaderStatus = header.importStatus;
      } else if (headerDecision === "conflict") {
        db.prepare(`UPDATE sales_channel_order_imports SET import_status='MANUAL_REVIEW',
          last_error_code='SNAPSHOT_CONFLICT', last_synced_at=?, updated_at=? WHERE id=?`)
          .run(now, now, headerRow.id);
        headerChanged = true;
        appliedHeaderStatus = "MANUAL_REVIEW";
      }

      const itemResults = [];
      for (const item of items) {
        const mapping = resolveProductMapping(db, item.externalChannelProductNo);
        const itemHash = canonicalHash(item);
        const existing = db.prepare(`SELECT * FROM sales_channel_order_import_items
          WHERE channel='naver' AND external_product_order_id=?`).get(item.externalProductOrderId);
        if (existing && existing.channel_order_import_id !== headerRow.id) {
          throw new NaverOrderImportError("NAVER_PRODUCT_ORDER_HEADER_CONFLICT");
        }
        const decision = compareSnapshot(existing, item.sourceChangedAt, itemHash);
        if (decision === "insert") {
          const encrypted = encryptedColumns(item.pii, { key: piiKey, keyVersion: piiKeyVersion });
          const id = `channel-order-item-${crypto.randomUUID()}`;
          db.prepare(`INSERT INTO sales_channel_order_import_items (
            id, channel, channel_order_import_id, external_product_order_id,
            external_channel_product_no, external_origin_product_no, external_claim_id,
            external_group_product_id, external_package_number, external_item_no,
            external_option_manage_code,
            product_mapping_id, internal_product_id, product_name_snapshot, option_name_snapshot,
            seller_product_code, initial_quantity, remaining_quantity, unit_price,
            initial_payment_amount, remaining_payment_amount, external_product_order_status,
            external_claim_type, external_claim_status, last_changed_type, source_changed_at,
            recipient_name_masked, recipient_phone_masked, item_pii_ciphertext, item_pii_iv,
            item_pii_auth_tag, item_pii_key_version, mapping_status, payload_hash, created_at, updated_at
          ) VALUES (?, 'naver', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id, headerRow.id, item.externalProductOrderId, item.externalChannelProductNo,
            item.externalOriginProductNo, item.externalClaimId, item.groupProductId,
            item.packageNumber, item.itemNo, item.optionManageCode, mapping.productMappingId,
            mapping.internalProductId, item.productNameSnapshot, item.optionNameSnapshot,
            item.sellerProductCode, item.initialQuantity, item.remainingQuantity, item.unitPrice,
            item.initialPaymentAmount, item.remainingPaymentAmount, item.externalProductOrderStatus,
            item.externalClaimType, item.externalClaimStatus, item.lastChangedType, item.sourceChangedAt,
            item.recipientNameMasked, item.recipientPhoneMasked, encrypted.ciphertext, encrypted.iv,
            encrypted.authTag, encrypted.keyVersion, mapping.mappingStatus, itemHash, now, now,
          );
        } else if (decision === "update") {
          const encrypted = encryptedColumns(item.pii, { key: piiKey, keyVersion: piiKeyVersion });
          db.prepare(`UPDATE sales_channel_order_import_items SET
            external_channel_product_no=?, external_origin_product_no=?, external_claim_id=?,
            external_group_product_id=?, external_package_number=?, external_item_no=?,
            external_option_manage_code=?,
            product_mapping_id=?, internal_product_id=?, product_name_snapshot=?, option_name_snapshot=?,
            seller_product_code=?, initial_quantity=?, remaining_quantity=?, unit_price=?,
            initial_payment_amount=?, remaining_payment_amount=?, external_product_order_status=?,
            external_claim_type=?, external_claim_status=?, last_changed_type=?, source_changed_at=?,
            recipient_name_masked=?, recipient_phone_masked=?, item_pii_ciphertext=?, item_pii_iv=?,
            item_pii_auth_tag=?, item_pii_key_version=?, mapping_status=?, payload_hash=?,
            last_error_code=NULL, updated_at=? WHERE id=?`).run(
            item.externalChannelProductNo, item.externalOriginProductNo, item.externalClaimId,
            item.groupProductId, item.packageNumber, item.itemNo, item.optionManageCode,
            mapping.productMappingId, mapping.internalProductId, item.productNameSnapshot,
            item.optionNameSnapshot, item.sellerProductCode, item.initialQuantity,
            item.remainingQuantity, item.unitPrice, item.initialPaymentAmount,
            item.remainingPaymentAmount, item.externalProductOrderStatus, item.externalClaimType,
            item.externalClaimStatus, item.lastChangedType, item.sourceChangedAt,
            item.recipientNameMasked, item.recipientPhoneMasked, encrypted.ciphertext, encrypted.iv,
            encrypted.authTag, encrypted.keyVersion, mapping.mappingStatus, itemHash, now, existing.id,
          );
        } else if (decision === "noop"
          && (existing.product_mapping_id !== mapping.productMappingId
            || existing.internal_product_id !== mapping.internalProductId
            || existing.mapping_status !== mapping.mappingStatus)) {
          db.prepare(`UPDATE sales_channel_order_import_items SET
            product_mapping_id=?, internal_product_id=?, mapping_status=?, updated_at=?
            WHERE id=?`).run(
            mapping.productMappingId, mapping.internalProductId, mapping.mappingStatus, now, existing.id,
          );
          itemResults.push({
            externalProductOrderId: item.externalProductOrderId,
            outcome: "mapping_update",
          });
          continue;
        } else if (decision === "conflict") {
          db.prepare(`UPDATE sales_channel_order_import_items SET last_error_code='SNAPSHOT_CONFLICT',
            updated_at=? WHERE id=?`).run(now, existing.id);
          db.prepare(`UPDATE sales_channel_order_imports SET import_status='MANUAL_REVIEW',
            last_error_code='SNAPSHOT_CONFLICT', updated_at=? WHERE id=?`).run(now, headerRow.id);
          appliedHeaderStatus = "MANUAL_REVIEW";
        }
        itemResults.push({ externalProductOrderId: item.externalProductOrderId, outcome: decision });
      }

      if (headerChanged || itemResults.some((result) => !["noop", "stale"].includes(result.outcome))) {
        audit(db, actor, "naver_order_import_upserted", headerRow.id,
          previousHeaderStatus,
          appliedHeaderStatus,
          { externalOrderId: `***${header.externalOrderId.slice(-4)}`, itemCount: items.length },
        );
      }
      db.exec("COMMIT");
      return { id: headerRow.id, outcome: headerDecision, items: itemResults };
    } catch (error) {
      db.exec("ROLLBACK");
      if (error instanceof NaverOrderImportError) throw error;
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new NaverOrderImportError("NAVER_ORDER_IMPORT_CONFLICT");
      }
      throw new NaverOrderImportError("NAVER_ORDER_IMPORT_WRITE_FAILED");
    }
  }
  return { upsertOrderImport };
}

module.exports = {
  NaverOrderImportError,
  canonicalHash,
  compareSnapshot,
  createNaverOrderImportRepository,
  dateTime,
  externalId,
  externalTextId,
  nonNegativeInteger,
  normalizeChangeFeedItem,
  normalizeDetailedProductOrder,
  resolveProductMapping,
};
