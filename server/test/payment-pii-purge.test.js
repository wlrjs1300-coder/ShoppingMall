process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  CLASSIFICATIONS,
  KNOWN_STATUSES,
  acquireRunnerLock,
  applyPurge,
  classifyPayment,
  inventoryPayments,
  verifyPurge,
  writeSafeReport,
} = require("../services/payment-pii-purge");
const { parseArgs } = require("../scripts/purge-payment-pii");

const secrets = {
  name: "payment fixture secret name",
  phone: "01098765432",
  link: "secret-link-hash",
  session: "secret-session-hash",
  paymentKey: "secret-payment-key",
};

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE orders (
    id TEXT PRIMARY KEY, pii_ciphertext TEXT, pii_iv TEXT, pii_auth_tag TEXT, pii_key_version TEXT
  );
  CREATE TABLE payments (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, amount INTEGER, order_name TEXT,
    customer_name TEXT, customer_phone TEXT, status TEXT, requested_at TEXT,
    payment_key TEXT, paid_at TEXT, canceled_at TEXT, canceled_amount INTEGER,
    cancel_reason TEXT, payment_method TEXT, last_error TEXT,
    confirm_idempotency_key TEXT, cancel_idempotency_key TEXT,
    link_token_hash TEXT, link_token_expires_at TEXT, link_token_used_at TEXT,
    session_token_hash TEXT, session_token_expires_at TEXT, toss_secret TEXT
  )`);
  return db;
}

function insertOrder(db, id, mode = "LEGACY") {
  const tuple = mode === "ENCRYPTED" ? ["cipher", "iv", "tag", "v1"]
    : (mode === "PARTIAL" ? ["cipher", null, null, null] : [null, null, null, null]);
  db.prepare("INSERT INTO orders VALUES (?,?,?,?,?)").run(id, ...tuple);
}

function insertPayment(db, id, orderId, overrides = {}) {
  const row = {
    amount: 12000, order_name: "fixture order", customer_name: secrets.name,
    customer_phone: secrets.phone, status: "PENDING",
    requested_at: "2026-07-01T01:02:03.000Z", payment_key: secrets.paymentKey,
    paid_at: "2026-07-01T01:12:03.000Z",
    canceled_at: "2026-07-01T01:22:03.000Z",
    canceled_amount: 3000,
    payment_method: "CARD",
    confirm_idempotency_key: "confirm-idempotency-fixture",
    cancel_idempotency_key: "cancel-idempotency-fixture",
    link_token_hash: secrets.link, link_token_expires_at: "2026-07-01T02:02:03.000Z",
    link_token_used_at: "2026-07-01T01:05:03.000Z",
    session_token_hash: secrets.session,
    session_token_expires_at: "2026-07-01T01:35:03.000Z",
    ...overrides,
  };
  db.prepare(`INSERT INTO payments
    (id,order_id,amount,order_name,customer_name,customer_phone,status,requested_at,
     payment_key,paid_at,canceled_at,canceled_amount,payment_method,
     confirm_idempotency_key,cancel_idempotency_key,
     link_token_hash,link_token_expires_at,link_token_used_at,
     session_token_hash,session_token_expires_at,cancel_reason,last_error,toss_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, orderId, row.amount, row.order_name, row.customer_name, row.customer_phone,
    row.status, row.requested_at, row.payment_key, row.paid_at, row.canceled_at,
    row.canceled_amount, row.payment_method, row.confirm_idempotency_key,
    row.cancel_idempotency_key, row.link_token_hash,
    row.link_token_expires_at, row.link_token_used_at ?? null,
    row.session_token_hash ?? null, row.session_token_expires_at ?? null,
    row.cancel_reason ?? "do-not-report", row.last_error ?? "do-not-report",
    row.toss_secret ?? "do-not-report",
  );
}

test("inventory classifies connected/orphan PII and safe rows without exposing secrets", () => {
  const db = database();
  insertOrder(db, "order-a", "ENCRYPTED");
  insertOrder(db, "order-b");
  insertPayment(db, "a", "order-a");
  insertPayment(db, "b", "order-b", { customer_name: null, customer_phone: "" });
  insertPayment(db, "c", "missing");
  insertPayment(db, "d", "also-missing", { customer_name: null, customer_phone: null });
  const result = inventoryPayments(db);
  assert.equal(result.legacyPiiConnected, 1);
  assert.equal(result.paymentSafe, 1);
  assert.equal(result.legacyPiiOrphan, 1);
  assert.equal(result.orphanSafe, 1);
  assert.deepEqual(result.byOrderPiiMode, { ENCRYPTED: 1, LEGACY: 1, NO_ORDER: 2 });
  const serialized = JSON.stringify(result);
  for (const secret of Object.values(secrets)) assert.equal(serialized.includes(secret), false);
  db.close();
});

test("all statuses are eligible and purge changes only connected name and phone", () => {
  const statuses = [
    "PENDING", "FAILED", "CONFIRMING", "DONE", "CANCELED", "PARTIAL_CANCELED",
    "RECONCILE_REQUIRED", "CANCELING",
  ];
  assert.deepEqual([...KNOWN_STATUSES].sort(), [...statuses].sort());
  for (const status of statuses) {
    const db = database();
    insertOrder(db, "order");
    insertPayment(db, "payment", "order", { status });
    const before = db.prepare("SELECT * FROM payments").get();
    assert.equal(applyPurge(db).processed, 1);
    const after = db.prepare("SELECT * FROM payments").get();
    assert.equal(after.customer_name, null);
    assert.equal(after.customer_phone, null);
    for (const key of Object.keys(before).filter((key) => !["customer_name", "customer_phone"].includes(key))) {
      assert.equal(after[key], before[key], `${status}: ${key}`);
    }
    const afterFirstApply = db.prepare("SELECT * FROM payments").get();
    assert.equal(applyPurge(db).processed, 0);
    assert.deepEqual(db.prepare("SELECT * FROM payments").get(), afterFirstApply);
    db.close();
  }
});

test("orphan PII is never modified and makes full-table verify fail", () => {
  const db = database();
  insertPayment(db, "orphan", "missing");
  assert.equal(applyPurge(db).processed, 0);
  assert.equal(db.prepare("SELECT customer_name FROM payments").get().customer_name, secrets.name);
  const result = verifyPurge(db, { batchSize: 1, limit: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.legacyPiiOrphan, 1);
  db.close();
});

test("metadata warnings are separate from eligibility and do not fail verify", () => {
  const db = database();
  insertOrder(db, "order");
  insertPayment(db, "payment", "order", {
    customer_name: null, customer_phone: null, status: "ALIEN", requested_at: "bad",
    link_token_hash: null, link_token_expires_at: "2026-07-01T00:00:00Z",
    link_token_used_at: "2026-07-01T00:00:00Z", session_token_hash: secrets.session,
    session_token_expires_at: null,
  });
  const result = verifyPurge(db);
  assert.equal(result.ok, true);
  assert.ok(Object.keys(result.warningCounts).length >= 5);
  assert.equal(result.details.length, 1);
  assert.equal(result.details[0].paymentId, "payment");
  assert.equal(result.details[0].classification, CLASSIFICATIONS.PAYMENT_SAFE);
  for (const warning of [
    "PAYMENT_STATUS_UNKNOWN",
    "PAYMENT_REQUESTED_AT_INVALID",
    "PAYMENT_LINK_METADATA_INCOMPLETE",
    "PAYMENT_LINK_USED_WITHOUT_HASH",
    "PAYMENT_SESSION_METADATA_INCOMPLETE",
  ]) {
    assert.ok(result.details[0].safeMetadataWarnings.includes(warning), warning);
  }
  db.close();
});

test("normal PAYMENT_SAFE rows count in aggregates but stay out of details and reports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "payment-pii-safe-report-"));
  const report = path.join(root, "report.jsonl");
  const db = database();
  insertOrder(db, "order");
  insertPayment(db, "normal-safe", "order", { customer_name: null, customer_phone: "" });
  const result = inventoryPayments(db);
  assert.equal(result.paymentSafe, 1);
  assert.equal(result.details.some((detail) => detail.paymentId === "normal-safe"), false);
  writeSafeReport(report, result);
  assert.equal(fs.readFileSync(report, "utf8").includes("normal-safe"), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("warning PAYMENT_SAFE rows are included in safe JSONL without secret metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "payment-pii-warning-report-"));
  const report = path.join(root, "report.jsonl");
  const db = database();
  insertOrder(db, "order");
  insertPayment(db, "warning-safe", "order", {
    customer_name: null,
    customer_phone: null,
    status: "ALIEN",
    requested_at: "bad",
    link_token_hash: null,
    link_token_expires_at: "2026-07-01T00:00:00.000Z",
    link_token_used_at: "2026-07-01T00:01:00.000Z",
    session_token_hash: secrets.session,
    session_token_expires_at: null,
  });
  const result = verifyPurge(db);
  writeSafeReport(report, result);
  const body = fs.readFileSync(report, "utf8");
  assert.equal(result.ok, true);
  assert.match(body, /"paymentId":"warning-safe"/);
  assert.match(body, /"PAYMENT_STATUS_UNKNOWN"/);
  for (const secret of Object.values(secrets)) assert.equal(body.includes(secret), false);
  for (const forbidden of ["payment_key", "toss_secret", "cancel_reason", "last_error"]) {
    assert.equal(body.includes(forbidden), false);
  }
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("unknown statuses warn but remain purge eligible and unchanged", () => {
  const db = database();
  insertOrder(db, "order");
  insertPayment(db, "unknown", "order", { status: "ALIEN" });
  const before = db.prepare("SELECT * FROM payments").get();
  const inventory = inventoryPayments(db);
  assert.equal(inventory.legacyPiiConnected, 1);
  assert.equal(inventory.warningCounts.PAYMENT_STATUS_UNKNOWN, 1);
  assert.equal(applyPurge(db).processed, 1);
  const after = db.prepare("SELECT * FROM payments").get();
  assert.equal(after.customer_name, null);
  assert.equal(after.customer_phone, null);
  for (const key of Object.keys(before).filter((key) => !["customer_name", "customer_phone"].includes(key))) {
    assert.equal(after[key], before[key], key);
  }
  assert.equal(applyPurge(db).processed, 0);
  db.close();
});

test("compare-and-update detects concurrent mutation and rolls back the batch", () => {
  const db = database();
  insertOrder(db, "order");
  insertPayment(db, "payment", "order");
  assert.throws(() => applyPurge(db, {
    beforeUpdate(row) {
      db.prepare("UPDATE payments SET customer_phone='changed' WHERE id=?").run(row.id);
    },
  }), (error) => error.code === "PAYMENT_PII_CONCURRENT_CHANGE" && error.exitCode === 5);
  assert.equal(db.prepare("SELECT customer_phone FROM payments").get().customer_phone, secrets.phone);
  db.close();
});

test("batch failure keeps earlier commits and rolls back only the failing batch", () => {
  const db = database();
  for (const id of ["a", "b", "c"]) {
    insertOrder(db, `order-${id}`);
    insertPayment(db, id, `order-${id}`);
  }
  assert.throws(() => applyPurge(db, {
    batchSize: 1,
    beforeUpdate(row) { if (row.id === "b") throw new Error("forced"); },
  }));
  assert.equal(db.prepare("SELECT customer_name FROM payments WHERE id='a'").get().customer_name, null);
  assert.equal(db.prepare("SELECT customer_name FROM payments WHERE id='b'").get().customer_name, secrets.name);
  assert.equal(applyPurge(db).processed, 2);
  db.close();
});

test("safe report is allowlisted, atomic and refuses overwrite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "payment-pii-report-"));
  const report = path.join(root, "report.jsonl");
  const db = database();
  insertPayment(db, "orphan", "missing", { session_token_hash: secrets.session });
  writeSafeReport(report, inventoryPayments(db));
  const body = fs.readFileSync(report, "utf8");
  assert.match(body, /"classification":"PAYMENT_LEGACY_PII_ORPHAN"/);
  for (const secret of Object.values(secrets)) assert.equal(body.includes(secret), false);
  for (const field of ["payment_key", "toss_secret", "cancel_reason", "last_error"]) {
    assert.equal(body.includes(field), false);
  }
  assert.throws(() => writeSafeReport(report, inventoryPayments(db)),
    (error) => error.code === "PAYMENT_PII_REPORT_EXISTS");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("runner lock shares owner-token and stale PID protections", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "payment-pii-lock-"));
  const lock = path.join(root, "runner.lock");
  const releaseA = acquireRunnerLock(lock, "apply");
  const runnerB = {
    pid: process.pid, startedAt: new Date().toISOString(), mode: "verify", ownerToken: "runner-b",
  };
  fs.writeFileSync(lock, JSON.stringify(runnerB));
  releaseA();
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, "utf8")), runnerB);
  assert.throws(() => acquireRunnerLock(lock, "verify"), (error) => error.exitCode === 8);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI enforces modes, bounds, full verify and production confirmation", () => {
  assert.equal(parseArgs([]).mode, "dry-run");
  assert.throws(() => parseArgs(["--dry-run", "--apply"]));
  assert.throws(() => parseArgs(["--include-orphans"]));
  assert.throws(() => parseArgs(["--batch-size=0"]));
  assert.throws(() => parseArgs(["--batch-size=5001"]));
  assert.throws(() => parseArgs(["--verify", "--limit=1"]),
    (error) => error.code === "PAYMENT_PII_ARGUMENT_INVALID" && error.exitCode === 2);
  assert.throws(() => parseArgs(["--verify", "--after-id=x"]));
  assert.equal(parseArgs(["--verify", "--batch-size=1"]).batchSize, 1);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => parseArgs(["--apply"]));
    assert.equal(parseArgs(["--apply", "--confirm=PURGE_PAYMENT_PII"]).mode, "apply");
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("classification helper treats empty strings as absent", () => {
  assert.equal(classifyPayment({ has_order: 1, customer_name: " ", customer_phone: "" }),
    CLASSIFICATIONS.PAYMENT_SAFE);
});
