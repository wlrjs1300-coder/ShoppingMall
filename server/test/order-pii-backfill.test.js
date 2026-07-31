process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { parsePiiKeyring, loadOrderPiiKeyring } = require("../lib/pii-keyring");
const {
  buildOrderPiiColumns,
  decryptOrderPii,
} = require("../services/order-pii-service");
const {
  CLASSIFICATIONS,
  OrderPiiBackfillError,
  acquireRunnerLock,
  applyBackfill,
  classifyOrder,
  inventoryOrders,
  verifyBackfill,
  writeSafeReport,
} = require("../services/order-pii-backfill");
const { parseArgs } = require("../scripts/backfill-order-pii");

const keysJson = JSON.stringify([
  { version: "v1", key: Buffer.alloc(32, 71).toString("base64") },
  { version: "v2", key: Buffer.alloc(32, 72).toString("base64") },
]);
const keyring = parsePiiKeyring(keysJson, "v2");
const secret = {
  customerName: "backfill fixture name",
  customerPhone: "01012345678",
  deliveryAddress: "backfill fixture delivery address",
  guestAddress: null,
};

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    fulfillment_type TEXT,
    delivery_address TEXT,
    guest_address TEXT,
    created_at TEXT,
    updated_at TEXT,
    pii_ciphertext TEXT,
    pii_iv TEXT,
    pii_auth_tag TEXT,
    pii_key_version TEXT,
    customer_name_masked TEXT,
    customer_phone_masked TEXT,
    delivery_region_masked TEXT,
    pii_migrated_at TEXT
  )`);
  return db;
}

function insertLegacy(db, id, overrides = {}) {
  const row = {
    id,
    user_id: null,
    customer_name: secret.customerName,
    customer_phone: secret.customerPhone,
    fulfillment_type: "delivery",
    delivery_address: secret.deliveryAddress,
    guest_address: null,
    created_at: "2026-01-02T03:04:05.000Z",
    updated_at: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
  db.prepare(`INSERT INTO orders
    (id,user_id,customer_name,customer_phone,fulfillment_type,delivery_address,guest_address,
     created_at,updated_at,pii_ciphertext,pii_iv,pii_auth_tag,pii_key_version,
     customer_name_masked,customer_phone_masked,delivery_region_masked,pii_migrated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.user_id, row.customer_name, row.customer_phone, row.fulfillment_type,
    row.delivery_address, row.guest_address, row.created_at, row.updated_at,
    row.pii_ciphertext ?? null, row.pii_iv ?? null, row.pii_auth_tag ?? null,
    row.pii_key_version ?? null, row.customer_name_masked ?? null,
    row.customer_phone_masked ?? null, row.delivery_region_masked ?? null,
    row.pii_migrated_at ?? null,
  );
  return db.prepare("SELECT * FROM orders WHERE id=?").get(id);
}

function insertEncrypted(db, id, migratedAt = null, overrides = {}) {
  const encrypted = buildOrderPiiColumns(secret, keyring, migratedAt);
  return insertLegacy(db, id, {
    customer_name: "[protected]",
    customer_phone: "[protected]",
    delivery_address: null,
    guest_address: null,
    pii_ciphertext: encrypted.piiCiphertext,
    pii_iv: encrypted.piiIv,
    pii_auth_tag: encrypted.piiAuthTag,
    pii_key_version: encrypted.piiKeyVersion,
    customer_name_masked: encrypted.customerNameMasked,
    customer_phone_masked: encrypted.customerPhoneMasked,
    delivery_region_masked: null,
    pii_migrated_at: encrypted.piiMigratedAt,
    ...overrides,
  });
}

test("classifies valid legacy, native/backfilled encrypted, partial, unknown, mismatch and invalid rows", () => {
  const db = database();
  assert.equal(classifyOrder(insertLegacy(db, "a"), keyring), CLASSIFICATIONS.LEGACY_VALID);
  assert.equal(classifyOrder(insertEncrypted(db, "b"), keyring), CLASSIFICATIONS.ENCRYPTED_VALID);
  assert.equal(
    classifyOrder(insertEncrypted(db, "c", "2026-02-03T04:05:06.000Z"), keyring),
    CLASSIFICATIONS.ENCRYPTED_VALID,
  );
  assert.equal(classifyOrder(insertLegacy(db, "d", { pii_ciphertext: "partial" }), keyring), CLASSIFICATIONS.PARTIAL_TUPLE);
  assert.equal(
    classifyOrder(insertEncrypted(db, "e", null, { pii_key_version: "retired" }), keyring),
    CLASSIFICATIONS.UNKNOWN_KEY_VERSION,
  );
  assert.equal(
    classifyOrder(insertEncrypted(db, "f", null, { customer_name_masked: null }), keyring),
    CLASSIFICATIONS.ENCRYPTED_METADATA_MISMATCH,
  );
  assert.equal(
    classifyOrder(insertEncrypted(db, "g", null, { delivery_region_masked: null }), keyring),
    CLASSIFICATIONS.ENCRYPTED_VALID,
  );
  assert.equal(classifyOrder(insertLegacy(db, "h", { customer_phone: "invalid" }), keyring), CLASSIFICATIONS.LEGACY_INVALID);
  db.close();
});

test("dry-run inventory is deterministic, does not mutate and exposes safe fields only", () => {
  const db = database();
  const before = insertLegacy(db, "dry-a");
  insertLegacy(db, "dry-b", { fulfillment_type: "pickup", delivery_address: null, user_id: "member" });
  const result = inventoryOrders(db, keyring);
  const after = db.prepare("SELECT * FROM orders WHERE id='dry-a'").get();
  assert.equal(result.totalOrders, 2);
  assert.equal(result.legacyValid, 2);
  assert.equal(result.legacyByFulfillment.delivery, 1);
  assert.equal(result.legacyByFulfillment.pickup, 1);
  assert.equal(result.legacyByOwner.guest, 1);
  assert.equal(result.legacyByOwner.member, 1);
  assert.deepEqual(after, before);
  const serialized = JSON.stringify(result);
  for (const value of Object.values(secret).filter(Boolean)) assert.equal(serialized.includes(value), false);
  for (const forbidden of ["customerName", "customerPhone", "deliveryAddress", "ciphertext", "authTag"]) {
    assert.equal(Object.hasOwn(result.details[0], forbidden), false);
  }
  db.close();
});

test("apply encrypts valid legacy with active key while the runtime flag is OFF", () => {
  const db = database();
  insertLegacy(db, "apply-a");
  const previous = {
    enabled: process.env.ORDER_PII_PROTECTION_ENABLED,
    keys: process.env.ORDER_PII_KEYS_JSON,
    active: process.env.ORDER_PII_ACTIVE_KEY_VERSION,
  };
  process.env.ORDER_PII_PROTECTION_ENABLED = "false";
  process.env.ORDER_PII_KEYS_JSON = keysJson;
  process.env.ORDER_PII_ACTIVE_KEY_VERSION = "v2";
  try {
    const explicitKeyring = loadOrderPiiKeyring(process.env);
    const result = applyBackfill(db, explicitKeyring, {
      now: () => new Date("2026-03-04T05:06:07.000Z"),
    });
    assert.equal(result.processed, 1);
    const row = db.prepare("SELECT * FROM orders WHERE id='apply-a'").get();
    assert.equal(row.customer_name, "[protected]");
    assert.equal(row.customer_phone, "[protected]");
    assert.equal(row.delivery_address, null);
    assert.equal(row.guest_address, null);
    assert.equal(row.pii_key_version, "v2");
    assert.equal(row.pii_migrated_at, "2026-03-04T05:06:07.000Z");
    assert.ok(row.customer_name_masked);
    assert.ok(row.customer_phone_masked);
    assert.equal(row.delivery_region_masked, null);
    assert.deepEqual(decryptOrderPii(row, explicitKeyring), secret);
  } finally {
    for (const [name, value] of Object.entries({
      ORDER_PII_PROTECTION_ENABLED: previous.enabled,
      ORDER_PII_KEYS_JSON: previous.keys,
      ORDER_PII_ACTIVE_KEY_VERSION: previous.active,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    db.close();
  }
});

test("rerun is idempotent and after-id/limit use lexical deterministic pagination", () => {
  const db = database();
  insertLegacy(db, "cursor-a");
  insertLegacy(db, "cursor-b");
  insertLegacy(db, "cursor-c");
  const first = applyBackfill(db, keyring, { afterId: "cursor-a", limit: 1 });
  assert.equal(first.processed, 1);
  assert.equal(first.finalCursor, "cursor-b");
  const before = db.prepare("SELECT pii_ciphertext,pii_iv,pii_migrated_at FROM orders WHERE id='cursor-b'").get();
  const second = applyBackfill(db, keyring, { afterId: "cursor-a", limit: 1 });
  const after = db.prepare("SELECT pii_ciphertext,pii_iv,pii_migrated_at FROM orders WHERE id='cursor-b'").get();
  assert.equal(second.processed, 0);
  assert.deepEqual(after, before);
  db.close();
});

test("partial, unknown key and unapproved invalid legacy hard-stop before mutation", () => {
  for (const setup of [
    (db) => insertLegacy(db, "blocker", { pii_iv: "partial" }),
    (db) => insertEncrypted(db, "blocker", null, { pii_key_version: "unknown" }),
    (db) => insertLegacy(db, "blocker", { customer_phone: "bad" }),
  ]) {
    const db = database();
    insertLegacy(db, "valid");
    setup(db);
    assert.throws(() => applyBackfill(db, keyring), OrderPiiBackfillError);
    assert.equal(db.prepare("SELECT pii_ciphertext FROM orders WHERE id='valid'").get().pii_ciphertext, null);
    db.close();
  }
});

test("invalid keyring is rejected before apply can mutate any row", () => {
  const db = database();
  insertLegacy(db, "invalid-keyring");
  assert.throws(
    () => loadOrderPiiKeyring({
      ORDER_PII_KEYS_JSON: JSON.stringify([{ version: "v2", key: "invalid" }]),
      ORDER_PII_ACTIVE_KEY_VERSION: "v2",
    }),
    (error) => error.code === "ORDER_PII_KEY_INVALID",
  );
  assert.equal(db.prepare("SELECT pii_ciphertext FROM orders WHERE id='invalid-keyring'").get().pii_ciphertext, null);
  db.close();
});

test("explicit invalid skip processes only valid rows and reports no PII", () => {
  const db = database();
  insertLegacy(db, "skip-invalid", { customer_name: "[protected]" });
  insertLegacy(db, "skip-valid");
  const result = applyBackfill(db, keyring, { allowInvalidSkip: true });
  assert.equal(result.processed, 1);
  assert.equal(result.legacyInvalid, 1);
  assert.equal(db.prepare("SELECT pii_ciphertext FROM orders WHERE id='skip-invalid'").get().pii_ciphertext, null);
  assert.ok(db.prepare("SELECT pii_ciphertext FROM orders WHERE id='skip-valid'").get().pii_ciphertext);
  assert.equal(JSON.stringify(result).includes(secret.customerName), false);
  db.close();
});

test("batch failure rolls back its batch, retains earlier commits and remains retryable", () => {
  const db = database();
  insertLegacy(db, "batch-a");
  insertLegacy(db, "batch-b");
  insertLegacy(db, "batch-c");
  assert.throws(() => applyBackfill(db, keyring, {
    batchSize: 1,
    beforeUpdate(row) {
      if (row.id === "batch-b") throw new Error("forced");
    },
  }));
  assert.ok(db.prepare("SELECT pii_ciphertext FROM orders WHERE id='batch-a'").get().pii_ciphertext);
  assert.equal(db.prepare("SELECT pii_ciphertext FROM orders WHERE id='batch-b'").get().pii_ciphertext, null);
  assert.equal(applyBackfill(db, keyring).processed, 2);
  db.close();
});

test("compare-and-update detects a concurrent change and rolls back the batch", () => {
  const db = database();
  insertLegacy(db, "concurrent");
  assert.throws(() => applyBackfill(db, keyring, {
    beforeUpdate(row) {
      db.prepare("UPDATE orders SET updated_at='changed' WHERE id=?").run(row.id);
    },
  }), (error) => error.code === "ORDER_PII_CONCURRENT_CHANGE" && error.exitCode === 5);
  const row = db.prepare("SELECT * FROM orders WHERE id='concurrent'").get();
  assert.equal(row.updated_at, "2026-01-02T03:04:05.000Z");
  assert.equal(row.pii_ciphertext, null);
  db.close();
});

test("SQLITE_BUSY uses bounded injectable backoff and then completes the batch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "order-pii-busy-"));
  const file = path.join(root, "orders.sqlite");
  const blocker = new DatabaseSync(file);
  blocker.exec(`CREATE TABLE orders (
    id TEXT PRIMARY KEY, user_id TEXT, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL,
    fulfillment_type TEXT, delivery_address TEXT, guest_address TEXT, created_at TEXT, updated_at TEXT,
    pii_ciphertext TEXT, pii_iv TEXT, pii_auth_tag TEXT, pii_key_version TEXT,
    customer_name_masked TEXT, customer_phone_masked TEXT, delivery_region_masked TEXT, pii_migrated_at TEXT
  )`);
  insertLegacy(blocker, "busy-order");
  const worker = new DatabaseSync(file);
  worker.exec("PRAGMA busy_timeout=0");
  blocker.exec("BEGIN IMMEDIATE");
  let sleeps = 0;
  const result = applyBackfill(worker, keyring, {
    sleep() {
      sleeps += 1;
      blocker.exec("ROLLBACK");
    },
  });
  assert.equal(sleeps, 1);
  assert.equal(result.processed, 1);
  worker.close();
  blocker.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe JSONL report is atomic, refuses overwrite and contains allowlisted fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "order-pii-report-"));
  const report = path.join(root, "report.jsonl");
  const db = database();
  insertLegacy(db, "report-order", { customer_phone: "invalid-secret-phone" });
  const result = inventoryOrders(db, keyring);
  writeSafeReport(report, result);
  const body = fs.readFileSync(report, "utf8");
  assert.match(body, /"orderId":"report-order"/);
  assert.equal(body.includes("invalid-secret-phone"), false);
  assert.throws(() => writeSafeReport(report, result), (error) => error.code === "ORDER_PII_REPORT_EXISTS");
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("runner lock blocks duplicates, removes in finally and replaces only stale locks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "order-pii-lock-"));
  const lock = path.join(root, "runner.lock");
  const release = acquireRunnerLock(lock, "apply");
  assert.throws(() => acquireRunnerLock(lock, "verify"), (error) => error.exitCode === 8);
  release();
  const releaseAgain = acquireRunnerLock(lock, "verify");
  releaseAgain();
  fs.writeFileSync(lock, JSON.stringify({
    pid: 99999999,
    startedAt: "2020-01-01T00:00:00.000Z",
    mode: "apply",
    ownerToken: "stale-owner",
  }));
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lock, old, old);
  const releaseStale = acquireRunnerLock(lock, "dry-run", {
    staleMs: 1000,
    isProcessAlive: () => false,
  });
  releaseStale();
  fs.rmSync(root, { recursive: true, force: true });
});

test("runner release removes only the lock owned by its private token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "order-pii-lock-owner-"));
  const lock = path.join(root, "runner.lock");
  const releaseA = acquireRunnerLock(lock, "apply");
  const runnerB = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    mode: "verify",
    ownerToken: "runner-b-owner-token",
  };
  fs.writeFileSync(lock, `${JSON.stringify(runnerB)}\n`);
  releaseA();
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, "utf8")), runnerB);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stale lock takeover requires an expired lock and a confirmed inactive PID", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "order-pii-lock-pid-"));
  const lock = path.join(root, "runner.lock");
  const writeLock = (pid) => fs.writeFileSync(lock, JSON.stringify({
    pid,
    startedAt: "2020-01-01T00:00:00.000Z",
    mode: "apply",
    ownerToken: "existing-owner",
  }));
  const makeOld = () => {
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lock, old, old);
  };

  writeLock(process.pid);
  makeOld();
  assert.throws(
    () => acquireRunnerLock(lock, "verify", { staleMs: 1000 }),
    (error) => error.code === "ORDER_PII_LOCK_CONFLICT",
  );

  writeLock(99999999);
  assert.throws(
    () => acquireRunnerLock(lock, "verify", { staleMs: 1000, isProcessAlive: () => false }),
    (error) => error.code === "ORDER_PII_LOCK_CONFLICT",
  );

  fs.writeFileSync(lock, "not-json");
  makeOld();
  assert.throws(
    () => acquireRunnerLock(lock, "verify", { staleMs: 1000, isProcessAlive: () => false }),
    (error) => error.code === "ORDER_PII_LOCK_CONFLICT",
  );
  assert.equal(fs.readFileSync(lock, "utf8"), "not-json");

  writeLock(99999999);
  makeOld();
  const release = acquireRunnerLock(lock, "verify", {
    staleMs: 1000,
    isProcessAlive: () => false,
  });
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  release();
  fs.rmSync(root, { recursive: true, force: true });
});

test("verify succeeds only after full metadata and operational decrypt checks pass", () => {
  const db = database();
  insertLegacy(db, "verify-a");
  applyBackfill(db, keyring);
  assert.equal(verifyBackfill(db, keyring).ok, true);
  db.prepare("UPDATE orders SET pii_auth_tag='tampered' WHERE id='verify-a'").run();
  const failed = verifyBackfill(db, keyring);
  assert.equal(failed.ok, false);
  assert.equal(failed.decryptFailure, 1);
  assert.equal(JSON.stringify(failed).includes(secret.customerName), false);
  db.close();
});

test("verify always inspects rows after the first batch for legacy and decrypt failures", () => {
  const legacyDb = database();
  insertEncrypted(legacyDb, "a-encrypted");
  insertLegacy(legacyDb, "z-legacy");
  const legacyResult = verifyBackfill(legacyDb, keyring, { batchSize: 1, limit: 1 });
  assert.equal(legacyResult.ok, false);
  assert.equal(legacyResult.legacyValid, 1);
  legacyDb.close();

  const decryptDb = database();
  insertEncrypted(decryptDb, "a-encrypted");
  insertEncrypted(decryptDb, "z-tampered", null, { pii_auth_tag: "tampered" });
  const decryptResult = verifyBackfill(decryptDb, keyring, { batchSize: 1, afterId: "z-tampered" });
  assert.equal(decryptResult.ok, false);
  assert.equal(decryptResult.decryptFailure, 1);
  decryptDb.close();
});

test("CLI arguments enforce exclusive modes, bounds and production confirmation", () => {
  assert.equal(parseArgs([]).mode, "dry-run");
  assert.throws(() => parseArgs(["--dry-run", "--verify"]), (error) => error.exitCode === 2);
  assert.throws(() => parseArgs(["--batch-size=0"]));
  assert.throws(() => parseArgs(["--batch-size=1001"]));
  assert.throws(() => parseArgs(["--limit=no"]));
  assert.throws(
    () => parseArgs(["--verify", "--limit=1"]),
    (error) => error.code === "ORDER_PII_ARGUMENT_INVALID" && error.exitCode === 2,
  );
  assert.throws(
    () => parseArgs(["--verify", "--after-id=x"]),
    (error) => error.code === "ORDER_PII_ARGUMENT_INVALID" && error.exitCode === 2,
  );
  assert.equal(parseArgs(["--verify", "--batch-size=1"]).batchSize, 1);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => parseArgs(["--apply"]));
    assert.equal(parseArgs(["--apply", "--confirm=BACKFILL_ORDER_PII"]).mode, "apply");
  } finally {
    process.env.NODE_ENV = previous;
  }
});
