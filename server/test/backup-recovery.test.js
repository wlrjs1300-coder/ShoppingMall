const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  BackupError,
  createBackup,
  verifyBackup,
  sha256File,
  applyRetention,
  resolveBackupConfig,
} = require("../lib/backup-utils");

function seedDatabase(file, marker = "preserved") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orders (id TEXT PRIMARY KEY, marker TEXT);
    CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id));
    CREATE TABLE order_status_history (id TEXT PRIMARY KEY);
    CREATE TABLE payments (id TEXT PRIMARY KEY);
    CREATE TABLE products (id TEXT PRIMARY KEY);
    CREATE TABLE inventory (id TEXT PRIMARY KEY);
    CREATE TABLE inventory_logs (id TEXT PRIMARY KEY);
    CREATE TABLE purchase_orders (id TEXT PRIMARY KEY);
    CREATE TABLE suppliers (id TEXT PRIMARY KEY);
    CREATE TABLE recipes (id TEXT PRIMARY KEY);
    CREATE TABLE activity_logs (id TEXT PRIMARY KEY);
    CREATE TABLE user_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE user_addresses (id TEXT PRIMARY KEY);
    CREATE TABLE sales_channel_product_mappings (id TEXT PRIMARY KEY);
    CREATE TABLE sales_channel_order_imports (id TEXT PRIMARY KEY);
    CREATE TABLE sales_channel_order_import_items (id TEXT PRIMARY KEY);
    CREATE TABLE sales_channel_sync_cursors (channel TEXT, stream TEXT, PRIMARY KEY(channel, stream));
    CREATE TABLE sales_channel_sync_runs (id TEXT PRIMARY KEY);
    CREATE TABLE sales_channel_sync_run_failures (id TEXT PRIMARY KEY);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
  `);
  db.prepare("INSERT INTO orders VALUES ('order-1', ?)").run(marker);
  db.close();
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shoppingmall-backup-test-"));
  const databasePath = path.join(root, "database", "source.sqlite");
  const backupDir = path.join(root, "external-backups");
  seedDatabase(databasePath);
  return {
    root,
    env: { NODE_ENV: "test", DB_PATH: databasePath, BACKUP_DIR: backupDir },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

test("SQLite backup API creates an atomic, verifiable three-file backup set", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  const result = await createBackup(item.env);
  const sqlite = path.join(item.env.BACKUP_DIR, result.backupFile);
  assert.match(result.backupFile, /^shoppingmall-\d{8}T\d{6}Z\.sqlite$/);
  assert.equal(fs.existsSync(sqlite), true);
  assert.equal(fs.existsSync(`${sqlite}.sha256`), true);
  assert.equal(fs.existsSync(sqlite.replace(/\.sqlite$/, ".json")), true);
  assert.equal(fs.readdirSync(item.env.BACKUP_DIR).some((name) => name.endsWith(".tmp")), false);
  assert.equal(result.integrityCheck, "ok");
  assert.equal(result.foreignKeyCheckCount, 0);
  assert.equal(result.tableCounts.orders, 1);
  assert.equal(await sha256File(sqlite), result.sha256);
});

test("metadata is minimal and does not expose the source path or sensitive records", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  const result = await createBackup({
    ...item.env,
    JWT_SECRET: "secret-value",
    TOSS_SECRET_KEY: "payment-secret",
    ADMIN_CODE: "admin-secret",
  });
  const metadata = fs.readFileSync(path.join(item.env.BACKUP_DIR, result.backupFile.replace(/\.sqlite$/, ".json")), "utf8");
  assert.equal(metadata.includes(item.env.DB_PATH), false);
  assert.equal(metadata.includes("secret-value"), false);
  assert.equal(metadata.includes("payment-secret"), false);
  assert.equal(metadata.includes("admin-secret"), false);
  assert.equal(metadata.includes("preserved"), false);
});

test("failed validation removes temporary/final artifacts and never changes the source database", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  const source = new DatabaseSync(item.env.DB_PATH);
  source.exec("PRAGMA foreign_keys = OFF; INSERT INTO order_items VALUES ('orphan', 'missing-order')");
  source.close();
  const before = fs.readFileSync(item.env.DB_PATH);
  await assert.rejects(createBackup(item.env), (error) => error.code === "FOREIGN_KEY_CHECK_FAILED");
  assert.deepEqual(fs.readFileSync(item.env.DB_PATH), before);
  assert.deepEqual(fs.readdirSync(item.env.BACKUP_DIR), []);
});

test("verification detects backup and checksum tampering without changing the source backup", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  const result = await createBackup(item.env);
  const sqlite = path.join(item.env.BACKUP_DIR, result.backupFile);
  const original = fs.readFileSync(sqlite);
  fs.appendFileSync(sqlite, "tampered");
  await assert.rejects(verifyBackup(item.env, result.backupFile), (error) => error.code === "CHECKSUM_MISMATCH");
  assert.equal(fs.existsSync(sqlite), true);
  assert.notDeepEqual(fs.readFileSync(sqlite), original);
});

test("verification distinguishes malformed checksum, missing tables, invalid SQLite and FK violations", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  const result = await createBackup(item.env);
  const sqlite = path.join(item.env.BACKUP_DIR, result.backupFile);
  fs.writeFileSync(`${sqlite}.sha256`, "bad checksum");
  await assert.rejects(verifyBackup(item.env, result.backupFile), (error) => error.code === "INVALID_CHECKSUM_FILE");

  fs.rmSync(sqlite);
  const incomplete = new DatabaseSync(sqlite);
  incomplete.exec("CREATE TABLE orders (id TEXT)");
  incomplete.close();
  const hash = await sha256File(sqlite);
  fs.writeFileSync(`${sqlite}.sha256`, `${hash}  ${result.backupFile}\n`);
  const metadataFile = sqlite.replace(/\.sqlite$/, ".json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  metadata.sha256 = hash;
  metadata.sizeBytes = fs.statSync(sqlite).size;
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  await assert.rejects(verifyBackup(item.env, result.backupFile), (error) => error.code === "MISSING_REQUIRED_TABLE");

  fs.writeFileSync(sqlite, "not sqlite");
  const invalidHash = await sha256File(sqlite);
  fs.writeFileSync(`${sqlite}.sha256`, `${invalidHash}  ${result.backupFile}\n`);
  metadata.sha256 = invalidHash;
  metadata.sizeBytes = fs.statSync(sqlite).size;
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  await assert.rejects(verifyBackup(item.env, result.backupFile), (error) => error.code === "INVALID_SQLITE");
});

test("verification selects the newest complete set and blocks traversal and outside paths", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  const first = await createBackup(item.env, { now: new Date("2026-07-29T01:00:00Z") });
  const second = await createBackup(item.env, { now: new Date("2026-07-29T02:00:00Z") });
  const verified = await verifyBackup(item.env);
  assert.equal(verified.backupFile, second.backupFile);
  await assert.rejects(verifyBackup(item.env, "../outside.sqlite"), (error) => error.code === "INVALID_BACKUP_PATH");
  await assert.rejects(verifyBackup(item.env, path.join(item.root, first.backupFile)), (error) => error.code === "INVALID_BACKUP_PATH");
});

test("verification removes its temporary restore directory", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  const result = await createBackup(item.env);
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("shoppingmall-restore-verify-")));
  await verifyBackup(item.env, result.backupFile);
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("shoppingmall-restore-verify-"));
  assert.deepEqual(after.filter((name) => !before.has(name)), []);
});

test("retention removes only complete expired/excess sets and preserves current, temp and unknown files", async (t) => {
  const item = await fixture();
  t.after(item.cleanup);
  fs.mkdirSync(item.env.BACKUP_DIR, { recursive: true });
  const names = [
    "shoppingmall-20260701T000000Z.sqlite",
    "shoppingmall-20260728T000000Z.sqlite",
    "shoppingmall-20260729T000000Z.sqlite",
  ];
  for (const name of names) {
    for (const file of [name, `${name}.sha256`, name.replace(/\.sqlite$/, ".json")]) {
      fs.writeFileSync(path.join(item.env.BACKUP_DIR, file), "x");
    }
  }
  fs.writeFileSync(path.join(item.env.BACKUP_DIR, "shoppingmall-working.sqlite.tmp"), "keep");
  fs.writeFileSync(path.join(item.env.BACKUP_DIR, "unknown.txt"), "keep");
  fs.writeFileSync(path.join(item.env.BACKUP_DIR, "shoppingmall-20260601T000000Z.sqlite"), "incomplete");
  const old = new Date("2026-07-01T00:00:00Z");
  for (const file of fs.readdirSync(item.env.BACKUP_DIR).filter((name) => name.includes("20260701"))) {
    fs.utimesSync(path.join(item.env.BACKUP_DIR, file), old, old);
  }
  const config = { ...resolveBackupConfig({ ...item.env, BACKUP_RETENTION_DAYS: "7", BACKUP_MAX_FILES: "2" }), backupDir: item.env.BACKUP_DIR };
  await applyRetention(config, names[2], new Date("2026-07-29T03:00:00Z"));
  assert.equal(fs.existsSync(path.join(item.env.BACKUP_DIR, names[0])), false);
  assert.equal(fs.existsSync(path.join(item.env.BACKUP_DIR, names[2])), true);
  assert.equal(fs.existsSync(path.join(item.env.BACKUP_DIR, "shoppingmall-working.sqlite.tmp")), true);
  assert.equal(fs.existsSync(path.join(item.env.BACKUP_DIR, "unknown.txt")), true);
  assert.equal(fs.existsSync(path.join(item.env.BACKUP_DIR, "shoppingmall-20260601T000000Z.sqlite")), true);
});

test("production configuration requires a safe external backup directory and valid retention values", () => {
  assert.throws(() => resolveBackupConfig({ NODE_ENV: "production", DB_PATH: path.resolve("db.sqlite") }), BackupError);
  assert.throws(() => resolveBackupConfig({
    NODE_ENV: "production",
    DB_PATH: path.resolve("database", "db.sqlite"),
    BACKUP_DIR: path.resolve("backups"),
  }), /outside the Git repository/);
  assert.throws(() => resolveBackupConfig({
    NODE_ENV: "production",
    DB_PATH: path.resolve(os.tmpdir(), "database", "db.sqlite"),
    BACKUP_DIR: path.resolve(os.tmpdir(), "database"),
  }), /database directory/);
  assert.throws(() => resolveBackupConfig({
    NODE_ENV: "production",
    DB_PATH: path.resolve(os.tmpdir(), "database", "db.sqlite"),
    BACKUP_DIR: path.resolve(os.tmpdir(), "backups"),
    BACKUP_MAX_FILES: "zero",
  }), /positive integer/);
});

test("backup implementation uses node:sqlite backup API and never copyFile for snapshot creation", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/backup-utils.js"), "utf8");
  const createBody = source.slice(source.indexOf("async function createBackup"), source.indexOf("async function listCompleteBackupSets"));
  assert.match(createBody, /await backup\(source, temporaryPath\)/);
  assert.doesNotMatch(createBody, /copyFile/);
});

test("package scripts expose only safe backup and verification commands", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.equal(packageJson.engines.node, ">=22.16.0");
  assert.equal(packageJson.scripts["backup:create"], "node scripts/backup-database.js");
  assert.equal(packageJson.scripts["backup:verify"], "node scripts/verify-backup.js");
  assert.equal(packageJson.scripts["db:backup"], "node scripts/backup-database.js");
  assert.equal(packageJson.scripts["db:restore"], undefined);
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    "bcryptjs",
    "cookie-parser",
    "cors",
    "dotenv",
    "express",
    "express-rate-limit",
    "jsonwebtoken",
  ]);
  assert.deepEqual(Object.keys(packageJson.devDependencies).sort(), ["@playwright/test", "supertest"]);
});

test("legacy automatic restore and backup scripts are absent and no HTTP restore route exists", () => {
  const serverRoot = path.resolve(__dirname, "..");
  assert.equal(fs.existsSync(path.join(serverRoot, "scripts/backup-db.js")), false);
  assert.equal(fs.existsSync(path.join(serverRoot, "scripts/restore-db.js")), false);
  const routeSources = fs.readdirSync(path.join(serverRoot, "routes"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => fs.readFileSync(path.join(serverRoot, "routes", name), "utf8"))
    .join("\n");
  assert.doesNotMatch(routeSources, /(?:router|app)\.(?:post|put|patch)\([^)]*restore/i);
});
