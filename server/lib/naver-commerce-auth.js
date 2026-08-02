const bcrypt = require("bcryptjs");

function validateTimestamp(timestamp) {
  return Number.isSafeInteger(timestamp) && timestamp > 0;
}

function createClientSecretSign({ clientId, clientSecret, timestamp } = {}) {
  if (typeof clientId !== "string" || !clientId.trim()) throw new TypeError("NAVER_CLIENT_ID_INVALID");
  if (typeof clientSecret !== "string" || !clientSecret.trim()) throw new TypeError("NAVER_CLIENT_SECRET_INVALID");
  if (!validateTimestamp(timestamp)) throw new TypeError("NAVER_TIMESTAMP_INVALID");
  const password = `${clientId.trim()}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  return Buffer.from(hashed, "utf8").toString("base64");
}

function createTimestamp(now = Date.now) {
  const timestamp = now();
  if (!validateTimestamp(timestamp)) throw new TypeError("NAVER_TIMESTAMP_INVALID");
  return timestamp;
}

module.exports = { createClientSecretSign, createTimestamp, validateTimestamp };
