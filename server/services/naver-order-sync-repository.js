const crypto = require("node:crypto");

const CHANNEL = "naver";
const STREAM = "order-import";
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

class NaverOrderSyncError extends Error {
  constructor(reason, status = 500) {
    super("Naver order synchronization could not be completed.");
    this.name = "NaverOrderSyncError";
    this.reason = reason;
    this.code = reason;
    this.status = status;
  }
}

function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createNaverOrderSyncRepository({ db, now = () => new Date() }) {
  const isoNow = () => now().toISOString();

  function insertRun({
    syncType, targetImportId = null, requestedFrom = null, requestedTo = null,
    actor = "system", lockExpiresAt,
  }) {
    const id = `channel-sync-${crypto.randomUUID()}`;
    const timestamp = isoNow();
    db.prepare(`INSERT INTO sales_channel_sync_runs
      (id, channel, sync_type, target_import_id, status, requested_from, requested_to, actor,
       lock_expires_at, started_at, created_at, updated_at)
      VALUES (?, 'naver', ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, syncType, targetImportId, requestedFrom, requestedTo, actor,
        lockExpiresAt, timestamp, timestamp, timestamp,
      );
    return id;
  }

  function createRun(values) {
    return insertRun({
      ...values,
      lockExpiresAt: values.lockExpiresAt
        || new Date(now().getTime() + 600000).toISOString(),
    });
  }

  function validDateTime(value) {
    return typeof value === "string" && RFC3339.test(value) && Number.isFinite(Date.parse(value));
  }

  function recoverStaleRun(run, action, actor, timestamp) {
    const result = db.prepare(`UPDATE sales_channel_sync_runs SET
      status='FAILED', safe_error_code='ORDER_IMPORT_STALE_RUN_RECOVERED',
      completed_at=?, lock_expires_at=NULL, updated_at=?
      WHERE id=? AND status='RUNNING' AND lock_expires_at<=?`)
      .run(timestamp, timestamp, run.id, timestamp);
    if (result.changes === 1) {
      insertAudit(action, actor, run.id, "FAILED", {
        safeErrorCode: "ORDER_IMPORT_STALE_RUN_RECOVERED",
      });
    }
  }

  function startPullRunWithLeaseAndAudit({
    initialLastChangedFrom, actor = "system", ttlMs = 600000,
  }) {
    return transaction(db, () => {
      const timestamp = isoNow();
      let cursor = db.prepare(`SELECT * FROM sales_channel_sync_cursors
        WHERE channel=? AND stream=?`).get(CHANNEL, STREAM);
      if (!cursor) {
        if (!validDateTime(initialLastChangedFrom)) {
          throw new NaverOrderSyncError("ORDER_IMPORT_CURSOR_REQUIRED", 400);
        }
        const initialTime = Date.parse(initialLastChangedFrom);
        if (initialTime > now().getTime() || initialTime < now().getTime() - MAX_WINDOW_MS) {
          throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
        }
        db.prepare(`INSERT INTO sales_channel_sync_cursors
          (channel, stream, initial_from, window_from, window_to, created_at, updated_at)
          VALUES (?, ?, ?, NULL, NULL, ?, ?)`)
          .run(CHANNEL, STREAM, initialLastChangedFrom, timestamp, timestamp);
        cursor = db.prepare(`SELECT * FROM sales_channel_sync_cursors
          WHERE channel=? AND stream=?`).get(CHANNEL, STREAM);
      } else if (initialLastChangedFrom !== undefined) {
        throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
      }
      if (Boolean(cursor.more_from) !== Boolean(cursor.more_sequence)) {
        throw new NaverOrderSyncError("ORDER_IMPORT_CONFLICT", 409);
      }
      if (cursor.lease_run_id && Date.parse(cursor.lease_expires_at) > now().getTime()) {
        throw new NaverOrderSyncError("ORDER_IMPORT_ALREADY_RUNNING", 409);
      }
      if (cursor.lease_run_id) {
        const stale = db.prepare(`SELECT id FROM sales_channel_sync_runs
          WHERE id=? AND status='RUNNING'`).get(cursor.lease_run_id);
        if (stale) recoverStaleRun(
          stale, "naver_order_import_pull_stale_recovered", actor, timestamp,
        );
      }
      const continuing = Boolean(cursor.more_from);
      if (continuing && (!validDateTime(cursor.window_from)
        || !validDateTime(cursor.window_to))) {
        throw new NaverOrderSyncError("ORDER_IMPORT_CONFLICT", 409);
      }
      const initialFrom = cursor.initial_from;
      const windowFrom = continuing
        ? cursor.window_from : cursor.committed_through || initialFrom;
      const windowTo = continuing
        ? cursor.window_to
        : new Date(Math.min(
          Date.parse(windowFrom) + MAX_WINDOW_MS, now().getTime(),
        )).toISOString();
      if (!validDateTime(windowFrom) || !validDateTime(windowTo)
        || Date.parse(windowTo) <= Date.parse(windowFrom)) {
        throw new NaverOrderSyncError("ORDER_IMPORT_CONFLICT", 409);
      }
      const runId = insertRun({
        syncType: "PULL", requestedFrom: windowFrom, requestedTo: windowTo,
        actor, lockExpiresAt: new Date(now().getTime() + ttlMs).toISOString(),
      });
      const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
      db.prepare(`UPDATE sales_channel_sync_cursors
        SET lease_run_id=?, lease_expires_at=?, updated_at=?
        WHERE channel=? AND stream=?`).run(runId, expiresAt, timestamp, CHANNEL, STREAM);
      insertAudit("naver_order_import_pull_started", actor, runId, "RUNNING", {
        requestedFrom: windowFrom, requestedTo: windowTo,
      });
      return {
        runId,
        initialFrom,
        windowFrom,
        windowTo,
        moreFrom: continuing ? cursor.more_from : null,
        moreSequence: continuing ? cursor.more_sequence : null,
        committedThrough: cursor.committed_through,
        continuing,
      };
    });
  }

  function startRefreshRunWithAudit({
    targetImportId, actor = "system", ttlMs = 600000,
  }) {
    return transaction(db, () => {
      const timestamp = isoNow();
      const target = db.prepare(`SELECT id FROM sales_channel_order_imports
        WHERE id=? AND channel='naver'`).get(targetImportId);
      if (!target) throw new NaverOrderSyncError("ORDER_IMPORT_NOT_FOUND", 404);
      const running = db.prepare(`SELECT id, lock_expires_at FROM sales_channel_sync_runs
        WHERE channel='naver' AND sync_type='REFRESH' AND target_import_id=?
          AND status='RUNNING'`).get(targetImportId);
      if (running && Date.parse(running.lock_expires_at) > now().getTime()) {
        throw new NaverOrderSyncError("ORDER_IMPORT_ALREADY_RUNNING", 409);
      }
      if (running) recoverStaleRun(
        running, "naver_order_import_refresh_stale_recovered", actor, timestamp,
      );
      try {
        const runId = insertRun({
          syncType: "REFRESH", targetImportId, actor,
          lockExpiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        });
        insertAudit("naver_order_import_refresh_started", actor, runId, "RUNNING", {
          importId: targetImportId,
        });
        return runId;
      } catch (error) {
        if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new NaverOrderSyncError("ORDER_IMPORT_ALREADY_RUNNING", 409);
        }
        throw error;
      }
    });
  }

  function releaseLease(runId) {
    return transaction(db, () => db.prepare(`UPDATE sales_channel_sync_cursors
      SET lease_run_id=NULL, lease_expires_at=NULL, updated_at=?
      WHERE channel=? AND stream=? AND lease_run_id=?`)
      .run(isoNow(), CHANNEL, STREAM, runId).changes);
  }

  function getCursor() {
    return db.prepare(`SELECT * FROM sales_channel_sync_cursors
      WHERE channel=? AND stream=?`).get(CHANNEL, STREAM) || null;
  }

  function advanceCursor(runId, values, audit = null) {
    return transaction(db, () => {
      const result = db.prepare(`UPDATE sales_channel_sync_cursors SET
        initial_from=COALESCE(initial_from, ?), window_from=?, window_to=?,
        more_from=?, more_sequence=?, committed_through=?, updated_at=?
        WHERE channel=? AND stream=? AND lease_run_id=?`).run(
        values.initialFrom, values.windowFrom, values.windowTo, values.moreFrom,
        values.moreSequence, values.committedThrough, isoNow(), CHANNEL, STREAM, runId,
      );
      if (result.changes !== 1) throw new NaverOrderSyncError("ORDER_IMPORT_CONFLICT", 409);
      if (audit) insertAudit(
        "naver_order_import_cursor_advanced", audit.actor, runId, "ADVANCED", audit.detail,
      );
    });
  }

  function addFailure({ runId, externalProductOrderId = null, stage, safeErrorCode, attemptCount = 1 }) {
    const timestamp = isoNow();
    db.prepare(`INSERT INTO sales_channel_sync_run_failures
      (id, sync_run_id, external_product_order_id, stage, safe_error_code,
       attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `channel-sync-failure-${crypto.randomUUID()}`, runId, externalProductOrderId,
      stage, safeErrorCode, attemptCount, timestamp, timestamp,
    );
  }

  function finishRunWithAudit(runId, values, audit) {
    return transaction(db, () => {
      const timestamp = isoNow();
      const result = db.prepare(`UPDATE sales_channel_sync_runs SET status=?,
        pages_fetched=?, discovered_count=?, detailed_count=?, imported_count=?,
        failed_count=?, provider_trace_id=?, safe_error_code=?, completed_at=?,
        lock_expires_at=NULL, updated_at=?
        WHERE id=? AND status='RUNNING'`).run(
        values.status, values.pagesFetched || 0, values.discoveredCount || 0,
        values.detailedCount || 0, values.importedCount || 0, values.failedCount || 0,
        values.providerTraceId || null, values.safeErrorCode || null, timestamp, timestamp, runId,
      );
      if (result.changes !== 1) throw new NaverOrderSyncError("ORDER_IMPORT_CONFLICT", 409);
      insertAudit(audit.action, audit.actor, runId, values.status, audit.detail);
    });
  }

  function insertAudit(action, actor, runId, status, detail = {}) {
    db.prepare(`INSERT INTO activity_logs
      (id, category, message, tab, action, entity_id, previous_value, next_value, actor, created_at)
      VALUES (?, 'INTEGRATION', ?, 'sales-channels', ?, ?, NULL, ?, ?, ?)`).run(
      `activity-${crypto.randomUUID()}`, JSON.stringify(detail), action, runId,
      status, actor || "system", isoNow(),
    );
  }

  function listImports(filters) {
    const clauses = ["h.channel='naver'"];
    const parameters = [];
    const add = (sql, value) => {
      if (value !== undefined && value !== null && value !== "") {
        clauses.push(sql);
        parameters.push(value);
      }
    };
    add("h.import_status=?", filters.importStatus);
    add("i.external_product_order_status=?", filters.externalProductOrderStatus);
    add("i.external_claim_type=?", filters.externalClaimType);
    add("i.external_claim_status=?", filters.externalClaimStatus);
    add("i.mapping_status=?", filters.mappingStatus);
    add("h.ordered_at>=?", filters.orderedFrom);
    add("h.ordered_at<=?", filters.orderedTo);
    const where = clauses.join(" AND ");
    const total = db.prepare(`SELECT COUNT(DISTINCT h.id) count
      FROM sales_channel_order_imports h
      LEFT JOIN sales_channel_order_import_items i ON i.channel_order_import_id=h.id
      WHERE ${where}`).get(...parameters).count;
    const rows = db.prepare(`SELECT DISTINCT h.id, h.external_order_id, h.import_status,
      h.external_payment_status, h.payment_method, h.order_amount, h.payment_amount,
      h.ordered_at, h.paid_at, h.orderer_name_masked, h.orderer_phone_masked,
      h.source_changed_at, h.last_synced_at, h.last_error_code, h.created_at, h.updated_at
      FROM sales_channel_order_imports h
      LEFT JOIN sales_channel_order_import_items i ON i.channel_order_import_id=h.id
      WHERE ${where} ORDER BY h.ordered_at DESC, h.id DESC LIMIT ? OFFSET ?`)
      .all(...parameters, filters.size, (filters.page - 1) * filters.size);
    return { rows, total };
  }

  function getImport(id) {
    const header = db.prepare(`SELECT id, channel, external_order_id, import_status,
      external_payment_status, payment_method, order_amount, payment_amount, ordered_at,
      paid_at, orderer_name_masked, orderer_phone_masked, source_changed_at,
      last_synced_at, last_error_code, created_at, updated_at
      FROM sales_channel_order_imports WHERE id=? AND channel='naver'`).get(id);
    if (!header) return null;
    const items = db.prepare(`SELECT id, external_product_order_id, external_channel_product_no,
      external_origin_product_no, external_claim_id, external_group_product_id,
      external_package_number, external_item_no, external_option_manage_code,
      product_mapping_id, internal_product_id, product_name_snapshot, option_name_snapshot,
      seller_product_code, initial_quantity, remaining_quantity, unit_price,
      initial_payment_amount, remaining_payment_amount, external_product_order_status,
      external_claim_type, external_claim_status, last_changed_type, source_changed_at,
      recipient_name_masked, recipient_phone_masked, mapping_status, last_error_code,
      created_at, updated_at FROM sales_channel_order_import_items
      WHERE channel_order_import_id=? ORDER BY id`).all(id);
    return { header, items };
  }

  return {
    addFailure, advanceCursor, createRun, finishRunWithAudit, getCursor,
    getImport, insertAudit, listImports, releaseLease,
    startPullRunWithLeaseAndAudit, startRefreshRunWithAudit,
  };
}

module.exports = {
  CHANNEL,
  STREAM,
  NaverOrderSyncError,
  createNaverOrderSyncRepository,
};
