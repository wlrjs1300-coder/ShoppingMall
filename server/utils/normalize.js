// 고객 회원 입력값 정규화·검증 유틸리티.
// server/services/notify.js에도 비슷한 이름의 normalizePhone()이 있지만, 그쪽은
// SMS 발신 API용으로 하이픈/공백만 제거하고 국가코드(+)는 보존하는 다른 규칙이라
// 여기서는 통합하지 않고 회원 저장용 규칙을 별도로 둔다.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KR_MOBILE_RE = /^01[0-9]{8,9}$/;

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

function normalizePhone(phone) {
  return typeof phone === "string" ? phone.replace(/\D/g, "") : "";
}

function isValidPhone(phone) {
  return typeof phone === "string" && KR_MOBILE_RE.test(phone);
}

module.exports = { normalizeEmail, isValidEmail, normalizePhone, isValidPhone };
