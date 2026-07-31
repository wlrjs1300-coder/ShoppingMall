require("dotenv").config();

const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  PaymentPiiPurgeError,
  acquireRunnerLock,
  applyPurge,
  inventoryPayments,
  verifyPurge,
  writeSafeReport,
} = require("../services/payment-pii-purge");

function argumentError(message) {
  throw new PaymentPiiPurgeError("PAYMENT_PII_ARGUMENT_INVALID", message, 2);
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
      options.batchSize = positiveInteger(argument.slice(13), "--batch-size", 500);
      if (options.batchSize > 5000) argumentError("--batch-size must be between 1 and 5000.");
    } else if (argument.startsWith("--limit=")) {
      options.limit = positiveInteger(argument.slice(8), "--limit");
    } else if (argument.startsWith("--after-id=")) {
      options.afterId = argument.slice(11);
      if (!options.afterId) argumentError("--after-id must not be empty.");
    } else if (argument.startsWith("--report=")) {
      options.report = argument.slice(9);
      if (!options.report) argumentError("--report must not be empty.");
    } else if (argument.startsWith("--confirm=")) {
      options.confirm = argument.slice(10);
    } else {
      argumentError(`Unknown argument: ${argument}`);
    }
  }
  if (modes.length > 1) argumentError("Exactly one mode may be selected.");
  options.mode = modes[0] || "dry-run";
  options.batchSize ||= 500;
  if (options.mode === "verify" && (options.limit !== undefined || options.afterId !== undefined)) {
    argumentError("--verify always checks the full payments table; --limit and --after-id are not allowed.");
  }
  if (options.mode === "apply" && process.env.NODE_ENV === "production"
    && options.confirm !== "PURGE_PAYMENT_PII") {
    argumentError("Production apply requires --confirm=PURGE_PAYMENT_PII.");
  }
  return options;
}

function printResult(mode, result) {
  console.log(JSON.stringify({
    mode,
    totalPayments: result.totalPayments,
    paymentSafe: result.paymentSafe,
    legacyPiiConnected: result.legacyPiiConnected,
    legacyPiiOrphan: result.legacyPiiOrphan,
    orphanSafe: result.orphanSafe,
    processed: result.processed || 0,
    skipped: result.skipped || 0,
    finalCursor: result.finalCursor,
    byStatus: result.byStatus,
    byMonth: result.byMonth,
    byLinkState: result.byLinkState,
    bySessionState: result.bySessionState,
    byOrderPiiMode: result.byOrderPiiMode,
    warningCounts: result.warningCounts,
    ok: result.ok,
  }));
}

function main(argv = process.argv.slice(2)) {
  let db;
  let releaseLock;
  try {
    const options = parseArgs(argv);
    const databasePath = path.resolve(process.env.DB_PATH || path.join(__dirname, "../tteokjip.db"));
    const lockPath = process.env.PAYMENT_PII_PURGE_LOCK_PATH
      || path.join(os.tmpdir(), `shoppingmall-payment-pii-${path.basename(databasePath)}.lock`);
    releaseLock = acquireRunnerLock(lockPath, options.mode);
    db = new DatabaseSync(databasePath);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=1000");
    const result = options.mode === "apply" ? applyPurge(db, options)
      : (options.mode === "verify" ? verifyPurge(db, options) : inventoryPayments(db, options));
    if (options.report) writeSafeReport(options.report, result);
    printResult(options.mode, result);
    if (options.mode === "verify" && !result.ok) process.exitCode = 7;
    return result;
  } catch (error) {
    const safe = error instanceof PaymentPiiPurgeError
      ? error
      : new PaymentPiiPurgeError("PAYMENT_PII_DATABASE_FAILED", "Payment PII purge failed.", 6);
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
