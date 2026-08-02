const {
  createNaverOrderImportRepository,
  dateTime,
} = require("./naver-order-import-service");
const { createNaverOrderService } = require("./naver-order-service");
const {
  NaverOrderSyncError,
  createNaverOrderSyncRepository,
} = require("./naver-order-sync-repository");

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES = 50;
const BATCH_SIZE = 300;
const FILTER_VALUES = {
  importStatus: new Set(["DISCOVERED", "IMPORTED", "PARTIAL", "RETRY_PENDING", "FAILED", "MANUAL_REVIEW"]),
  mappingStatus: new Set(["MAPPED", "UNMAPPED"]),
};

function maxPages(value) {
  const parsed = value === undefined ? DEFAULT_MAX_PAGES : value;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGES) {
    throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
  }
  return parsed;
}

function safeProviderError(error) {
  if (error instanceof NaverOrderSyncError) return error.reason;
  if (error?.reason === "ORDER_IMPORT_ABORTED" || error?.name === "AbortError"
    || error?.code === "NAVER_REQUEST_ABORTED") return "ORDER_IMPORT_ABORTED";
  if (error?.status === 429 || error?.code === "NAVER_RATE_LIMITED") {
    return "ORDER_IMPORT_PROVIDER_RATE_LIMITED";
  }
  if (error?.code === "NAVER_TIMEOUT" || error?.code === "ABORT_ERR") {
    return "ORDER_IMPORT_PROVIDER_TIMEOUT";
  }
  if (error?.code === "NAVER_ORDER_RESPONSE_INVALID"
    || error?.code === "NAVER_ORDER_IDENTIFIER_MISMATCH") {
    return "ORDER_IMPORT_PROVIDER_RESPONSE_INVALID";
  }
  return "ORDER_IMPORT_PROVIDER_UNAVAILABLE";
}

function publicHeader(row) {
  return {
    id: row.id,
    channel: row.channel,
    externalOrderId: row.external_order_id,
    importStatus: row.import_status,
    externalPaymentStatus: row.external_payment_status,
    paymentMethod: row.payment_method,
    orderAmount: row.order_amount,
    paymentAmount: row.payment_amount,
    orderedAt: row.ordered_at,
    paidAt: row.paid_at,
    ordererNameMasked: row.orderer_name_masked,
    ordererPhoneMasked: row.orderer_phone_masked,
    sourceChangedAt: row.source_changed_at,
    lastSyncedAt: row.last_synced_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicItem(row) {
  return {
    id: row.id,
    externalProductOrderId: row.external_product_order_id,
    externalChannelProductNo: row.external_channel_product_no,
    externalOriginProductNo: row.external_origin_product_no,
    externalClaimId: row.external_claim_id,
    externalGroupProductId: row.external_group_product_id,
    externalPackageNumber: row.external_package_number,
    externalItemNo: row.external_item_no,
    externalOptionManageCode: row.external_option_manage_code,
    productMappingId: row.product_mapping_id,
    internalProductId: row.internal_product_id,
    productNameSnapshot: row.product_name_snapshot,
    optionNameSnapshot: row.option_name_snapshot,
    sellerProductCode: row.seller_product_code,
    initialQuantity: row.initial_quantity,
    remainingQuantity: row.remaining_quantity,
    unitPrice: row.unit_price,
    initialPaymentAmount: row.initial_payment_amount,
    remainingPaymentAmount: row.remaining_payment_amount,
    externalProductOrderStatus: row.external_product_order_status,
    externalClaimType: row.external_claim_type,
    externalClaimStatus: row.external_claim_status,
    lastChangedType: row.last_changed_type,
    sourceChangedAt: row.source_changed_at,
    recipientNameMasked: row.recipient_name_masked,
    recipientPhoneMasked: row.recipient_phone_masked,
    mappingStatus: row.mapping_status,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createNaverOrderSyncService({
  db,
  orderService = createNaverOrderService(),
  importRepository,
  now = () => new Date(),
  syncRepository = createNaverOrderSyncRepository({ db, now }),
  piiKey = process.env.NAVER_ORDER_PII_KEY,
  piiKeyVersion = process.env.NAVER_ORDER_PII_KEY_VERSION || "v1",
  sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new NaverOrderSyncError("ORDER_IMPORT_ABORTED", 400));
    }, { once: true });
  }),
} = {}) {
  if (!db) throw new TypeError("DB_REQUIRED");
  const imports = importRepository || createNaverOrderImportRepository({
    db, piiKey, piiKeyVersion,
  });

  async function providerCall(work, signal) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (signal?.aborted) throw new NaverOrderSyncError("ORDER_IMPORT_ABORTED", 400);
      try {
        return await work();
      } catch (error) {
        lastError = error;
        const code = safeProviderError(error);
        if (code === "ORDER_IMPORT_ABORTED"
          || code === "ORDER_IMPORT_PROVIDER_RESPONSE_INVALID" || attempt === 3) throw error;
        const delay = code === "ORDER_IMPORT_PROVIDER_RATE_LIMITED" && error.retryAfterMs
          ? Math.min(error.retryAfterMs, 30000) : 100 * (2 ** (attempt - 1));
        await sleep(delay, signal);
      }
    }
    throw lastError;
  }

  function validateInitial(value) {
    let normalized;
    try {
      normalized = dateTime(value, { required: true });
    } catch {
      throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
    }
    const timestamp = Date.parse(normalized);
    const current = now().getTime();
    if (timestamp > current || timestamp < current - MAX_WINDOW_MS) {
      throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
    }
    return normalized;
  }

  function groupAndPersist(details, feedById, actor, onFailure = null) {
    const groups = new Map();
    for (const detail of details) {
      const id = detail.item.externalProductOrderId;
      const feed = feedById?.get(id);
      if (feed && (feed.orderId !== detail.header.externalOrderId || feed.productOrderId !== id)) {
        throw new NaverOrderSyncError("ORDER_IMPORT_PROVIDER_RESPONSE_INVALID", 502);
      }
      if (feed) {
        detail.header.sourceChangedAt = feed.lastChangedAt;
        detail.item.sourceChangedAt = feed.lastChangedAt;
        detail.item.lastChangedType = feed.lastChangedType;
      }
      const key = detail.header.externalOrderId;
      if (!groups.has(key)) groups.set(key, { header: detail.header, items: [] });
      groups.get(key).items.push(detail.item);
    }
    let imported = 0;
    let failed = 0;
    for (const group of groups.values()) {
      try {
        const result = imports.upsertOrderImport({ ...group, actor });
        imported += result.items.length;
      } catch (error) {
        failed += group.items.length;
        if (onFailure) {
          for (const item of group.items) onFailure(item, error);
        }
      }
    }
    return { imported, failed };
  }

  async function pullOrderImports({
    initialLastChangedFrom, maxPages: requestedMaxPages, actor = "system", signal,
  } = {}) {
    const limit = maxPages(requestedMaxPages);
    const started = syncRepository.startPullRunWithLeaseAndAudit({
      initialLastChangedFrom, actor,
    });
    const {
      runId, initialFrom: initial, windowFrom, windowTo,
      moreFrom, moreSequence, committedThrough, continuing,
    } = started;
    const counts = {
      pagesFetched: 0, discoveredCount: 0, detailedCount: 0, importedCount: 0, failedCount: 0,
    };
    let lease = false;
    let finalizing = false;
    let runFinalized = false;
    let providerTraceId = null;
    let cursorCommitted = false;
    try {
      lease = true;
      let from = continuing ? moreFrom : windowFrom;
      let sequence = continuing ? moreSequence : null;
      const seenContinuations = new Set();
      for (let pageNumber = 0; pageNumber < limit; pageNumber += 1) {
        if (signal?.aborted) throw new NaverOrderSyncError("ORDER_IMPORT_ABORTED", 400);
        let page;
        try {
          page = await providerCall(() => orderService.getLastChangedProductOrders({
            lastChangedFrom: from, lastChangedTo: windowTo, moreSequence: sequence,
            limitCount: 300, signal,
          }), signal);
        } catch (error) {
          syncRepository.addFailure({
            runId, stage: "CHANGE_FEED", safeErrorCode: safeProviderError(error),
          });
          throw error;
        }
        counts.pagesFetched += 1;
        providerTraceId = page.traceId || providerTraceId;
        const feedItems = [...new Map(page.items.map((item) => [item.productOrderId, item])).values()];
        counts.discoveredCount += feedItems.length;
        const feedById = new Map(feedItems.map((item) => [item.productOrderId, item]));
        const ids = [...feedById.keys()];
        const details = [];
        let pageFailed = false;
        for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
          const batch = ids.slice(offset, offset + BATCH_SIZE);
          try {
            const response = await providerCall(
              () => orderService.getProductOrders(batch, { signal }), signal,
            );
            providerTraceId = response.traceId || providerTraceId;
            const returned = new Map(response.items.map(
              (entry) => [entry.item.externalProductOrderId, entry],
            ));
            for (const id of batch) {
              if (!returned.has(id)) {
                pageFailed = true;
                counts.failedCount += 1;
                syncRepository.addFailure({
                  runId, externalProductOrderId: id, stage: "DETAIL_FETCH",
                  safeErrorCode: "ORDER_IMPORT_PROVIDER_RESPONSE_INVALID",
                });
              } else {
                details.push(returned.get(id));
                counts.detailedCount += 1;
              }
            }
          } catch (error) {
            if (safeProviderError(error) === "ORDER_IMPORT_ABORTED") throw error;
            pageFailed = true;
            for (const id of batch) {
              counts.failedCount += 1;
              syncRepository.addFailure({
                runId, externalProductOrderId: id, stage: "DETAIL_FETCH",
                safeErrorCode: safeProviderError(error),
              });
            }
          }
        }
        const persisted = groupAndPersist(details, feedById, actor, (item) => {
          pageFailed = true;
          syncRepository.addFailure({
            runId, externalProductOrderId: item.externalProductOrderId,
            stage: "PERSISTENCE", safeErrorCode: "ORDER_IMPORT_CONFLICT",
          });
        });
        counts.importedCount += persisted.imported;
        counts.failedCount += persisted.failed;
        if (pageFailed) break;
        const more = page.more;
        if (more && (!more.moreFrom || !more.moreSequence)) {
          throw new NaverOrderSyncError("ORDER_IMPORT_PROVIDER_RESPONSE_INVALID", 502);
        }
        const continuation = more ? `${more.moreFrom}\u0000${more.moreSequence}` : null;
        if (continuation && seenContinuations.has(continuation)) {
          throw new NaverOrderSyncError("ORDER_IMPORT_PROVIDER_RESPONSE_INVALID", 502);
        }
        if (continuation) seenContinuations.add(continuation);
        syncRepository.advanceCursor(runId, {
          initialFrom: initial,
          windowFrom,
          windowTo,
          moreFrom: more?.moreFrom || null,
          moreSequence: more?.moreSequence || null,
          committedThrough: more ? committedThrough : windowTo,
        }, {
          actor,
          detail: { committedThrough: more ? null : windowTo },
        });
        cursorCommitted = true;
        if (!more) break;
        from = more.moreFrom;
        sequence = more.moreSequence;
      }
      const status = counts.failedCount ? "PARTIAL" : "SUCCEEDED";
      finalizing = true;
      syncRepository.finishRunWithAudit(
        runId,
        { ...counts, status, providerTraceId },
        {
          action: status === "PARTIAL" ? "naver_order_import_pull_partial"
            : "naver_order_import_pull_completed",
          actor,
          detail: counts,
        },
      );
      finalizing = false;
      runFinalized = true;
      return { runId, status, ...counts, cursorCommitted };
    } catch (error) {
      if (finalizing) throw error;
      const code = safeProviderError(error);
      const status = code === "ORDER_IMPORT_ABORTED" ? "ABORTED" : "FAILED";
      try {
        syncRepository.finishRunWithAudit(
          runId,
          { ...counts, status, providerTraceId, safeErrorCode: code },
          {
            action: status === "ABORTED" ? "naver_order_import_pull_aborted"
              : "naver_order_import_pull_failed",
            actor,
            detail: { safeErrorCode: code },
          },
        );
        runFinalized = true;
      } catch {
        // Preserve the original safe failure.
      }
      if (error instanceof NaverOrderSyncError) throw error;
      throw new NaverOrderSyncError(
        code,
        code === "ORDER_IMPORT_ALREADY_RUNNING" || code === "ORDER_IMPORT_CONFLICT" ? 409
          : code === "ORDER_IMPORT_REQUEST_INVALID" ? 400
            : code.includes("RATE_LIMITED") ? 503 : 502,
      );
    } finally {
      if (lease && runFinalized) syncRepository.releaseLease(runId);
    }
  }

  function listOrderImports(filters = {}) {
    const page = filters.page === undefined ? 1 : Number(filters.page);
    const size = filters.size === undefined ? 50 : Number(filters.size);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) {
      throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
    }
    for (const [key, allowed] of Object.entries(FILTER_VALUES)) {
      if (filters[key] && !allowed.has(filters[key])) {
        throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
      }
    }
    for (const key of ["orderedFrom", "orderedTo"]) {
      if (filters[key]) {
        try { dateTime(filters[key], { required: true }); } catch {
          throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
        }
      }
    }
    if (filters.orderedFrom && filters.orderedTo
      && Date.parse(filters.orderedFrom) > Date.parse(filters.orderedTo)) {
      throw new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400);
    }
    const { rows, total } = syncRepository.listImports({ ...filters, page, size });
    const totalPages = Math.ceil(total / size);
    return {
      items: rows.map(publicHeader), page, size, total, totalPages,
      first: page === 1, last: totalPages === 0 || page >= totalPages,
    };
  }

  function getOrderImport(id) {
    const value = syncRepository.getImport(id);
    if (!value) throw new NaverOrderSyncError("ORDER_IMPORT_NOT_FOUND", 404);
    return { header: publicHeader(value.header), items: value.items.map(publicItem) };
  }

  async function refreshOrderImport({ importId, actor = "system", signal }) {
    const value = syncRepository.getImport(importId);
    if (!value) throw new NaverOrderSyncError("ORDER_IMPORT_NOT_FOUND", 404);
    if (!value.items.length) throw new NaverOrderSyncError("ORDER_IMPORT_EMPTY", 409);
    const runId = syncRepository.startRefreshRunWithAudit({
      targetImportId: importId, actor,
    });
    const counts = {
      pagesFetched: 0, discoveredCount: value.items.length, detailedCount: 0,
      importedCount: 0, failedCount: 0,
    };
    let finalizing = false;
    try {
      const details = [];
      for (let offset = 0; offset < value.items.length; offset += BATCH_SIZE) {
        const batch = value.items.slice(offset, offset + BATCH_SIZE)
          .map((item) => item.external_product_order_id);
        try {
          const response = await providerCall(
            () => orderService.getProductOrders(batch, { signal }), signal,
          );
          const returned = new Map(response.items.map(
            (entry) => [entry.item.externalProductOrderId, entry],
          ));
          for (const id of batch) {
            const detail = returned.get(id);
            if (detail && detail.header.externalOrderId === value.header.external_order_id) {
              details.push(detail);
              counts.detailedCount += 1;
            } else {
              counts.failedCount += 1;
              syncRepository.addFailure({
                runId, externalProductOrderId: id, stage: "REFRESH",
                safeErrorCode: "ORDER_IMPORT_PROVIDER_RESPONSE_INVALID",
              });
            }
          }
        } catch (error) {
          if (safeProviderError(error) === "ORDER_IMPORT_ABORTED") throw error;
          for (const id of batch) {
            counts.failedCount += 1;
            syncRepository.addFailure({
              runId, externalProductOrderId: id, stage: "REFRESH",
              safeErrorCode: safeProviderError(error),
            });
          }
        }
      }
      const persisted = groupAndPersist(details, null, actor, (item) => {
        syncRepository.addFailure({
          runId, externalProductOrderId: item.externalProductOrderId,
          stage: "REFRESH", safeErrorCode: "ORDER_IMPORT_CONFLICT",
        });
      });
      counts.importedCount = persisted.imported;
      counts.failedCount += persisted.failed;
      const status = counts.failedCount ? "PARTIAL" : "SUCCEEDED";
      finalizing = true;
      syncRepository.finishRunWithAudit(
        runId,
        { ...counts, status },
        {
          action: status === "PARTIAL" ? "naver_order_import_refresh_partial"
            : "naver_order_import_refresh_completed",
          actor,
          detail: { importId, ...counts },
        },
      );
      finalizing = false;
      return { runId, status, ...counts };
    } catch (error) {
      if (finalizing) throw error;
      const code = safeProviderError(error);
      const status = code === "ORDER_IMPORT_ABORTED" ? "ABORTED" : "FAILED";
      syncRepository.finishRunWithAudit(
        runId,
        { ...counts, status, safeErrorCode: code },
        {
          action: status === "ABORTED" ? "naver_order_import_refresh_aborted"
            : "naver_order_import_refresh_failed",
          actor,
          detail: { importId, safeErrorCode: code },
        },
      );
      if (error instanceof NaverOrderSyncError) throw error;
      throw new NaverOrderSyncError(code, 502);
    }
  }

  return {
    getOrderImport, listOrderImports, pullOrderImports, refreshOrderImport,
  };
}

module.exports = {
  BATCH_SIZE,
  DEFAULT_MAX_PAGES,
  MAX_PAGES,
  MAX_WINDOW_MS,
  createNaverOrderSyncService,
  maxPages,
  safeProviderError,
};
