const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");

const BACKUP_PREFIX = "shoppingmall-";
const REQUIRED_TABLES = [
  "orders",
  "order_items",
  "order_status_history",
  "payments",
  "products",
  "inventory",
  "inventory_logs",
  "purchase_orders",
  "suppliers",
  "recipes",
  "activity_logs",
  "user_accounts",
  "user_addresses",
  "schema_migrations",
];
const COUNTED_TABLES = ["orders", "payments", "inventory", "purchase_orders", "activity_logs"];
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_FILES = 30;

class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new BackupError("INVALID_CONFIGURATION", `${name} must be a positive integer.`);
  }
  return Number(value);
}

function pathsEqual(left, right) {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveBackupConfig(env = process.env, options = {}) {
  const production = env.NODE_ENV === "production";
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, "../.."));
  const databasePath = path.resolve(env.DB_PATH || path.join(__dirname, "..", "tteokjip.db"));
  if (production && !env.BACKUP_DIR) {
    throw new BackupError("INVALID_CONFIGURATION", "BACKUP_DIR is required in production.");
  }
  const configuredBackupDir = env.BACKUP_DIR || path.join(os.tmpdir(), "shoppingmall-backups");
  if (!path.isAbsolute(configuredBackupDir)) {
    throw new BackupError("INVALID_CONFIGURATION", "BACKUP_DIR must be an absolute path.");
  }
  const backupDir = path.resolve(configuredBackupDir);
  if (pathsEqual(backupDir, path.dirname(databasePath))) {
    throw new BackupError("INVALID_CONFIGURATION", "BACKUP_DIR must not be the database directory.");
  }
  if (pathsEqual(backupDir, repositoryRoot) || isWithin(repositoryRoot, backupDir)) {
    throw new BackupError("INVALID_CONFIGURATION", "BACKUP_DIR must be outside the Git repository.");
  }
  return {
    backupDir,
    databasePath,
    repositoryRoot,
    retentionDays: positiveInteger(env.BACKUP_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, "BACKUP_RETENTION_DAYS"),
    maxFiles: positiveInteger(env.BACKUP_MAX_FILES, DEFAULT_MAX_FILES, "BACKUP_MAX_FILES"),
  };
}

async function ensureBackupDirectory(config) {
  await fsp.mkdir(config.backupDir, { recursive: true });
  const directory = await fsp.realpath(config.backupDir);
  const repository = fs.existsSync(config.repositoryRoot)
    ? await fsp.realpath(config.repositoryRoot)
    : config.repositoryRoot;
  const databaseDirectory = fs.existsSync(path.dirname(config.databasePath))
    ? await fsp.realpath(path.dirname(config.databasePath))
    : path.dirname(config.databasePath);
  if (pathsEqual(directory, repository) || isWithin(repository, directory) || pathsEqual(directory, databaseDirectory)) {
    throw new BackupError("INVALID_CONFIGURATION", "BACKUP_DIR resolves to an unsafe location.");
  }
  await fsp.access(directory, fs.constants.W_OK);
  return directory;
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(({ name }) => name));
}

function countTables(db) {
  return Object.fromEntries(COUNTED_TABLES.map((name) => [
    name,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count),
  ]));
}

function inspectDatabase(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA foreign_keys = ON");
    const integrityRows = db.prepare("PRAGMA integrity_check").all();
    const integrityCheck = integrityRows.length === 1 ? Object.values(integrityRows[0])[0] : "failed";
    if (integrityCheck !== "ok") {
      throw new BackupError("INTEGRITY_CHECK_FAILED", "SQLite integrity check failed.");
    }
    const foreignKeyCheckCount = db.prepare("PRAGMA foreign_key_check").all().length;
    if (foreignKeyCheckCount !== 0) {
      throw new BackupError("FOREIGN_KEY_CHECK_FAILED", "SQLite foreign key check failed.");
    }
    const existing = tableNames(db);
    const missing = REQUIRED_TABLES.filter((name) => !existing.has(name));
    if (missing.length) {
      throw new BackupError("MISSING_REQUIRED_TABLE", `Required database table is missing: ${missing.join(", ")}`);
    }
    const tableCounts = countTables(db);
    return { integrityCheck, foreignKeyCheckCount, tableCounts };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("INVALID_SQLITE", "The selected file is not a readable SQLite backup.");
  } finally {
    if (db) db.close();
  }
}

async function writeAtomic(file, contents) {
  const temporary = `${file}.tmp`;
  try {
    await fsp.writeFile(temporary, contents, { flag: "wx" });
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function backupSetNames(sqliteName) {
  return {
    sqlite: sqliteName,
    checksum: `${sqliteName}.sha256`,
    metadata: sqliteName.replace(/\.sqlite$/, ".json"),
  };
}

function safeBackupName(name) {
  return typeof name === "string"
    && path.basename(name) === name
    && !name.includes("..")
    && /^shoppingmall-\d{8}T\d{6}Z\.sqlite$/.test(name);
}

async function resolveFileInside(directory, name) {
  if (!safeBackupName(name)) throw new BackupError("INVALID_BACKUP_PATH", "Invalid backup file name.");
  const candidate = path.join(directory, name);
  const realDirectory = await fsp.realpath(directory);
  const realFile = await fsp.realpath(candidate).catch(() => {
    throw new BackupError("BACKUP_NOT_FOUND", "Backup file was not found.");
  });
  if (!isWithin(realDirectory, realFile)) {
    throw new BackupError("INVALID_BACKUP_PATH", "Backup file must be inside BACKUP_DIR.");
  }
  return realFile;
}

async function removeIfExists(file) {
  await fsp.rm(file, { force: true }).catch(() => {});
}

async function createBackup(env = process.env, options = {}) {
  const config = resolveBackupConfig(env, options);
  if (!fs.existsSync(config.databasePath)) throw new BackupError("SOURCE_NOT_FOUND", "Source database was not found.");
  const backupDir = await ensureBackupDirectory(config);
  const requestedTime = options.now ? new Date(options.now) : new Date();
  let nameTime = requestedTime;
  let sqliteName = `${BACKUP_PREFIX}${utcStamp(nameTime)}.sqlite`;
  while (fs.existsSync(path.join(backupDir, sqliteName))) {
    nameTime = new Date(nameTime.getTime() + 1000);
    sqliteName = `${BACKUP_PREFIX}${utcStamp(nameTime)}.sqlite`;
  }
  const names = backupSetNames(sqliteName);
  const finalPath = path.join(backupDir, names.sqlite);
  const temporaryPath = `${finalPath}.tmp`;
  const checksumPath = path.join(backupDir, names.checksum);
  const metadataPath = path.join(backupDir, names.metadata);
  if ([temporaryPath, checksumPath, metadataPath].some(fs.existsSync)) {
    throw new BackupError("BACKUP_EXISTS", "A partial backup with this timestamp already exists.");
  }

  const source = new DatabaseSync(config.databasePath, { readOnly: true });
  let sourceTableCounts;
  try {
    source.exec("BEGIN");
    sourceTableCounts = countTables(source);
    await backup(source, temporaryPath);
    source.exec("COMMIT");
  } catch {
    try {
      source.exec("ROLLBACK");
    } catch {}
    await removeIfExists(temporaryPath);
    throw new BackupError("BACKUP_FAILED", "SQLite snapshot backup failed.");
  } finally {
    source.close();
  }

  try {
    const inspection = inspectDatabase(temporaryPath);
    if (COUNTED_TABLES.some((name) => inspection.tableCounts[name] !== sourceTableCounts[name])) {
      throw new BackupError("BACKUP_CONSISTENCY_FAILED", "Backup table counts do not match the source snapshot.");
    }
    const hash = await sha256File(temporaryPath);
    const sizeBytes = (await fsp.stat(temporaryPath)).size;
    await fsp.rename(temporaryPath, finalPath);
    await writeAtomic(checksumPath, `${hash}  ${names.sqlite}\n`);
    const metadata = {
      version: 1,
      createdAt: requestedTime.toISOString(),
      sourceDatabase: path.basename(config.databasePath),
      backupFile: names.sqlite,
      sizeBytes,
      sha256: hash,
      ...inspection,
    };
    await writeAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await applyRetention(config, names.sqlite, options.now || new Date());
    return { ...metadata, backupDir };
  } catch (error) {
    await Promise.all([
      temporaryPath,
      finalPath,
      checksumPath,
      `${checksumPath}.tmp`,
      metadataPath,
      `${metadataPath}.tmp`,
    ].map(removeIfExists));
    throw error;
  }
}

async function listCompleteBackupSets(backupDir) {
  const entries = await fsp.readdir(backupDir, { withFileTypes: true });
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  return [...files]
    .filter((name) => safeBackupName(name))
    .map((name) => ({ names: backupSetNames(name), name }))
    .filter(({ names }) => files.has(names.checksum) && files.has(names.metadata))
    .map((set) => ({
      ...set,
      time: fs.statSync(path.join(backupDir, set.name)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);
}

async function applyRetention(config, currentName, now = new Date()) {
  const sets = await listCompleteBackupSets(config.backupDir);
  const cutoff = now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000;
  const removals = sets.filter((set, index) => set.name !== currentName && (set.time < cutoff || index >= config.maxFiles));
  for (const set of removals) {
    for (const name of Object.values(set.names)) await removeIfExists(path.join(config.backupDir, name));
  }
  return removals.map(({ name }) => name);
}

async function selectBackup(config, requestedFile) {
  const backupDir = await ensureBackupDirectory(config);
  if (requestedFile) return resolveFileInside(backupDir, requestedFile);
  const sets = await listCompleteBackupSets(backupDir);
  if (!sets.length) throw new BackupError("BACKUP_NOT_FOUND", "No complete backup set was found.");
  return resolveFileInside(backupDir, sets[0].name);
}

async function verifyBackup(env = process.env, requestedFile, options = {}) {
  const config = resolveBackupConfig(env, options);
  const source = await selectBackup(config, requestedFile);
  const names = backupSetNames(path.basename(source));
  const checksumFile = path.join(config.backupDir, names.checksum);
  const metadataFile = path.join(config.backupDir, names.metadata);
  const realDirectory = await fsp.realpath(config.backupDir);
  for (const sidecar of [checksumFile, metadataFile]) {
    const realSidecar = await fsp.realpath(sidecar).catch(() => {
      throw new BackupError("INCOMPLETE_BACKUP_SET", "Backup checksum or metadata is missing.");
    });
    if (!isWithin(realDirectory, realSidecar)) {
      throw new BackupError("INVALID_BACKUP_PATH", "Backup set must not use links outside BACKUP_DIR.");
    }
  }
  let expected;
  try {
    const content = await fsp.readFile(checksumFile, "utf8");
    const match = content.match(/^([a-f0-9]{64})  ([^\r\n]+)\r?\n?$/i);
    if (!match || match[2] !== names.sqlite) throw new Error();
    expected = match[1].toLowerCase();
  } catch {
    throw new BackupError("INVALID_CHECKSUM_FILE", "The checksum file is missing or invalid.");
  }
  const actual = await sha256File(source);
  if (actual !== expected) throw new BackupError("CHECKSUM_MISMATCH", "Backup checksum does not match.");
  try {
    const metadata = JSON.parse(await fsp.readFile(metadataFile, "utf8"));
    const size = (await fsp.stat(source)).size;
    if (metadata.version !== 1
      || metadata.backupFile !== names.sqlite
      || metadata.sha256 !== actual
      || metadata.sizeBytes !== size) {
      throw new Error();
    }
  } catch {
    throw new BackupError("INVALID_METADATA", "Backup metadata is missing or does not match.");
  }

  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "shoppingmall-restore-verify-"));
  const temporaryDatabase = path.join(temporaryDirectory, "restored.sqlite");
  try {
    await fsp.copyFile(source, temporaryDatabase, fs.constants.COPYFILE_EXCL);
    const inspection = inspectDatabase(temporaryDatabase);
    return { backupFile: names.sqlite, sha256: actual, ...inspection };
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  BackupError,
  REQUIRED_TABLES,
  COUNTED_TABLES,
  resolveBackupConfig,
  createBackup,
  verifyBackup,
  inspectDatabase,
  sha256File,
  applyRetention,
  listCompleteBackupSets,
};
