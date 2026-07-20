const path = require("node:path");

const PLACEHOLDER_RE = /여기에_|your-domain|your-app|change-in-production|xxxxxxxx/i;
const DEMO_ADMIN_CODES = new Set(["portfolio-admin", "admin", "admin123", "Admin123!"]);

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function productionConfigErrors(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const errors = [];
  const required = ["ADMIN_CODE", "JWT_SECRET", "AUTH_CODE_PEPPER", "ALLOWED_ORIGIN", "PUBLIC_BASE_URL", "DB_PATH"];
  for (const key of required) {
    if (!env[key] || PLACEHOLDER_RE.test(env[key])) errors.push(`${key}가 설정되지 않았습니다.`);
  }
  if (env.JWT_SECRET && Buffer.byteLength(env.JWT_SECRET) < 32) errors.push("JWT_SECRET은 32바이트 이상이어야 합니다.");
  if (env.AUTH_CODE_PEPPER && Buffer.byteLength(env.AUTH_CODE_PEPPER) < 32) errors.push("AUTH_CODE_PEPPER는 32바이트 이상이어야 합니다.");
  if (env.ADMIN_CODE && (Buffer.byteLength(env.ADMIN_CODE) < 12 || DEMO_ADMIN_CODES.has(env.ADMIN_CODE))) {
    errors.push("ADMIN_CODE는 공개된 데모 값이 아닌 12바이트 이상의 값이어야 합니다.");
  }
  for (const key of ["ALLOWED_ORIGIN", "PUBLIC_BASE_URL"]) {
    const values = key === "ALLOWED_ORIGIN" ? String(env[key] || "").split(",").map((value) => value.trim()).filter(Boolean) : [env[key]];
    if (values.some((value) => !isHttpsUrl(value))) errors.push(`${key}는 유효한 HTTPS 주소여야 합니다.`);
  }
  if (env.DB_PATH && (!path.isAbsolute(env.DB_PATH) || env.DB_PATH === ":memory:")) errors.push("DB_PATH는 영구 볼륨의 절대 경로여야 합니다.");
  if (env.NOTIFICATION_MODE === "sms" && !["SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER_PHONE"].every((key) => env[key])) {
    errors.push("SMS 알림 사용 시 SOLAPI 설정 3개가 모두 필요합니다.");
  }
  if (env.RESEND_API_KEY && !env.PASSWORD_RESET_FROM) errors.push("RESEND_API_KEY 사용 시 PASSWORD_RESET_FROM이 필요합니다.");
  if (env.TOSS_MOCK_MODE === "true") errors.push("운영 환경에서는 TOSS_MOCK_MODE를 사용할 수 없습니다.");
  if (env.PUBLIC_BASE_URL && env.ALLOWED_ORIGIN) {
    const baseOrigin = (() => { try { return new URL(env.PUBLIC_BASE_URL).origin; } catch { return ""; } })();
    const allowed = String(env.ALLOWED_ORIGIN).split(",").map((value) => value.trim());
    if (baseOrigin && !allowed.includes(baseOrigin)) errors.push("PUBLIC_BASE_URL의 출처가 ALLOWED_ORIGIN에 포함되어야 합니다.");
  }
  return errors;
}

function assertProductionConfig(env = process.env) {
  const errors = productionConfigErrors(env);
  if (errors.length) throw new Error(`[환경설정] 서버 시작 중단\n- ${errors.join("\n- ")}`);
}

module.exports = { assertProductionConfig, productionConfigErrors };
