const path = require("node:path");

const PLACEHOLDER_RE = /여기에_|your-domain|your-app|change-in-production|xxxxxxxx|example(?:\.com|\.net|\.org)/i;
const STORE_PHONE_PLACEHOLDER_RE = /000[-\s]?0000|^0{8,}$/;
const STORE_ADDRESS_PLACEHOLDER_RE = /화성시\s*소재|주소\s*예시|example|여기에_/i;
const DEMO_ADMIN_CODES = new Set(["portfolio-admin", "admin", "admin123", "Admin123!"]);
const NOTIFICATION_MODES = new Set(["none", "sms", "kakao"]);
const PAYMENT_MODES = new Set(["disabled", "toss"]);
const EMAIL_MODES = new Set(["disabled", "resend"]);
const SOLAPI_KEYS = ["SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER_PHONE"];
const KAKAO_NOTIFICATION_KEYS = [
  "KAKAO_PLUS_FRIEND_ID",
  "KAKAO_TEMPLATE_ORDER",
  "KAKAO_TEMPLATE_READY",
  "KAKAO_TEMPLATE_REMIND",
];
const PRODUCTION_FORBIDDEN_KEYS = [
  "DEMO_MODE",
  "PHONE_TEST_CODE",
  "PASSWORD_RESET_TEST_TOKEN",
  "ALLOW_PORTFOLIO_SEED",
];
const MINIMUM_NODE_VERSION = "22.16.0";

function parseNodeVersion(version) {
  const match = String(version || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function nodeVersionError(version, minimum = MINIMUM_NODE_VERSION) {
  const current = parseNodeVersion(version);
  const required = parseNodeVersion(minimum);
  if (!current || !required) {
    return `Node.js ${minimum} 이상이 필요합니다. 현재 버전: ${String(version || "알 수 없음")}`;
  }
  for (let index = 0; index < required.length; index += 1) {
    if (current[index] > required[index]) return null;
    if (current[index] < required[index]) {
      return `Node.js ${minimum} 이상이 필요합니다. 현재 버전: ${String(version).replace(/^v/, "")}`;
    }
  }
  return null;
}

function valueOf(env, key) {
  return typeof env[key] === "string" ? env[key].trim() : "";
}

function isConfigured(env, key) {
  return Boolean(valueOf(env, key));
}

function isPlaceholder(value) {
  return PLACEHOLDER_RE.test(String(value || ""));
}

function isForbiddenHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost"
    || host === "::1"
    || host === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(host)
    || /(^|\.)example\.(?:com|net|org)$/.test(host);
}

function parseProductionUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || isForbiddenHostname(parsed.hostname) || isPlaceholder(value)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hasValidSecret(env, key) {
  const value = valueOf(env, key);
  return Boolean(value) && !isPlaceholder(value);
}

function addMissingErrors(errors, env, keys, message) {
  if (!keys.every((key) => hasValidSecret(env, key))) errors.push(message);
}

function productionConfigErrors(env = process.env) {
  if (env.NODE_ENV !== "production") return [];

  const errors = [];
  const required = [
    "ADMIN_CODE",
    "JWT_SECRET",
    "AUTH_CODE_PEPPER",
    "ALLOWED_ORIGIN",
    "PUBLIC_BASE_URL",
    "DB_PATH",
    "STORE_NAME",
    "STORE_PHONE",
    "STORE_HOURS",
    "STORE_ADDRESS",
  ];
  for (const key of required) {
    if (!isConfigured(env, key) || isPlaceholder(env[key])) errors.push(`${key}가 설정되지 않았거나 예제값입니다.`);
  }

  if (isConfigured(env, "JWT_SECRET") && Buffer.byteLength(env.JWT_SECRET) < 32) errors.push("JWT_SECRET은 32바이트 이상이어야 합니다.");
  if (isConfigured(env, "AUTH_CODE_PEPPER") && Buffer.byteLength(env.AUTH_CODE_PEPPER) < 32) errors.push("AUTH_CODE_PEPPER는 32바이트 이상이어야 합니다.");
  if (isConfigured(env, "ADMIN_CODE")
    && (Buffer.byteLength(env.ADMIN_CODE) < 12 || DEMO_ADMIN_CODES.has(env.ADMIN_CODE))) {
    errors.push("ADMIN_CODE는 공개된 데모 값이 아닌 12바이트 이상의 값이어야 합니다.");
  }

  const publicBaseUrl = parseProductionUrl(valueOf(env, "PUBLIC_BASE_URL"));
  if (isConfigured(env, "PUBLIC_BASE_URL") && !publicBaseUrl) {
    errors.push("PUBLIC_BASE_URL은 localhost나 예제 도메인이 아닌 유효한 HTTPS 주소여야 합니다.");
  }
  const allowedOriginValues = valueOf(env, "ALLOWED_ORIGIN").split(",").map((item) => item.trim()).filter(Boolean);
  const allowedOrigins = allowedOriginValues.map(parseProductionUrl);
  if (isConfigured(env, "ALLOWED_ORIGIN")
    && (!allowedOriginValues.length || allowedOrigins.some((origin) => !origin)
      || allowedOrigins.some((origin, index) => origin.origin !== allowedOriginValues[index].replace(/\/$/, "")))) {
    errors.push("ALLOWED_ORIGIN은 localhost나 예제 도메인이 아닌 HTTPS 출처만 쉼표로 구분해 설정해야 합니다.");
  }
  if (publicBaseUrl && allowedOrigins.length && allowedOrigins.every(Boolean)
    && !allowedOrigins.some((origin) => origin.origin === publicBaseUrl.origin)) {
    errors.push("PUBLIC_BASE_URL의 출처가 ALLOWED_ORIGIN에 포함되어야 합니다.");
  }

  if (isConfigured(env, "DB_PATH") && (!path.isAbsolute(env.DB_PATH) || env.DB_PATH === ":memory:")) {
    errors.push("DB_PATH는 영구 볼륨의 절대경로여야 합니다.");
  }

  const repositoryRoot = path.resolve(__dirname, "..");
  const backupDir = valueOf(env, "BACKUP_DIR");
  if (!backupDir) {
    errors.push("BACKUP_DIR is required in production.");
  } else if (!path.isAbsolute(backupDir)) {
    errors.push("BACKUP_DIR must be an absolute path.");
  } else {
    const relative = path.relative(repositoryRoot, path.resolve(backupDir));
    if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      errors.push("BACKUP_DIR must be outside the Git repository.");
    }
    if (isConfigured(env, "DB_PATH") && path.resolve(backupDir) === path.dirname(path.resolve(env.DB_PATH))) {
      errors.push("BACKUP_DIR must not be the database directory.");
    }
  }
  for (const [key, fallback] of [["BACKUP_RETENTION_DAYS", "30"], ["BACKUP_MAX_FILES", "30"]]) {
    const value = valueOf(env, key) || fallback;
    if (!/^[1-9]\d*$/.test(value)) errors.push(`${key} must be a positive integer.`);
  }

  const normalizedPhone = valueOf(env, "STORE_PHONE").replace(/\D/g, "");
  if (isConfigured(env, "STORE_PHONE")
    && (STORE_PHONE_PLACEHOLDER_RE.test(valueOf(env, "STORE_PHONE")) || normalizedPhone.length < 9)) {
    errors.push("STORE_PHONE은 예제값이 아닌 실제 매장 전화번호여야 합니다.");
  }
  if (isConfigured(env, "STORE_ADDRESS") && STORE_ADDRESS_PLACEHOLDER_RE.test(valueOf(env, "STORE_ADDRESS"))) {
    errors.push("STORE_ADDRESS는 예제 문구가 아닌 실제 주소여야 합니다.");
  }

  const paymentMode = valueOf(env, "PAYMENT_MODE").toLowerCase();
  if (!PAYMENT_MODES.has(paymentMode)) {
    errors.push("PAYMENT_MODE는 disabled 또는 toss로 명시해야 합니다.");
  } else if (paymentMode === "toss") {
    addMissingErrors(errors, env, ["TOSS_CLIENT_KEY", "TOSS_SECRET_KEY"], "PAYMENT_MODE=toss이면 Toss 운영 키가 모두 필요합니다.");
    if ([env.TOSS_CLIENT_KEY, env.TOSS_SECRET_KEY].some((key) => /^test_/i.test(String(key || "").trim()))) {
      errors.push("PAYMENT_MODE=toss에서는 Toss 테스트 키를 사용할 수 없습니다.");
    }
    if (valueOf(env, "TOSS_MOCK_MODE").toLowerCase() !== "false") {
      errors.push("PAYMENT_MODE=toss에서는 TOSS_MOCK_MODE=false를 명시해야 합니다.");
    }
  }
  if (valueOf(env, "TOSS_MOCK_MODE").toLowerCase() === "true") {
    errors.push("운영 환경에서는 TOSS_MOCK_MODE=true를 사용할 수 없습니다.");
  }

  const notificationMode = valueOf(env, "NOTIFICATION_MODE").toLowerCase();
  if (!NOTIFICATION_MODES.has(notificationMode)) {
    errors.push("NOTIFICATION_MODE는 none, sms, kakao 중 하나여야 합니다.");
  } else if (notificationMode === "sms") {
    addMissingErrors(errors, env, SOLAPI_KEYS, "NOTIFICATION_MODE=sms이면 Solapi 설정 3개가 모두 필요합니다.");
  } else if (notificationMode === "kakao") {
    addMissingErrors(
      errors,
      env,
      [...SOLAPI_KEYS, ...KAKAO_NOTIFICATION_KEYS],
      "NOTIFICATION_MODE=kakao이면 Solapi 설정과 카카오 채널·주문·준비·리마인더 템플릿 ID가 모두 필요합니다.",
    );
  }

  const emailMode = valueOf(env, "EMAIL_MODE").toLowerCase();
  if (!EMAIL_MODES.has(emailMode)) {
    errors.push("EMAIL_MODE는 disabled 또는 resend로 명시해야 합니다.");
  } else if (emailMode === "resend") {
    addMissingErrors(errors, env, ["RESEND_API_KEY", "PASSWORD_RESET_FROM"], "EMAIL_MODE=resend이면 Resend 키와 발신주소가 모두 필요합니다.");
    const from = valueOf(env, "PASSWORD_RESET_FROM");
    const email = from.match(/<([^>]+)>/)?.[1] || from;
    if (from && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || isPlaceholder(email))) {
      errors.push("PASSWORD_RESET_FROM은 예제 도메인이 아닌 유효한 발신 이메일 주소여야 합니다.");
    }
  }

  for (const provider of ["GOOGLE", "KAKAO", "NAVER"]) {
    const idKey = `${provider}_CLIENT_ID`;
    const secretKey = `${provider}_CLIENT_SECRET`;
    const hasId = isConfigured(env, idKey);
    const hasSecret = isConfigured(env, secretKey);
    if (hasId !== hasSecret) {
      errors.push(`${provider} OAuth는 ${idKey}와 ${secretKey}를 함께 설정하거나 모두 비워야 합니다.`);
    } else if (hasId && (!hasValidSecret(env, idKey) || !hasValidSecret(env, secretKey))) {
      errors.push(`${provider} OAuth 설정에 예제값을 사용할 수 없습니다.`);
    }
  }

  for (const key of PRODUCTION_FORBIDDEN_KEYS) {
    if (isConfigured(env, key)) errors.push(`운영 환경에는 테스트·데모 전용 환경변수 ${key}를 설정할 수 없습니다.`);
  }
  for (const key of Object.keys(env)) {
    if (/^PORTFOLIO_(?:ADMIN|USER)_/.test(key) && isConfigured(env, key)) {
      errors.push(`운영 환경에는 포트폴리오 계정 환경변수 ${key}를 설정할 수 없습니다.`);
    }
  }

  return [...new Set(errors)];
}

function productionConfigWarnings(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const warnings = [];
  warnings.push("Confirm that production backup and restore drills are scheduled.");
  if (valueOf(env, "PAYMENT_MODE").toLowerCase() === "disabled") warnings.push("PAYMENT_MODE=disabled: 자체몰 Toss 결제가 비활성화되어 있습니다.");
  if (valueOf(env, "NOTIFICATION_MODE").toLowerCase() === "none") warnings.push("NOTIFICATION_MODE=none: 문자·알림톡이 비활성화되어 있습니다.");
  if (valueOf(env, "EMAIL_MODE").toLowerCase() === "disabled") warnings.push("EMAIL_MODE=disabled: 비밀번호 재설정 이메일이 비활성화되어 있습니다.");
  for (const provider of ["GOOGLE", "KAKAO", "NAVER"]) {
    if (!isConfigured(env, `${provider}_CLIENT_ID`) && !isConfigured(env, `${provider}_CLIENT_SECRET`)) {
      warnings.push(`${provider} 소셜 로그인이 비활성화되어 있습니다.`);
    }
  }
  return warnings;
}

function assertProductionConfig(env = process.env) {
  const errors = productionConfigErrors(env);
  if (errors.length) throw new Error(`[환경설정] 서버 시작 중단\n- ${errors.join("\n- ")}`);
}

module.exports = {
  MINIMUM_NODE_VERSION,
  nodeVersionError,
  assertProductionConfig,
  productionConfigErrors,
  productionConfigWarnings,
};
