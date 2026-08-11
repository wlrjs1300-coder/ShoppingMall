const express = require("express");
const db = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const {
  NaverShipmentDispatchError,
  createNaverShipmentDispatchService,
} = require("../services/naver-shipment-dispatch-service");

const router = express.Router();
const defaultFactory = () => createNaverShipmentDispatchService({ db });
let serviceFactory = defaultFactory;

function safeError(res, error) {
  const known = error instanceof NaverShipmentDispatchError;
  return res.status(known ? error.status : 500).json({
    error: "Naver shipment request could not be completed.",
    reason: known ? error.reason : "NAVER_SHIPMENT_PROVIDER_UNCERTAIN",
  });
}

router.get(
  "/naver/shipments/:orderId",
  requireAuth,
  requirePermission("sales_channels:read"),
  (req, res) => {
    try {
      const result = serviceFactory().get(req.params.orderId);
      return result ? res.json(result) : res.status(404).json({ reason: "NAVER_SHIPMENT_ORDER_NOT_FOUND" });
    } catch (error) { return safeError(res, error); }
  },
);

router.post(
  "/naver/shipments/:orderId/dispatch",
  requireAuth,
  requirePermission("sales_channels:manage"),
  async (req, res) => {
    const body = req.body || {};
    if (Object.keys(body).some((field) => !["carrierCode", "trackingNumber"].includes(field))) {
      return res.status(400).json({ reason: "NAVER_SHIPMENT_REQUEST_INVALID" });
    }
    try {
      const result = await serviceFactory().dispatch({
        orderId: req.params.orderId,
        carrierCode: body.carrierCode,
        trackingNumber: body.trackingNumber,
        actor: req.admin.id,
        signal: req.signal,
      });
      return res.status(result.status === "SUCCEEDED" ? 200 : 409).json(result);
    } catch (error) { return safeError(res, error); }
  },
);

router.post(
  "/naver/shipments/:orderId/reconcile",
  requireAuth,
  requirePermission("sales_channels:manage"),
  async (req, res) => {
    if (Object.keys(req.body || {}).length) return res.status(400).json({ reason: "NAVER_SHIPMENT_REQUEST_INVALID" });
    try {
      const result = await serviceFactory().reconcile({
        orderId: req.params.orderId, actor: req.admin.id, signal: req.signal,
      });
      return res.status(result.status === "RECONCILE_REQUIRED" ? 409 : 200).json(result);
    } catch (error) { return safeError(res, error); }
  },
);

function setServiceFactoryForTest(factory) {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_ONLY");
  serviceFactory = factory || defaultFactory;
}

module.exports = router;
module.exports.setServiceFactoryForTest = setServiceFactoryForTest;
