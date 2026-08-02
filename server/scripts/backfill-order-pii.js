require("dotenv").config();

const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { PiiKeyringError, loadOrderPiiKeyring } = require("../lib/pii-keyring");
const {
  OrderPiiBackfillError,
  acquireRunnerLock,
  applyBackfill,
  inventoryOrders,
  verifyBackfill,
  writeSafeReport,
} = require("../services/order-pii-backfill");

function argumentError(message) {
  throw new OrderPiiBackfillError("ORDER_PII_ARGUMENT_INVALID", message, 2);
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) argumentError(`${name} must be a positive integer.`);
  return Number(value);
}

function parseArgs(argv) {
  const options = {};
  const modes = [];
  for (const argument of argv) {
    if (["--dry-run", "--apply", "--verify"].includes(argument)) {
      modes.push(argument.slice(2));
    } else if (argument.startsWith("--batch-size=")) {
      options.batchSize = positiveInteger(argument.slice(13), "--batch-size", 100);
      if (options.batchSize > 1000) argumentError("--batch-size must be between 1 and 1000.");
    } else if (argument.startsWith("--limit=")) {
      options.limit = positiveInteger(argument.slice(8), "--limit");
    } else if (argument.startsWith("--after-id=")) {
      options.afterId = argument.slice(11);
      if (!options.afterId) argumentError("--after-id must not be empty.");
    } else if (argument.startsWith("--report=")) {
      options.report = argument.slice(9);
      if (!options.report) argumentError("--report must not be empty.");
    } else if (argument === "--allow-invalid-skip") {
      options.allowInvalidSkip = true;
    } else if (argument.startsWith("--confirm=")) {
      options.confirm = argument.slice(10);
    } else {
      argumentError(`Unknown argument: ${argument}`);
    }
  }
  if (modes.length > 1) argumentError("Exactly one mode may be selected.");
  options.mode = modes[0] || "dry-run";
  options.batchSize ||= 100;
  if (options.mode === "verify" && (options.limit !== undefined || options.afterId !== undefined)) {
    argumentError("--verify always checks the full orders table; --limit and --after-id are not allowed.");
  }
  if (options.mode === "apply" && process.env.NODE_ENV === "production"
    && options.confirm !== "BACKFILL_ORDER_PII") {
    argumentError("Production apply requires --confirm=BACKFILL_ORDER_PII.");
  }
  return options;
}

function printResult(mode, keyring, result) {
  const output = {
    mode,
    activeKeyVersion: keyring.activeVersion,
    knownKeyVersions: Number(process.env.ORDER_PII_KEYS_JSON
      ? JSON.parse(process.env.ORDER_PII_KEYS_JSON).length : 0),
    totalOrders: result.totalOrders,
    legacyValid: result.legacyValid,
    encryptedValid: result.encryptedValid,
    partialTuple: result.partialTuple,
    unknownKeyVersion: result.unknownKeyVersion,
    encryptedMetadataMismatch: result.encryptedMetadataMismatch,
    legacyInvalid: result.legacyInvalid,
    processed: result.processed || 0,
    skipped: result.skipped || 0,
    decryptSuccess: result.decryptSuccess || 0,
    decryptFailure: result.decryptFailure || 0,
    finalCursor: result.finalCursor,
    legacyByFulfillment: result.legacyByFulfillment,
    legacyByOwner: result.legacyByOwner,
    legacyByMonth: result.legacyByMonth,
  };
  console.log(JSON.stringify(output));
}

function main(argv = process.argv.slice(2)) {
  let db;
  let releaseLock;
  try {
    const options = parseArgs(argv);
    let keyring;
    try {
      keyring = loadOrderPiiKeyring(process.env);
    } catch (error) {
      throw new OrderPiiBackfillError(
        error instanceof PiiKeyringError ? error.code : "ORDER_PII_KEYRING_INVALID",
        "Order PII keyring readiness failed.",
        3,
      );
    }
    const databasePath = path.resolve(process.env.DB_PATH || path.join(__dirname, "../tteokjip.db"));
    const lockPath = process.env.ORDER_PII_BACKFILL_LOCK_PATH
      || path.join(os.tmpdir(), `shoppingmall-order-pii-${path.basename(databasePath)}.lock`);
    releaseLock = acquireRunnerLock(lockPath, options.mode);
    db = new DatabaseSync(databasePath);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=1000");
    let result;
    if (options.mode === "apply") result = applyBackfill(db, keyring, options);
    else if (options.mode === "verify") result = verifyBackfill(db, keyring, options);
    else result = inventoryOrders(db, keyring, options);
    if (options.report) writeSafeReport(options.report, result);
    printResult(options.mode, keyring, result);
    if (options.mode === "verify" && !result.ok) process.exitCode = 7;
    return result;
  } catch (error) {
    const safe = error instanceof OrderPiiBackfillError
      ? error
      : new OrderPiiBackfillError("ORDER_PII_DATABASE_FAILED", "Order PII backfill failed.", 6);
    console.error(JSON.stringify({ safeErrorCode: safe.code }));
    process.exitCode = safe.exitCode;
    return null;
  } finally {
    if (db) db.close();
    releaseLock?.();
  }
}

if (require.main === module) main();

module.exports = { main, parseArgs };
