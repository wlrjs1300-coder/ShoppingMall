const {
  PiiCryptoError,
  decryptPii,
  encryptPii,
  maskName,
  maskPhone,
} = require("../lib/pii-crypto");
const { PiiKeyringError, getPiiKey } = require("../lib/pii-keyring");

class OrderPiiError extends Error {
  constructor(code) {
    super("주문 개인정보를 안전하게 처리하지 못했습니다.");
    this.name = "OrderPiiError";
    this.code = code;
    this.safeMessage = this.message;
  }
}

function normalizeOptional(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new OrderPiiError("ORDER_PII_VALUE_INVALID");
  return value.trim() || null;
}

function normalizeOrderPii(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OrderPiiError("ORDER_PII_VALUE_INVALID");
  }
  const customerName = normalizeOptional(value.customerName);
  const customerPhone = normalizeOptional(value.customerPhone)?.replace(/\D/g, "") || null;
  const deliveryAddress = normalizeOptional(value.deliveryAddress);
  const guestAddress = normalizeOptional(value.guestAddress);
  if (!customerName || !customerPhone) throw new OrderPiiError("ORDER_PII_VALUE_INVALID");
  return { customerName, customerPhone, deliveryAddress, guestAddress };
}

function normalizeLegacyOrderPii(row) {
  const customerName = normalizeOptional(row?.customer_name);
  const customerPhone = normalizeOptional(row?.customer_phone)?.replace(/\D/g, "") || null;
  if (!customerName || !customerPhone) {
    throw new OrderPiiError("ORDER_PII_LEGACY_INCOMPLETE");
  }
  return {
    customerName,
    customerPhone,
    deliveryAddress: normalizeOptional(row?.delivery_address),
    guestAddress: normalizeOptional(row?.guest_address),
  };
}

function maskDeliveryRegion() {
  return null;
}

function maskOrderPii(value) {
  const pii = normalizeOrderPii(value);
  return {
    customerNameMasked: maskName(pii.customerName),
    customerPhoneMasked: maskPhone(pii.customerPhone),
    deliveryRegionMasked: null,
  };
}

function encryptOrderPii(value, keyring) {
  const pii = normalizeOrderPii(value);
  try {
    return encryptPii(pii, {
      key: getPiiKey(keyring, keyring?.activeVersion),
      keyVersion: keyring.activeVersion,
    });
  } catch (error) {
    if (error instanceof PiiCryptoError || error instanceof PiiKeyringError) {
      throw new OrderPiiError("ORDER_PII_ENCRYPTION_FAILED");
    }
    throw error;
  }
}

function decryptOrderPii(row, keyring) {
  const fields = ["pii_ciphertext", "pii_iv", "pii_auth_tag", "pii_key_version"];
  const present = fields.map((field) => typeof row?.[field] === "string" && row[field] !== "");
  if (!present.every(Boolean)) throw new OrderPiiError("ORDER_PII_ENCRYPTED_DATA_INVALID");
  try {
    const result = decryptPii({
      ciphertext: row.pii_ciphertext,
      iv: row.pii_iv,
      authTag: row.pii_auth_tag,
      keyVersion: row.pii_key_version,
    }, { key: getPiiKey(keyring, row.pii_key_version) });
    return normalizeOrderPii(result);
  } catch (error) {
    if (error instanceof PiiCryptoError || error instanceof PiiKeyringError
      || error instanceof OrderPiiError) {
      throw new OrderPiiError("ORDER_PII_DECRYPTION_FAILED");
    }
    throw error;
  }
}

function buildOrderPiiColumns(value, keyring, migratedAt = null) {
  const encrypted = encryptOrderPii(value, keyring);
  return {
    piiCiphertext: encrypted.ciphertext,
    piiIv: encrypted.iv,
    piiAuthTag: encrypted.authTag,
    piiKeyVersion: encrypted.keyVersion,
    ...maskOrderPii(value),
    piiMigratedAt: migratedAt,
  };
}

function hasEncryptedTuple(row) {
  return ["pii_ciphertext", "pii_iv", "pii_auth_tag", "pii_key_version"]
    .every((field) => typeof row?.[field] === "string" && row[field] !== "");
}

function readOrderPii(row, keyring) {
  const tupleValues = ["pii_ciphertext", "pii_iv", "pii_auth_tag", "pii_key_version"]
    .map((field) => row?.[field]);
  if (tupleValues.some((value) => value !== null && value !== undefined && value !== "")) {
    if (!hasEncryptedTuple(row)) throw new OrderPiiError("ORDER_PII_ENCRYPTED_DATA_INVALID");
    return decryptOrderPii(row, keyring);
  }
  return normalizeLegacyOrderPii(row);
}

module.exports = {
  OrderPiiError,
  buildOrderPiiColumns,
  decryptOrderPii,
  encryptOrderPii,
  maskDeliveryRegion,
  maskOrderPii,
  normalizeLegacyOrderPii,
  normalizeOrderPii,
  readOrderPii,
};
