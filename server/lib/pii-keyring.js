const { PiiCryptoError, parsePiiKey } = require("./pii-crypto");

const VERSION_RE = /^[A-Za-z0-9._-]{1,100}$/;

class PiiKeyringError extends Error {
  constructor(code) {
    super("개인정보 암호화 키 설정이 올바르지 않습니다.");
    this.name = "PiiKeyringError";
    this.code = code;
    this.safeMessage = this.message;
  }
}

function invalid(code) {
  throw new PiiKeyringError(code);
}

function parsePiiKeyring(keysJson, activeVersion) {
  if (typeof keysJson !== "string" || !keysJson.trim()) {
    invalid("ORDER_PII_KEYRING_MISSING");
  }
  if (typeof activeVersion !== "string" || !VERSION_RE.test(activeVersion.trim())) {
    invalid("ORDER_PII_ACTIVE_KEY_VERSION_INVALID");
  }

  let parsed;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    invalid("ORDER_PII_KEYRING_JSON_INVALID");
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    invalid("ORDER_PII_KEYRING_INVALID");
  }
  if (Object.keys(parsed).length !== parsed.length) invalid("ORDER_PII_KEYRING_INVALID");
  for (let index = 0; index < parsed.length; index += 1) {
    if (!Object.hasOwn(parsed, String(index))) invalid("ORDER_PII_KEYRING_INVALID");
  }

  const keys = new Map();
  for (const item of parsed) {
    if (!item || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) {
      invalid("ORDER_PII_KEYRING_ITEM_INVALID");
    }
    const fields = Object.keys(item);
    if (fields.length !== 2 || !fields.includes("version") || !fields.includes("key")) {
      invalid("ORDER_PII_KEYRING_ITEM_INVALID");
    }
    const { version, key } = item;
    if (typeof version !== "string" || !VERSION_RE.test(version)) {
      invalid("ORDER_PII_KEY_VERSION_INVALID");
    }
    if (keys.has(version)) invalid("ORDER_PII_KEY_VERSION_DUPLICATE");
    if (typeof key !== "string") invalid("ORDER_PII_KEY_INVALID");
    try {
      keys.set(version, parsePiiKey(key));
    } catch (error) {
      if (error instanceof PiiCryptoError) invalid("ORDER_PII_KEY_INVALID");
      throw error;
    }
  }

  const active = activeVersion.trim();
  if (!keys.has(active)) invalid("ORDER_PII_ACTIVE_KEY_UNKNOWN");
  return Object.freeze({
    activeVersion: active,
    hasVersion(version) {
      return typeof version === "string" && keys.has(version);
    },
    getKey(version) {
      if (typeof version !== "string" || !keys.has(version)) {
        invalid("ORDER_PII_KEY_VERSION_UNKNOWN");
      }
      return Buffer.from(keys.get(version));
    },
  });
}

function getPiiKey(keyring, version) {
  if (!keyring || typeof keyring.getKey !== "function") {
    invalid("ORDER_PII_KEY_VERSION_UNKNOWN");
  }
  return keyring.getKey(version);
}

function loadOrderPiiKeyring(env = process.env) {
  return parsePiiKeyring(env.ORDER_PII_KEYS_JSON, env.ORDER_PII_ACTIVE_KEY_VERSION);
}

let defaultOrderPiiKeyring;

function isOrderPiiProtectionEnabled(env = process.env) {
  return typeof env.ORDER_PII_PROTECTION_ENABLED === "string"
    && env.ORDER_PII_PROTECTION_ENABLED.trim().toLowerCase() === "true";
}

function getDefaultOrderPiiKeyring() {
  if (!isOrderPiiProtectionEnabled()) invalid("ORDER_PII_NOT_CONFIGURED");
  if (!defaultOrderPiiKeyring) defaultOrderPiiKeyring = loadOrderPiiKeyring(process.env);
  return defaultOrderPiiKeyring;
}

function resetOrderPiiKeyringForTest() {
  if (process.env.NODE_ENV !== "test") invalid("ORDER_PII_RESET_FORBIDDEN");
  defaultOrderPiiKeyring = undefined;
}

module.exports = {
  PiiKeyringError,
  getDefaultOrderPiiKeyring,
  getPiiKey,
  isOrderPiiProtectionEnabled,
  loadOrderPiiKeyring,
  parsePiiKeyring,
  resetOrderPiiKeyringForTest,
};
