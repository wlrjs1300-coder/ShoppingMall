const express = require("express");
const { requireAuth, requirePermission, audit } = require("../middleware/auth");
const { createNaverCommerceClient } = require("../services/naver-commerce-client");

const router = express.Router();
const defaultClient = createNaverCommerceClient();
const defaultClientFactory = () => defaultClient;
let clientFactory = defaultClientFactory;

router.get("/naver/connection", requireAuth, requirePermission("sales_channels:read"), async (req, res) => {
  const result = await clientFactory().getConnectionStatus();
  audit(
    result.connected ? "naver_connection_check_succeeded" : "naver_connection_check_failed",
    req.admin.id,
    result.connected ? "Naver Commerce connection check succeeded" : `Naver Commerce connection check failed: ${result.errorCode || "NOT_CONNECTED"}`,
    "naver",
    null,
    result.connected ? "connected" : "not_connected",
  );
  res.setHeader("Cache-Control", "no-store");
  return res.json(result);
});

function setClientFactoryForTest(factory) {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_ONLY");
  clientFactory = factory || defaultClientFactory;
}

module.exports = router;
module.exports.setClientFactoryForTest = setClientFactoryForTest;
module.exports.getDefaultClientForTest = () => {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_ONLY");
  return defaultClient;
};
