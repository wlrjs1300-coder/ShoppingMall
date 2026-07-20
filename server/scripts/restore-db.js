require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const args = process.argv.slice(2);
const sourceArg = args.find((arg) => !arg.startsWith("--"));
if (!sourceArg || !args.includes("--confirm")) {
  throw new Error("사용법: npm run db:restore -- <백업.db> --confirm (서버를 먼저 중지하세요)");
}
const source = path.resolve(sourceArg);
const target = path.resolve(process.env.DB_PATH || path.join(__dirname, "..", "tteokjip.db"));
if (!fs.existsSync(source)) throw new Error(`백업 파일을 찾을 수 없습니다: ${source}`);
const verify = new DatabaseSync(source, { readOnly: true });
try {
  const result = verify.prepare("PRAGMA integrity_check").get();
  if (result.integrity_check !== "ok") throw new Error("백업 무결성 검사에 실패했습니다.");
} finally {
  verify.close();
}
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.before-restore-${Date.now()}`);
for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(target + suffix)) fs.unlinkSync(target + suffix);
fs.copyFileSync(source, target);
console.log(JSON.stringify({ ok: true, restored: target }));
