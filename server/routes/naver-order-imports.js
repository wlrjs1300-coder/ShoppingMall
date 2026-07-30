const express = require("express");
const db = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { createNaverOrderSyncService } = require("../services/naver-order-sync-service");
const { NaverOrderSyncError } = require("../services/naver-order-sync-repository");

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

function setServiceFactoryForTest(factory) {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_ONLY");
  serviceFactory = factory || defaultServiceFactory;
}

module.exports = router;
module.exports.setServiceFactoryForTest = setServiceFactoryForTest;
