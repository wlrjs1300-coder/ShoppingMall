const { getDefaultNaverCommerceClient } = require("./naver-commerce-client");
const {
  NaverOrderImportError,
  dateTime,
  externalId,
  normalizeChangeFeedItem,
  normalizeDetailedProductOrder,
} = require("./naver-order-import-service");

function limitCount(value) {
  const count = value === undefined ? 300 : value;
  if (!Number.isInteger(count) || count < 1 || count > 300) {
    throw new NaverOrderImportError("NAVER_ORDER_REQUEST_INVALID");
  }
  return count;
}

function moreSequence(value) {
  if (value === null || value === undefined || value === "") return null;
  if ((typeof value !== "string" && typeof value !== "number")
    || !/^\d+$/.test(String(value))) {
    throw new NaverOrderImportError("NAVER_ORDER_REQUEST_INVALID");
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new NaverOrderImportError("NAVER_ORDER_REQUEST_INVALID");
  }
  return String(value);
}

function productOrderIds(values) {
  if (!Array.isArray(values) || !values.length) {
    throw new NaverOrderImportError("NAVER_ORDER_REQUEST_INVALID");
  }
  const ids = [...new Set(values.map((value) => externalId(value, { required: true })))];
  if (ids.length > 300) throw new NaverOrderImportError("NAVER_ORDER_REQUEST_INVALID");
  return ids;
}

function createNaverOrderService({ client = getDefaultNaverCommerceClient() } = {}) {
  if (!client || typeof client.request !== "function") throw new TypeError("NAVER_CLIENT_REQUIRED");
  return {
    async getLastChangedProductOrders({
      lastChangedFrom, lastChangedTo, moreSequence: sequence, limitCount: requestedLimit, signal,
    } = {}) {
      const from = dateTime(lastChangedFrom, { required: true });
      const to = dateTime(lastChangedTo);
      if (to && Date.parse(to) < Date.parse(from)) {
        throw new NaverOrderImportError("NAVER_ORDER_REQUEST_INVALID");
      }
      const query = new URLSearchParams({
        lastChangedFrom: from,
        limitCount: String(limitCount(requestedLimit)),
      });
      if (to) query.set("lastChangedTo", to);
      const normalizedSequence = moreSequence(sequence);
      if (normalizedSequence) query.set("moreSequence", normalizedSequence);
      const result = await client.request(
        `/v1/pay-order/seller/product-orders/last-changed-statuses?${query}`,
        { method: "GET", signal },
      );
      if (!result.data || !Array.isArray(result.data.data)) {
        throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
      }
      const more = result.data.more;
      return {
        items: result.data.data.map(normalizeChangeFeedItem),
        more: more ? {
          moreFrom: dateTime(more.moreFrom, { required: true }),
          moreSequence: moreSequence(more.moreSequence),
        } : null,
        traceId: result.traceId || null,
        retryAfterMs: result.retryAfterMs ?? null,
      };
    },

    async getProductOrders(values, { quantityClaimCompatibility = true, signal } = {}) {
      if (quantityClaimCompatibility !== true) {
        throw new NaverOrderImportError("NAVER_ORDER_REQUEST_INVALID");
      }
      const ids = productOrderIds(values);
      const result = await client.request("/v1/pay-order/seller/product-orders/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productOrderIds: ids, quantityClaimCompatibility: true }),
        retryOnAuth: true,
        signal,
      });
      if (!result.data || !Array.isArray(result.data.data)) {
        throw new NaverOrderImportError("NAVER_ORDER_RESPONSE_INVALID");
      }
      return {
        items: result.data.data.map((item) => normalizeDetailedProductOrder(item)),
        traceId: result.traceId || null,
        retryAfterMs: result.retryAfterMs ?? null,
      };
    },
  };
}

module.exports = {
  createNaverOrderService,
  limitCount,
  moreSequence,
  productOrderIds,
};
