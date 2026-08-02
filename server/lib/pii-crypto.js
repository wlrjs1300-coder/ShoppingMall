const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

class PiiCryptoError extends Error {
  constructor(code, message = "개인정보 암호화 데이터를 처리하지 못했습니다.") {
    super(message);
    this.name = "PiiCryptoError";
    this.code = code;
    this.safeMessage = message;
  }
}

function canonicalize(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PiiCryptoError("PII_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new PiiCryptoError("PII_VALUE_INVALID");
  if (ancestors.has(value)) throw new PiiCryptoError("PII_VALUE_INVALID");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) {
    throw new PiiCryptoError("PII_VALUE_INVALID");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (!Number.isSafeInteger(value.length) || value.length < 0) {
        throw new PiiCryptoError("PII_VALUE_INVALID");
      }
      const keys = Object.keys(value);
      if (keys.length !== value.length
        || keys.some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        throw new PiiCryptoError("PII_VALUE_INVALID");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, String(index))) {
          throw new PiiCryptoError("PII_VALUE_INVALID");
        }
      }
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(",")}]`;
    }
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`,
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function parsePiiKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new PiiCryptoError("PII_KEY_INVALID");
    return Buffer.from(value);
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new PiiCryptoError("PII_KEY_INVALID");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new PiiCryptoError("PII_KEY_INVALID");
  return key;
}

function encryptPii(value, { key, keyVersion }) {
  const parsedKey = parsePiiKey(key);
  if (typeof keyVersion !== "string" || !keyVersion.trim() || keyVersion.length > 100) {
    throw new PiiCryptoError("PII_KEY_VERSION_INVALID");
  }
  try {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, parsedKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(canonicalize(value), "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: keyVersion.trim(),
    };
  } catch (error) {
    if (error instanceof PiiCryptoError) throw error;
    throw new PiiCryptoError("PII_ENCRYPTION_FAILED");
  }
}

function decryptPii(encrypted, { key }) {
  const parsedKey = parsePiiKey(key);
  if (!encrypted || !["ciphertext", "iv", "authTag", "keyVersion"].every(
    (field) => typeof encrypted[field] === "string" && encrypted[field],
  )) throw new PiiCryptoError("PII_ENCRYPTED_DATA_INVALID");
  try {
    const decode = (value) => {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error("invalid encoding");
      }
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64") !== value) throw new Error("invalid encoding");
      return decoded;
    };
    const iv = decode(encrypted.iv);
    const authTag = decode(encrypted.authTag);
    const ciphertext = decode(encrypted.ciphertext);
    if (iv.length !== IV_BYTES || authTag.length !== 16) throw new Error("invalid encrypted data");
    const decipher = crypto.createDecipheriv(ALGORITHM, parsedKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    throw new PiiCryptoError("PII_AUTHENTICATION_FAILED");
  }
}

function maskName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return null;
  if (name.length === 1) return `${name}*`;
  if (name.length === 2) return `${name[0]}*`;
  return `${name[0]}${"*".repeat(name.length - 2)}${name.at(-1)}`;
}

function maskPhone(value) {
  const phone = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (!phone) return null;
  if (phone.length < 7) return "*".repeat(phone.length);
  return `${phone.slice(0, 3)}-${"*".repeat(Math.max(4, phone.length - 7))}-${phone.slice(-4)}`;
}

module.exports = {
  PiiCryptoError,
  canonicalize,
  decryptPii,
  encryptPii,
  maskName,
  maskPhone,
  parsePiiKey,
};
