require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const source = path.resolve(process.env.DB_PATH || path.join(__dirname, "..", "tteokjip.db"));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, "..", "backups"));
const keep = Math.max(1, Number(process.env.BACKUP_RETENTION || 14));
if (!fs.existsSync(source)) throw new Error(`DB 파일을 찾을 수 없습니다: ${source}`);
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = path.join(backupDir, `tteokjip-${stamp}.db`);

const db = new DatabaseSync(source, { readOnly: true });
try {
  const escaped = destination.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}

const backups = fs.readdirSync(backupDir)
  .filter((name) => /^tteokjip-.*\.db$/.test(name))
  .map((name) => ({ name, time: fs.statSync(path.join(backupDir, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time);
for (const old of backups.slice(keep)) fs.unlinkSync(path.join(backupDir, old.name));
console.log(JSON.stringify({ ok: true, backup: destination, retained: Math.min(backups.length, keep) }));
