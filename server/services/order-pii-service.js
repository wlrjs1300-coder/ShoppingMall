const {
  PiiCryptoError,
  decryptPii,
  encryptPii,
  maskName,
  maskPhone,
} = require("../lib/pii-crypto");
const {
  PiiKeyringError,
  getDefaultOrderPiiKeyring,
  getPiiKey,
  isOrderPiiProtectionEnabled,
} = require("../lib/pii-keyring");

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

function buildOrderPiiStorage(value) {
  const pii = normalizeOrderPii(value);
  if (!isOrderPiiProtectionEnabled()) {
    return {
      customerName: pii.customerName,
      customerPhone: pii.customerPhone,
      deliveryAddress: pii.deliveryAddress,
      guestAddress: pii.guestAddress,
      piiCiphertext: null,
      piiIv: null,
      piiAuthTag: null,
      piiKeyVersion: null,
      customerNameMasked: null,
      customerPhoneMasked: null,
      deliveryRegionMasked: null,
      piiMigratedAt: null,
    };
  }
  let keyring;
  try {
    keyring = getDefaultOrderPiiKeyring();
  } catch (error) {
    if (error instanceof PiiKeyringError) {
      throw new OrderPiiError("ORDER_PII_ENCRYPTION_FAILED");
    }
    throw error;
  }
  return {
    customerName: "[protected]",
    customerPhone: "[protected]",
    deliveryAddress: null,
    guestAddress: null,
    ...buildOrderPiiColumns(pii, keyring, null),
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

function readOrderPiiForOperation(row, keyring) {
  const tupleValues = ["pii_ciphertext", "pii_iv", "pii_auth_tag", "pii_key_version"]
    .map((field) => row?.[field]);
  const hasAnyEncryptedValue = tupleValues.some(
    (value) => value !== null && value !== undefined && value !== "",
  );
  if (!hasAnyEncryptedValue) return normalizeLegacyOrderPii(row);
  if (!hasEncryptedTuple(row)) throw new OrderPiiError("ORDER_PII_ENCRYPTED_DATA_INVALID");
  let resolvedKeyring = keyring;
  try {
    resolvedKeyring ||= getDefaultOrderPiiKeyring();
  } catch (error) {
    if (error instanceof PiiKeyringError) {
      throw new OrderPiiError(
        error.code === "ORDER_PII_NOT_CONFIGURED"
          ? "ORDER_PII_NOT_CONFIGURED"
          : "ORDER_PII_ACCESS_FAILED",
      );
    }
    throw error;
  }
  return decryptOrderPii(row, resolvedKeyring);
}

function buildMaskedOrderIdentity(row, keyring) {
  const pii = readOrderPiiForOperation(row, keyring);
  return {
    customerNameMasked: maskName(pii.customerName),
    customerPhoneMasked: maskPhone(pii.customerPhone),
    deliveryRegionMasked: null,
  };
}

function applyMaskedOrderFields(order, identity) {
  return {
    ...order,
    customer: identity.customerNameMasked,
    phone: identity.customerPhoneMasked,
    deliveryAddress: null,
    customerNameMasked: identity.customerNameMasked,
    customerPhoneMasked: identity.customerPhoneMasked,
    deliveryRegionMasked: null,
  };
}

function buildOrderPiiApiFields(row, { includeAddress = true } = {}) {
  const pii = readOrderPiiForOperation(row);
  if (!isOrderPiiProtectionEnabled()) {
    return {
      customer: pii.customerName,
      phone: pii.customerPhone,
      ...(includeAddress ? { deliveryAddress: pii.deliveryAddress } : {}),
    };
  }
  const identity = {
    customerNameMasked: maskName(pii.customerName),
    customerPhoneMasked: maskPhone(pii.customerPhone),
    deliveryRegionMasked: null,
  };
  const fields = {
    customer: identity.customerNameMasked,
    phone: identity.customerPhoneMasked,
    customerNameMasked: identity.customerNameMasked,
    customerPhoneMasked: identity.customerPhoneMasked,
    deliveryRegionMasked: null,
  };
  if (includeAddress) fields.deliveryAddress = null;
  return fields;
}

module.exports = {
  OrderPiiError,
  applyMaskedOrderFields,
  buildOrderPiiApiFields,
  buildOrderPiiColumns,
  buildOrderPiiStorage,
  buildMaskedOrderIdentity,
  decryptOrderPii,
  encryptOrderPii,
  maskDeliveryRegion,
  maskOrderPii,
  normalizeLegacyOrderPii,
  normalizeOrderPii,
  readOrderPii,
  readOrderPiiForOperation,
};
