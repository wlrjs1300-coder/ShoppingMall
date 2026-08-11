const express = require("express");
const db = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { createNaverOrderSyncService } = require("../services/naver-order-sync-service");
const { NaverOrderSyncError } = require("../services/naver-order-sync-repository");
const {
  NaverOrderConversionError,
  convertNaverOrderImport,
  getNaverOrderConversion,
  listNaverOrderConversions,
  retryNaverOrderConversions,
  summarizeNaverOrderConversions,
} = require("../services/naver-order-conversion-service");
const { synchronizeNaverOrderStatus } = require("../services/naver-order-status-sync-service");

const router = express.Router();
const defaultService = createNaverOrderSyncService({ db });
const defaultServiceFactory = () => defaultService;
let serviceFactory = defaultServiceFactory;

function safeError(res, error) {
  const reason = error instanceof NaverOrderSyncError
    ? error.reason : "ORDER_IMPORT_PROVIDER_UNAVAILABLE";
  const status = error instanceof NaverOrderSyncError ? error.status : 500;
  return res.status(status).json({
    error: "Naver order import request could not be completed.",
    reason,
  });
}

router.post(
  "/naver/order-imports/pull",
  requireAuth,
  requirePermission("sales_channels:manage"),
  async (req, res) => {
    const body = req.body || {};
    if (Object.keys(body).some(
      (field) => !["initialLastChangedFrom", "maxPages"].includes(field),
    )) {
      return safeError(res, new NaverOrderSyncError("ORDER_IMPORT_REQUEST_INVALID", 400));
    }
    try {
      return res.json(await serviceFactory().pullOrderImports({
        initialLastChangedFrom: body.initialLastChangedFrom,
        maxPages: body.maxPages,
        actor: req.admin.id,
        signal: req.signal,
      }));
    } catch (error) {
      return safeError(res, error);
    }
  },
);

router.get(
  "/naver/order-imports",
  requireAuth,
  requirePermission("sales_channels:read"),
  (req, res) => {
    try {
      return res.json(serviceFactory().listOrderImports(req.query));
    } catch (error) {
      return safeError(res, error);
    }
  },
);

router.get(
  "/naver/order-imports/:id",
  requireAuth,
  requirePermission("sales_channels:read"),
  (req, res) => {
    try {
      return res.json(serviceFactory().getOrderImport(req.params.id));
    } catch (error) {
      return safeError(res, error);
    }
  },
);

router.post(
  "/naver/order-imports/:id/refresh",
  requireAuth,
  requirePermission("sales_channels:manage"),
  async (req, res) => {
    try {
      return res.json(await serviceFactory().refreshOrderImport({
        importId: req.params.id, actor: req.admin.id, signal: req.signal,
      }));
    } catch (error) {
      return safeError(res, error);
    }
  },
);

router.post(
  "/naver/order-imports/:id/convert",
  requireAuth,
  requirePermission("sales_channels:manage"),
  (req, res) => {
    try {
      const result = convertNaverOrderImport(req.params.id, { actor: req.admin.id });
      return res.status(result.status === "CONVERTED" ? 200 : 409).json(result);
    } catch (error) {
      if (error instanceof NaverOrderConversionError && error.code === "NAVER_ORDER_IMPORT_NOT_FOUND") {
        return res.status(404).json({ reason: error.code });
      }
      return res.status(500).json({ reason: "NAVER_ORDER_CONVERSION_FAILED" });
    }
  },
);

router.post(
  "/naver/order-imports/:id/sync-status",
  requireAuth,
  requirePermission("sales_channels:manage"),
  (req, res) => {
    try {
      const result = synchronizeNaverOrderStatus(req.params.id, { actor: req.admin.id });
      return res.status(result.status === "SYNCHRONIZED" ? 200 : 409).json(result);
    } catch {
      return res.status(500).json({ reason: "NAVER_ORDER_STATUS_SYNC_FAILED" });
    }
  },
);

router.get(
  "/naver/order-conversions/summary",
  requireAuth,
  requirePermission("sales_channels:read"),
  (req, res) => res.json(summarizeNaverOrderConversions()),
);

router.get(
  "/naver/order-conversions",
  requireAuth,
  requirePermission("sales_channels:read"),
  (req, res) => {
    try { return res.json(listNaverOrderConversions(req.query)); }
    catch (error) {
      const status = error instanceof NaverOrderConversionError ? 400 : 500;
      return res.status(status).json({ reason: status === 400 ? error.code : "NAVER_ORDER_CONVERSION_QUERY_FAILED" });
    }
  },
);

router.get(
  "/naver/order-conversions/:id",
  requireAuth,
  requirePermission("sales_channels:read"),
  (req, res) => {
    const conversion = getNaverOrderConversion(req.params.id);
    return conversion ? res.json(conversion) : res.status(404).json({ reason: "NAVER_ORDER_CONVERSION_NOT_FOUND" });
  },
);

router.post(
  "/naver/order-conversions/:id/retry",
  requireAuth,
  requirePermission("sales_channels:manage"),
  (req, res) => {
    const conversion = db.prepare("SELECT * FROM sales_channel_order_conversions WHERE id=? AND channel='naver'").get(req.params.id);
    if (!conversion) return res.status(404).json({ reason: "NAVER_ORDER_CONVERSION_NOT_FOUND" });
    const result = convertNaverOrderImport(conversion.channel_order_import_id, { actor: req.admin.id });
    return res.status(result.status === "CONVERTED" ? 200 : 409).json(result);
  },
);

router.post(
  "/naver/order-conversions/retry",
  requireAuth,
  requirePermission("sales_channels:manage"),
  (req, res) => {
    try { return res.json(retryNaverOrderConversions({ limit: req.body?.limit, actor: req.admin.id })); }
    catch (error) {
      const status = error instanceof NaverOrderConversionError ? 400 : 500;
      return res.status(status).json({ reason: status === 400 ? error.code : "NAVER_ORDER_CONVERSION_RETRY_FAILED" });
    }
  },
);

function setServiceFactoryForTest(factory) {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_ONLY");
  serviceFactory = factory || defaultServiceFactory;
}

module.exports = router;
module.exports.setServiceFactoryForTest = setServiceFactoryForTest;
