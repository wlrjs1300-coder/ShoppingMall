require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  nodeVersionError,
  productionReadinessReport,
  READINESS_CATEGORIES,
} = require("../config");

const productionEnv = { ...process.env, NODE_ENV: "production" };
const report = productionReadinessReport(productionEnv);
const root = path.resolve(__dirname, "../..");

function add(level, code, category, problem, action, envKeys = []) {
  const item = { level, code, category, problem, action, envKeys };
  report.items.push(item);
  (level === "error" ? report.errors : report.confirmations).push(item);
}

const versionError = nodeVersionError(process.versions.node);
if (versionError) {
  add("error", "NODE_VERSION_UNSUPPORTED", READINESS_CATEGORIES.SECURITY, versionError,
    "배포 런타임을 package.json engines에 맞는 Node.js 버전으로 변경하세요.");
}

for (const file of [
  "server/scripts/backup-database.js",
  "server/scripts/verify-backup.js",
  "server/lib/backup-utils.js",
]) {
  if (!fs.existsSync(path.join(root, file))) {
    add("error", "BACKUP_COMPONENT_MISSING", READINESS_CATEGORIES.BACKUP,
      `필수 백업 구성요소가 없습니다: ${file}`, "누락된 파일을 배포 artifact에 포함하세요.");
  }
}

for (const [file, code] of [
  ["privacy.html", "PRIVACY_POLICY_APPROVAL_REQUIRED"],
  ["terms.html", "TERMS_APPROVAL_REQUIRED"],
]) {
  const body = fs.readFileSync(path.join(root, file), "utf8");
  if (/포트폴리오용 초안|실제 서비스 공개 전 확정/.test(body)) {
    add("confirm-needed", code, READINESS_CATEGORIES.MANUAL,
      `${file}이 운영 확정 전 초안 상태입니다.`,
      "법무·사업 담당자의 최종 승인을 받고 실제 사업자·정책 정보로 확정하세요.");
  }
}

for (const file of [
  "docs/admin-auth-operations.md",
  "docs/backup-and-recovery.md",
  "docs/production-readiness.md",
]) {
  if (!fs.existsSync(path.join(root, file))) {
    add("error", "OPERATIONS_DOCUMENT_MISSING", READINESS_CATEGORIES.MANUAL,
      `필수 운영 문서가 없습니다: ${file}`, "운영 문서를 작성하고 배포 승인자가 검토하게 하세요.");
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "server/package.json"), "utf8"));
if (packageJson.scripts?.["backup:create"] !== "node scripts/backup-database.js"
  || packageJson.scripts?.["backup:verify"] !== "node scripts/verify-backup.js") {
  add("error", "BACKUP_SCRIPT_UNSAFE", READINESS_CATEGORIES.BACKUP,
    "package.json의 백업 생성·검증 명령이 안전한 스크립트를 가리키지 않습니다.",
    "backup:create와 backup:verify 명령을 승인된 스크립트로 복구하세요.");
}
if (packageJson.scripts?.["db:restore"] || fs.existsSync(path.join(root, "server/scripts/restore-db.js"))) {
  add("error", "AUTOMATIC_RESTORE_FORBIDDEN", READINESS_CATEGORIES.BACKUP,
    "운영 DB를 자동 교체할 수 있는 복원 명령이 존재합니다.",
    "자동 복원 경로를 제거하고 문서화된 수동 승인 절차를 사용하세요.");
}

const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
for (const pattern of ["*.sqlite", "*.sha256", "shoppingmall-*.json"]) {
  if (!gitignore.includes(pattern)) {
    add("error", "BACKUP_IGNORE_PATTERN_MISSING", READINESS_CATEGORIES.BACKUP,
      `.gitignore에 백업 보호 패턴이 없습니다: ${pattern}`,
      "해당 패턴을 .gitignore에 추가하세요.");
  }
}

function print(item) {
  const stream = item.level === "error" ? console.error : console.warn;
  stream(`\n[${item.level === "error" ? "ERROR" : "CONFIRM-NEEDED"}][${item.code}]`);
  stream(`분류: ${item.category}`);
  stream(`문제: ${item.problem}`);
  stream(`조치: ${item.action}`);
  if (item.envKeys.length) stream(`환경변수: ${item.envKeys.join(", ")}`);
}

console.log("\n[production 배포 사전 점검]");
report.items.forEach(print);
console.log(`\n결과: errors ${report.errors.length}, confirm-needed ${report.confirmations.length}`);
if (report.errors.length) process.exitCode = 1;
