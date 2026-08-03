process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "naver-order-orchestration-test-secret-32";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const express = require("express");
const request = require("supertest");
const db = require("../db");
const route = require("../routes/naver-order-imports");
const {
  NaverOrderSyncError,
  createNaverOrderSyncRepository,
} = require("../services/naver-order-sync-repository");
const {
  createNaverOrderSyncService,
  maxPages,
  safeProviderError,
} = require("../services/naver-order-sync-service");

const app = express();
app.use(express.json());
app.use("/api/sales-channels", route);

function auth(role = "super_admin") {
  return `Bearer ${jwt.sign({ sub: `fixture-${role}`, role }, process.env.JWT_SECRET)}`;
}

function cleanup() {
  db.prepare("DELETE FROM sales_channel_sync_run_failures").run();
  db.prepare("DELETE FROM sales_channel_sync_runs").run();
  db.prepare("DELETE FROM sales_channel_sync_cursors").run();
  db.prepare("DELETE FROM sales_channel_order_import_items").run();
  db.prepare("DELETE FROM sales_channel_order_imports").run();
  db.prepare("DELETE FROM activity_logs WHERE action LIKE 'naver_order_import_%'").run();
  route.setServiceFactoryForTest(null);
}

test.afterEach(cleanup);

test("migration 14 creates constrained empty cursor, run and failure tables", () => {
  assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 19);
  for (const table of [
    "sales_channel_sync_cursors", "sales_channel_sync_runs",
    "sales_channel_sync_run_failures",
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
  }
  const now = new Date().toISOString();
  assert.throws(() => db.prepare(`INSERT INTO sales_channel_sync_cursors
    (channel, stream, lease_run_id, created_at, updated_at)
    VALUES ('naver','order-import','partial',?,?)`).run(now, now), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO sales_channel_sync_runs
    (id, channel, sync_type, status, pages_fetched, started_at, created_at, updated_at)
    VALUES ('bad','naver','PULL','RUNNING',-1,?,?,?)`).run(now, now, now), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO sales_channel_sync_runs
    (id, channel, sync_type, status, started_at, completed_at, created_at, updated_at)
    VALUES ('bad-complete','naver','PULL','SUCCEEDED',?,NULL,?,?)`).run(now, now, now), /CHECK/);
  const failureColumns = db.prepare("PRAGMA table_info(sales_channel_sync_run_failures)").all();
  assert.equal(failureColumns.find((column) => column.name === "external_product_order_id").type, "TEXT");
});

test("lease is exclusive, expired leases are recoverable and another run cannot release it", () => {
  let instant = new Date("2026-07-29T12:00:00Z");
  const repository = createNaverOrderSyncRepository({ db, now: () => instant });
  const first = repository.startPullRunWithLeaseAndAudit({
    initialLastChangedFrom: "2026-07-29T00:00:00Z",
  });
  const runsBeforeConflict = db.prepare("SELECT COUNT(*) count FROM sales_channel_sync_runs").get().count;
  assert.throws(
    () => repository.startPullRunWithLeaseAndAudit({}),
    (error) => error.reason === "ORDER_IMPORT_ALREADY_RUNNING",
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_sync_runs").get().count, runsBeforeConflict);
  assert.equal(repository.releaseLease("another-run"), 0);
  assert.equal(repository.getCursor().lease_run_id, first.runId);
  instant = new Date("2026-07-29T12:11:00Z");
  const second = repository.startPullRunWithLeaseAndAudit({});
  assert.equal(repository.getCursor().lease_run_id, second.runId);
});

function snapshot(id = "101", orderId = "1") {
  return {
    header: {
      externalOrderId: orderId, importStatus: "IMPORTED", externalPaymentStatus: null,
      paymentMethod: null, orderAmount: 0, paymentAmount: 0,
      orderedAt: "2026-07-29T10:00:00Z", paidAt: null,
      sourceChangedAt: "2026-07-29T10:00:00Z", pii: {},
      ordererNameMasked: null, ordererPhoneMasked: null,
    },
    item: {
      externalOrderId: orderId, externalProductOrderId: id,
      externalChannelProductNo: null, externalOriginProductNo: null,
      externalClaimId: null, groupProductId: null, packageNumber: null,
      itemNo: null, optionManageCode: null, sellerProductCode: null,
      productNameSnapshot: "fixture", optionNameSnapshot: null,
      initialQuantity: 1, remainingQuantity: 1, unitPrice: 0,
      initialPaymentAmount: 0, remainingPaymentAmount: 0,
      externalProductOrderStatus: "PAYED", externalClaimType: null,
      externalClaimStatus: null, lastChangedType: null,
      sourceChangedAt: "2026-07-29T10:00:00Z", pii: {},
      recipientNameMasked: null, recipientPhoneMasked: null,
    },
  };
}

test("pull uses pagination, dedupes IDs, batches details and commits a safe cursor", async () => {
  const calls = [];
  const imported = [];
  const pages = [
    {
      items: [
        { orderId: "1", productOrderId: "101", lastChangedAt: "2026-07-29T10:00:00Z", lastChangedType: "PAYED" },
        { orderId: "1", productOrderId: "101", lastChangedAt: "2026-07-29T10:00:00Z", lastChangedType: "PAYED" },
      ],
      more: { moreFrom: "2026-07-29T10:00:00Z", moreSequence: "1" },
      traceId: "safe-trace",
    },
    {
      items: [{ orderId: "1", productOrderId: "102", lastChangedAt: "2026-07-29T11:00:00Z", lastChangedType: "CHANGED" }],
      more: null,
    },
  ];
  const service = createNaverOrderSyncService({
    db,
    now: () => new Date("2026-07-29T12:00:00Z"),
    orderService: {
      async getLastChangedProductOrders(args) {
        calls.push(args);
        return pages.shift();
      },
      async getProductOrders(ids) {
        return { items: ids.map((id) => snapshot(id)), traceId: null };
      },
    },
    importRepository: {
      upsertOrderImport(value) {
        imported.push(...value.items.map((item) => item.externalProductOrderId));
        return { items: value.items.map(() => ({ outcome: "insert" })) };
      },
    },
    sleep: async () => {},
  });
  const result = await service.pullOrderImports({
    initialLastChangedFrom: "2026-07-29T00:00:00Z", maxPages: 10, actor: "fixture",
  });
  assert.deepEqual(imported, ["101", "102"]);
  assert.equal(calls[1].moreSequence, "1");
  assert.deepEqual(result, {
    runId: result.runId, status: "SUCCEEDED", pagesFetched: 2,
    discoveredCount: 2, detailedCount: 2, importedCount: 2,
    failedCount: 0, cursorCommitted: true,
  });
  const cursor = db.prepare("SELECT * FROM sales_channel_sync_cursors").get();
  assert.equal(cursor.committed_through, "2026-07-29T12:00:00.000Z");
  assert.equal(cursor.more_sequence, null);
  assert.equal(cursor.lease_run_id, null);
});

test("missing detail makes the run PARTIAL, records a safe failure and holds cursor", async () => {
  const service = createNaverOrderSyncService({
    db,
    now: () => new Date("2026-07-29T12:00:00Z"),
    orderService: {
      async getLastChangedProductOrders() {
        return {
          items: [{ orderId: "1", productOrderId: "101", lastChangedAt: "2026-07-29T10:00:00Z" }],
          more: null,
        };
      },
      async getProductOrders() { return { items: [] }; },
    },
    importRepository: { upsertOrderImport() { throw new Error("must not run"); } },
    sleep: async () => {},
  });
  const result = await service.pullOrderImports({
    initialLastChangedFrom: "2026-07-29T00:00:00Z",
  });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.failedCount, 1);
  assert.equal(result.cursorCommitted, false);
  const failure = db.prepare("SELECT * FROM sales_channel_sync_run_failures").get();
  assert.equal(failure.external_product_order_id, "101");
  assert.equal(failure.safe_error_code, "ORDER_IMPORT_PROVIDER_RESPONSE_INVALID");
  assert.equal(JSON.stringify(failure).includes("must not run"), false);
});

test("repeated continuation fails safely and releases the lease", async () => {
  const service = createNaverOrderSyncService({
    db,
    now: () => new Date("2026-07-29T12:00:00Z"),
    orderService: {
      async getLastChangedProductOrders() {
        return {
          items: [],
          more: { moreFrom: "2026-07-29T01:00:00Z", moreSequence: "1" },
        };
      },
      async getProductOrders() { return { items: [] }; },
    },
    importRepository: { upsertOrderImport() { return { items: [] }; } },
    sleep: async () => {},
  });
  await assert.rejects(
    service.pullOrderImports({ initialLastChangedFrom: "2026-07-29T00:00:00Z" }),
    (error) => error.reason === "ORDER_IMPORT_PROVIDER_RESPONSE_INVALID",
  );
  assert.equal(db.prepare("SELECT lease_run_id FROM sales_channel_sync_cursors").get().lease_run_id, null);
});

test("request limits and initial cursor rules are enforced", async () => {
  assert.throws(() => maxPages(51), (error) => error.reason === "ORDER_IMPORT_REQUEST_INVALID");
  const service = createNaverOrderSyncService({
    db,
    now: () => new Date("2026-07-29T12:00:00Z"),
    orderService: {},
    importRepository: {},
  });
  await assert.rejects(
    service.pullOrderImports({ initialLastChangedFrom: "2026-07-27T00:00:00Z" }),
    (error) => error.reason === "ORDER_IMPORT_REQUEST_INVALID",
  );
});

test("continuation reuses its fixed window even when the current time advances", async () => {
  let instant = new Date("2026-07-29T12:00:00Z");
  const calls = [];
  const orderService = {
    async getLastChangedProductOrders(args) {
      calls.push({ ...args });
      return calls.length === 1
        ? { items: [], more: { moreFrom: "2026-07-29T10:00:00Z", moreSequence: "9" } }
        : { items: [], more: null };
    },
    async getProductOrders() { return { items: [] }; },
  };
  const service = createNaverOrderSyncService({
    db, now: () => instant, orderService,
    importRepository: { upsertOrderImport() { return { items: [] }; } },
    sleep: async () => {},
  });
  await service.pullOrderImports({
    initialLastChangedFrom: "2026-07-29T00:00:00Z", maxPages: 1,
  });
  const saved = db.prepare("SELECT window_from, window_to FROM sales_channel_sync_cursors").get();
  instant = new Date("2026-07-29T20:00:00Z");
  await service.pullOrderImports({ maxPages: 1 });
  assert.equal(calls[1].lastChangedFrom, "2026-07-29T10:00:00Z");
  assert.equal(calls[1].moreSequence, "9");
  assert.equal(calls[1].lastChangedTo, saved.window_to);
  const completed = db.prepare("SELECT committed_through FROM sales_channel_sync_cursors").get();
  assert.equal(completed.committed_through, saved.window_to);
});

test("continuation without its original window is rejected without creating a run", async () => {
  const now = "2026-07-29T12:00:00.000Z";
  db.prepare(`INSERT INTO sales_channel_sync_cursors
    (channel, stream, initial_from, more_from, more_sequence, created_at, updated_at)
    VALUES ('naver','order-import','2026-07-29T00:00:00Z',
      '2026-07-29T10:00:00Z','1',?,?)`).run(now, now);
  const service = createNaverOrderSyncService({
    db, now: () => new Date(now), orderService: {}, importRepository: {},
  });
  await assert.rejects(
    service.pullOrderImports({}),
    (error) => error.reason === "ORDER_IMPORT_CONFLICT",
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_sync_runs").get().count, 0);
});

test("run completion and its audit record commit or rollback together", () => {
  const repository = createNaverOrderSyncRepository({ db });
  const runId = repository.createRun({ syncType: "PULL" });
  db.exec(`CREATE TEMP TRIGGER fail_sync_completion_audit BEFORE INSERT ON activity_logs
    WHEN NEW.action='naver_order_import_pull_completed'
    BEGIN SELECT RAISE(FAIL, 'fixture audit failure'); END`);
  try {
    assert.throws(() => repository.finishRunWithAudit(
      runId,
      { status: "SUCCEEDED", pagesFetched: 1 },
      { action: "naver_order_import_pull_completed", actor: "fixture", detail: {} },
    ));
    assert.equal(
      db.prepare(`SELECT status, lock_expires_at FROM sales_channel_sync_runs
        WHERE id=?`).get(runId).status,
      "RUNNING",
    );
    assert.ok(db.prepare("SELECT lock_expires_at FROM sales_channel_sync_runs WHERE id=?")
      .get(runId).lock_expires_at);
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM activity_logs
      WHERE entity_id=? AND action='naver_order_import_pull_completed'`).get(runId).count, 0);
  } finally {
    db.exec("DROP TRIGGER fail_sync_completion_audit");
  }
  repository.finishRunWithAudit(
    runId,
    { status: "SUCCEEDED", pagesFetched: 1 },
    { action: "naver_order_import_pull_completed", actor: "fixture", detail: {} },
  );
  assert.deepEqual({
    ...db.prepare(`SELECT status, lock_expires_at FROM sales_channel_sync_runs
      WHERE id=?`).get(runId),
  }, { status: "SUCCEEDED", lock_expires_at: null });
});

test("pull and refresh started audits are atomic with their runs and locks", () => {
  let instant = new Date("2026-07-29T12:00:00Z");
  const repository = createNaverOrderSyncRepository({ db, now: () => instant });
  db.exec(`CREATE TEMP TRIGGER fail_pull_started BEFORE INSERT ON activity_logs
    WHEN NEW.action='naver_order_import_pull_started'
    BEGIN SELECT RAISE(FAIL, 'fixture pull started audit failure'); END`);
  try {
    assert.throws(() => repository.startPullRunWithLeaseAndAudit({
      initialLastChangedFrom: "2026-07-29T00:00:00Z",
    }));
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_sync_runs").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_sync_cursors").get().count, 0);
  } finally {
    db.exec("DROP TRIGGER fail_pull_started");
  }

  const now = instant.toISOString();
  db.prepare(`INSERT INTO sales_channel_order_imports
    (id, channel, external_order_id, import_status, created_at, updated_at)
    VALUES ('atomic-refresh','naver','atomic-refresh','IMPORTED',?,?)`).run(now, now);
  db.exec(`CREATE TEMP TRIGGER fail_refresh_started BEFORE INSERT ON activity_logs
    WHEN NEW.action='naver_order_import_refresh_started'
    BEGIN SELECT RAISE(FAIL, 'fixture refresh started audit failure'); END`);
  try {
    assert.throws(() => repository.startRefreshRunWithAudit({
      targetImportId: "atomic-refresh",
    }));
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_sync_runs").get().count, 0);
  } finally {
    db.exec("DROP TRIGGER fail_refresh_started");
  }
});

test("expired pull and refresh locks recover stale runs atomically", () => {
  let instant = new Date("2026-07-29T12:00:00Z");
  const repository = createNaverOrderSyncRepository({ db, now: () => instant });
  const pull = repository.startPullRunWithLeaseAndAudit({
    initialLastChangedFrom: "2026-07-29T00:00:00Z",
  });
  const now = instant.toISOString();
  db.prepare(`INSERT INTO sales_channel_order_imports
    (id, channel, external_order_id, import_status, created_at, updated_at)
    VALUES ('stale-refresh','naver','stale-refresh','IMPORTED',?,?)`).run(now, now);
  const refresh = repository.startRefreshRunWithAudit({ targetImportId: "stale-refresh" });

  instant = new Date("2026-07-29T12:11:00Z");
  const nextPull = repository.startPullRunWithLeaseAndAudit({});
  const nextRefresh = repository.startRefreshRunWithAudit({ targetImportId: "stale-refresh" });
  for (const id of [pull.runId, refresh]) {
    const stale = db.prepare(`SELECT status, safe_error_code, completed_at, lock_expires_at
      FROM sales_channel_sync_runs WHERE id=?`).get(id);
    assert.equal(stale.status, "FAILED");
    assert.equal(stale.safe_error_code, "ORDER_IMPORT_STALE_RUN_RECOVERED");
    assert.ok(stale.completed_at);
    assert.equal(stale.lock_expires_at, null);
  }
  assert.equal(db.prepare("SELECT lease_run_id FROM sales_channel_sync_cursors").get().lease_run_id, nextPull.runId);
  assert.ok(nextRefresh);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM activity_logs WHERE action IN (
    'naver_order_import_pull_stale_recovered',
    'naver_order_import_refresh_stale_recovered'
  )`).get().count, 2);
});

test("safe synchronization errors preserve every public reason", () => {
  for (const reason of [
    "ORDER_IMPORT_ALREADY_RUNNING", "ORDER_IMPORT_CURSOR_REQUIRED",
    "ORDER_IMPORT_REQUEST_INVALID", "ORDER_IMPORT_PROVIDER_UNAVAILABLE",
    "ORDER_IMPORT_PROVIDER_RATE_LIMITED", "ORDER_IMPORT_PROVIDER_TIMEOUT",
    "ORDER_IMPORT_PROVIDER_RESPONSE_INVALID", "ORDER_IMPORT_PARTIAL_FAILURE",
    "ORDER_IMPORT_NOT_FOUND", "ORDER_IMPORT_EMPTY", "ORDER_IMPORT_CONFLICT",
    "ORDER_IMPORT_ABORTED",
  ]) {
    assert.equal(safeProviderError(new NaverOrderSyncError(reason)), reason);
  }
  assert.equal(safeProviderError({ status: 429 }), "ORDER_IMPORT_PROVIDER_RATE_LIMITED");
  assert.equal(safeProviderError({ code: "NAVER_TIMEOUT" }), "ORDER_IMPORT_PROVIDER_TIMEOUT");
});

test("refresh run locking is per import and completed runs release the lock", () => {
  const now = new Date().toISOString();
  for (const id of ["refresh-one", "refresh-two"]) {
    db.prepare(`INSERT INTO sales_channel_order_imports
      (id, channel, external_order_id, import_status, created_at, updated_at)
      VALUES (?, 'naver', ?, 'IMPORTED', ?, ?)`).run(id, id, now, now);
  }
  const repository = createNaverOrderSyncRepository({ db });
  const first = repository.startRefreshRunWithAudit({ targetImportId: "refresh-one" });
  const runCount = db.prepare("SELECT COUNT(*) count FROM sales_channel_sync_runs").get().count;
  assert.throws(
    () => repository.startRefreshRunWithAudit({ targetImportId: "refresh-one" }),
    (error) => error.reason === "ORDER_IMPORT_ALREADY_RUNNING",
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_sync_runs").get().count, runCount);
  assert.doesNotThrow(() => repository.startRefreshRunWithAudit({ targetImportId: "refresh-two" }));
  repository.finishRunWithAudit(
    first,
    { status: "SUCCEEDED" },
    { action: "naver_order_import_refresh_completed", actor: "fixture", detail: {} },
  );
  assert.doesNotThrow(() => repository.startRefreshRunWithAudit({ targetImportId: "refresh-one" }));
});

test("ordered date ranges must be forward and pagination metadata uses distinct headers", () => {
  const service = createNaverOrderSyncService({
    db, orderService: {}, importRepository: {},
  });
  assert.throws(
    () => service.listOrderImports({
      orderedFrom: "2026-07-30T00:00:00Z",
      orderedTo: "2026-07-29T00:00:00Z",
    }),
    (error) => error.reason === "ORDER_IMPORT_REQUEST_INVALID",
  );
  const empty = service.listOrderImports({ page: 2, size: 1 });
  assert.deepEqual(
    { total: empty.total, totalPages: empty.totalPages, first: empty.first, last: empty.last },
    { total: 0, totalPages: 0, first: false, last: true },
  );
});

test("refresh completes without moving the cursor and caller abort records ABORTED", async () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sales_channel_order_imports
    (id, channel, external_order_id, import_status, created_at, updated_at)
    VALUES ('refresh-target','naver','1','IMPORTED',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sales_channel_order_import_items
    (id, channel, channel_order_import_id, external_product_order_id,
     mapping_status, created_at, updated_at)
    VALUES ('refresh-target-item','naver','refresh-target','101','UNMAPPED',?,?)`)
    .run(now, now);
  db.prepare(`INSERT INTO sales_channel_sync_cursors
    (channel, stream, initial_from, committed_through, created_at, updated_at)
    VALUES ('naver','order-import','2026-07-29T00:00:00Z',
      '2026-07-29T12:00:00Z',?,?)`).run(now, now);
  const imported = [];
  const service = createNaverOrderSyncService({
    db,
    orderService: {
      async getProductOrders(ids) {
        return { items: ids.map((id) => snapshot(id)) };
      },
    },
    importRepository: {
      upsertOrderImport(value) {
        imported.push(...value.items.map((item) => item.externalProductOrderId));
        return { items: value.items.map(() => ({ outcome: "update" })) };
      },
    },
    sleep: async () => {},
  });
  const result = await service.refreshOrderImport({ importId: "refresh-target" });
  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(imported, ["101"]);
  assert.equal(
    db.prepare("SELECT committed_through FROM sales_channel_sync_cursors").get().committed_through,
    "2026-07-29T12:00:00Z",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.refreshOrderImport({ importId: "refresh-target", signal: controller.signal }),
    (error) => error.reason === "ORDER_IMPORT_ABORTED",
  );
  const aborted = db.prepare(`SELECT status, safe_error_code FROM sales_channel_sync_runs
    WHERE target_import_id='refresh-target' ORDER BY rowid DESC`).get();
  assert.deepEqual({ ...aborted }, {
    status: "ABORTED", safe_error_code: "ORDER_IMPORT_ABORTED",
  });
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM activity_logs
    WHERE action='naver_order_import_refresh_aborted'`).get().count, 1);
});

test("pull and refresh require manage while list and detail allow read roles", async () => {
  route.setServiceFactoryForTest(() => ({
    pullOrderImports: async () => ({ status: "SUCCEEDED" }),
    refreshOrderImport: async () => ({ status: "SUCCEEDED" }),
    listOrderImports: () => ({ items: [] }),
    getOrderImport: () => ({ header: {}, items: [] }),
  }));
  await request(app).post("/api/sales-channels/naver/order-imports/pull").expect(401);
  for (const role of ["viewer", "operations", "finance"]) {
    await request(app).post("/api/sales-channels/naver/order-imports/pull")
      .set("Authorization", auth(role)).send({}).expect(403);
    await request(app).get("/api/sales-channels/naver/order-imports")
      .set("Authorization", auth(role)).expect(200);
  }
  await request(app).post("/api/sales-channels/naver/order-imports/pull")
    .set("Authorization", auth()).send({}).expect(200);
  await request(app).post("/api/sales-channels/naver/order-imports/id/refresh")
    .set("Authorization", auth("viewer")).expect(403);
  await request(app).post("/api/sales-channels/naver/order-imports/id/refresh")
    .set("Authorization", auth()).expect(200);
});

test("list and detail expose no encrypted or private columns", () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sales_channel_order_imports
    (id, channel, external_order_id, import_status, orderer_name_masked,
     order_pii_ciphertext, order_pii_iv, order_pii_auth_tag, order_pii_key_version,
     created_at, updated_at)
    VALUES ('safe-import','naver','1234','IMPORTED','F***','cipher','iv','tag','v1',?,?)`)
    .run(now, now);
  db.prepare(`INSERT INTO sales_channel_order_import_items
    (id, channel, channel_order_import_id, external_product_order_id,
     item_pii_ciphertext, item_pii_iv, item_pii_auth_tag, item_pii_key_version,
     mapping_status, created_at, updated_at)
    VALUES ('safe-item','naver','safe-import','5678','cipher','iv','tag','v1','UNMAPPED',?,?)`)
    .run(now, now);
  const service = createNaverOrderSyncService({
    db, orderService: {}, importRepository: {},
  });
  const text = JSON.stringify({
    list: service.listOrderImports({}),
    detail: service.getOrderImport("safe-import"),
  });
  for (const forbidden of ["ciphertext", "authTag", "keyVersion", "\"cipher\"", "\"iv\"", "\"tag\""]) {
    assert.equal(text.includes(forbidden), false);
  }
  assert.equal(text.includes("F***"), true);
  assert.throws(
    () => service.getOrderImport("missing"),
    (error) => error.reason === "ORDER_IMPORT_NOT_FOUND",
  );
});
