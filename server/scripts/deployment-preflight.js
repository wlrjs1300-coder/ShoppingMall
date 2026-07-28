require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { productionConfigErrors, productionConfigWarnings } = require("../config");

const productionEnv = { ...process.env, NODE_ENV: "production" };
const errors = productionConfigErrors(productionEnv);
const warnings = productionConfigWarnings(productionEnv);

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
