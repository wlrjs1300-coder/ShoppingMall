require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { nodeVersionError, productionConfigErrors, productionConfigWarnings } = require("../config");

const productionEnv = { ...process.env, NODE_ENV: "production" };
const errors = productionConfigErrors(productionEnv);
const warnings = productionConfigWarnings(productionEnv);
const versionError = nodeVersionError(process.versions.node);
if (versionError) errors.push(versionError);

const root = path.resolve(__dirname, "../..");
for (const file of [
  "server/scripts/backup-database.js",
  "server/scripts/verify-backup.js",
  "server/lib/backup-utils.js",
]) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`Backup component is missing: ${file}`);
}
if (!fs.existsSync(path.join(root, "docs/admin-auth-operations.md"))) {
  errors.push("Administrator authentication operations document is missing.");
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "server/package.json"), "utf8"));
if (packageJson.scripts?.["backup:create"] !== "node scripts/backup-database.js") {
  errors.push("backup:create must use the safe backup script.");
}
if (packageJson.scripts?.["backup:verify"] !== "node scripts/verify-backup.js") {
  errors.push("backup:verify must use the backup verification script.");
}
if (packageJson.scripts?.["db:restore"]) {
  errors.push("db:restore must not provide automatic production database replacement.");
}
if (packageJson.scripts?.["db:backup"]
  && packageJson.scripts["db:backup"] !== "node scripts/backup-database.js") {
  errors.push("db:backup must point to the safe backup script.");
}
if (fs.existsSync(path.join(root, "server/scripts/restore-db.js"))) {
  errors.push("Legacy automatic restore script must be removed.");
}
const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
for (const pattern of ["*.sqlite", "*.sha256", "shoppingmall-*.json"]) {
  if (!gitignore.includes(pattern)) errors.push(`.gitignore is missing backup pattern: ${pattern}`);
}
if (process.env.BACKUP_DIR && path.isAbsolute(process.env.BACKUP_DIR)) {
  let writableTarget = path.resolve(process.env.BACKUP_DIR);
  while (!fs.existsSync(writableTarget) && path.dirname(writableTarget) !== writableTarget) {
    writableTarget = path.dirname(writableTarget);
  }
  try {
    fs.accessSync(writableTarget, fs.constants.W_OK);
  } catch {
    errors.push("BACKUP_DIR does not have a writable existing parent directory.");
  }
}
for (const name of ["privacy.html", "terms.html"]) {
  const body = fs.readFileSync(path.join(root, name), "utf8");
  if (/포트폴리오용 초안|실제 서비스 공개 전 확정/.test(body)) warnings.push(`${name}: 운영용 법무 문서가 확정되지 않았습니다.`);
}

console.log("\n[배포 사전 점검]");
errors.forEach((message) => console.error(`ERROR  ${message}`));
warnings.forEach((message) => console.warn(`WARN   ${message}`));
console.log(`\n결과: 오류 ${errors.length}개, 확인 필요 ${warnings.length}개`);
if (errors.length) process.exitCode = 1;
