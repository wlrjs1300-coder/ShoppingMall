require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { productionConfigErrors } = require("../config");

const errors = productionConfigErrors({ ...process.env, NODE_ENV: "production" });
const warnings = [];
const placeholder = /000-0000|화성시 소재|smartstore\.naver\.com\/?$|your-domain/i;
const storeKeys = ["STORE_PHONE", "STORE_ADDRESS", "STORE_URL"];

for (const key of storeKeys) {
  if (!process.env[key] || placeholder.test(process.env[key])) warnings.push(`${key}: 포트폴리오 예시 값입니다.`);
}
if (!process.env.TOSS_CLIENT_KEY || !process.env.TOSS_SECRET_KEY) warnings.push("Toss 키가 없어 결제를 사용할 수 없습니다.");
else if (/^test_/.test(process.env.TOSS_CLIENT_KEY) || /^test_/.test(process.env.TOSS_SECRET_KEY)) warnings.push("Toss 테스트 키가 설정되어 있어 실제 결제는 처리되지 않습니다.");
if (!["SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER_PHONE"].every((key) => process.env[key])) warnings.push("Solapi 설정이 없어 운영 회원가입 휴대폰 인증을 사용할 수 없습니다.");
if (!process.env.RESEND_API_KEY || !process.env.PASSWORD_RESET_FROM) warnings.push("Resend 설정이 없어 운영 비밀번호 재설정 메일을 발송할 수 없습니다.");
for (const provider of ["GOOGLE", "KAKAO", "NAVER"]) {
  if (![`${provider}_CLIENT_ID`, `${provider}_CLIENT_SECRET`].every((key) => process.env[key])) warnings.push(`${provider} 소셜 로그인이 설정되지 않았습니다.`);
}

const root = path.resolve(__dirname, "../..");
for (const name of ["privacy.html", "terms.html"]) {
  const body = fs.readFileSync(path.join(root, name), "utf8");
  if (/포트폴리오용 초안|실제 서비스 공개 전 확정/.test(body)) warnings.push(`${name}: 운영용 법무 문서가 확정되지 않았습니다.`);
}

console.log("\n[배포 사전 점검]");
errors.forEach((message) => console.error(`ERROR  ${message}`));
warnings.forEach((message) => console.warn(`WARN   ${message}`));
console.log(`\n결과: 오류 ${errors.length}개, 확인 필요 ${warnings.length}개`);
if (errors.length) process.exitCode = 1;
