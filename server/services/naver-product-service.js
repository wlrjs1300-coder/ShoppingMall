const INTEGER_TEXT = /^[1-9]\d*$/;
const SEARCH_TYPES = Object.freeze({
  sellerManagementCode: ["SELLER_CODE", "sellerManagementCode"],
  originProductNos: ["PRODUCT_NO", "originProductNos"],
  channelProductNos: ["CHANNEL_PRODUCT_NO", "channelProductNos"],
  groupProductNos: ["GROUP_PRODUCT_NO", "groupProductNos"],
});
const KNOWN_PRODUCT_STATUSES = new Set([
  "WAIT", "SALE", "OUTOFSTOCK", "UNADMISSION", "REJECTION",
  "SUSPENSION", "CLOSE", "PROHIBITION", "DELETE",
]);

class NaverProductError extends Error {
  constructor(reason, safeMessage = "네이버 상품 정보를 확인하지 못했습니다.", status = 400) {
    super(safeMessage);
    this.name = "NaverProductError";
    this.reason = reason;
    this.safeMessage = safeMessage;
    this.status = status;
  }
}

function externalId(value, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
    return String(value);
  }
  if (typeof value !== "string" || !INTEGER_TEXT.test(value)) {
    throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
  }
  return value;
}

function safeInteger(value, { nullable = true, positive = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
  }
  return value;
}

function hasUnsupportedOptions(product) {
  const optionInfo = product?.optionInfo ?? product?.originProduct?.optionInfo;
  return optionInfo !== null && optionInfo !== undefined;
}

function normalizeChannelProduct(raw) {
  if (!raw || typeof raw !== "object") throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
  const origin = raw.originProduct && typeof raw.originProduct === "object" ? raw.originProduct : {};
  const sellerCodeInfo = origin.sellerCodeInfo && typeof origin.sellerCodeInfo === "object"
    ? origin.sellerCodeInfo : {};
  const channelProductNo = raw.channelProductNo
    ?? raw.smartstoreChannelProductNo ?? raw.windowChannelProductNo;
  const channelServiceType = raw.channelServiceType
    ?? (raw.smartstoreChannelProductNo !== undefined ? "STOREFARM"
      : raw.windowChannelProductNo !== undefined ? "WINDOW" : null);
  const name = raw.name ?? origin.name;
  const statusType = raw.statusType ?? origin.statusType;
  if (typeof channelServiceType !== "string" || typeof name !== "string" || !name.trim()
    || typeof statusType !== "string" || !statusType.trim()) {
    throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
  }
  return {
    originProductNo: externalId(raw.originProductNo ?? origin.originProductNo, { required: true }),
    groupProductNo: externalId(raw.groupProductNo ?? raw.groupProduct?.groupProductNo),
    channelProductNo: externalId(channelProductNo, { required: true }),
    channelServiceType,
    categoryId: externalId(raw.categoryId ?? origin.leafCategoryId),
    name: name.trim(),
    sellerManagementCode: typeof (raw.sellerManagementCode ?? sellerCodeInfo.sellerManagementCode) === "string"
      ? (raw.sellerManagementCode ?? sellerCodeInfo.sellerManagementCode).trim() || null : null,
    statusType: statusType.trim(),
    displayStatusType: typeof raw.channelProductDisplayStatusType === "string"
      ? raw.channelProductDisplayStatusType : null,
    salePrice: safeInteger(raw.salePrice ?? origin.salePrice),
    discountedPrice: safeInteger(raw.discountedPrice),
    stockQuantity: safeInteger(raw.stockQuantity ?? origin.stockQuantity),
    hasOptions: hasUnsupportedOptions(raw),
  };
}

function normalizeOriginProduct(raw) {
  if (!raw || typeof raw !== "object") throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
  const origin = raw.originProduct && typeof raw.originProduct === "object" ? raw.originProduct : raw;
  if (typeof origin.name !== "string" || !origin.name.trim() || typeof origin.statusType !== "string") {
    throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
  }
  return {
    originProductNo: externalId(raw.originProductNo ?? origin.originProductNo, { required: true }),
    categoryId: externalId(origin.leafCategoryId ?? origin.categoryId),
    name: origin.name.trim(),
    sellerManagementCode: typeof origin.sellerCodeInfo?.sellerManagementCode === "string"
      ? origin.sellerCodeInfo.sellerManagementCode.trim() || null : null,
    statusType: origin.statusType,
    salePrice: safeInteger(origin.salePrice),
    stockQuantity: safeInteger(origin.stockQuantity),
    hasOptions: hasUnsupportedOptions(origin),
  };
}

function normalizeSearchProduct(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.channelProducts)) {
    throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
  }
  return raw.channelProducts.map((channel) => normalizeChannelProduct({
    ...channel,
    originProductNo: channel.originProductNo ?? raw.originProductNo,
    groupProductNo: channel.groupProductNo ?? raw.groupProductNo,
    categoryId: channel.categoryId ?? raw.categoryId,
    name: channel.name ?? raw.name,
  }));
}

function positivePage(value, fallback, maximum = null) {
  const number = value === undefined ? fallback : value;
  if (!Number.isInteger(number) || number < 1 || (maximum && number > maximum)) {
    throw new NaverProductError("PRODUCT_SEARCH_INVALID", "상품 검색 조건이 올바르지 않습니다.");
  }
  return number;
}

function productNos(value) {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.length > 100) throw new NaverProductError("PRODUCT_SEARCH_INVALID");
  return [...new Set(values.map((item) => {
    if (typeof item !== "string" || !INTEGER_TEXT.test(item)) throw new NaverProductError("PRODUCT_SEARCH_INVALID");
    return item;
  }))];
}

function buildSearchBody(criteria = {}) {
  const body = { page: positivePage(criteria.page, 1), size: positivePage(criteria.size, 50, 500) };
  const selected = Object.entries(SEARCH_TYPES).filter(([key]) => criteria[key] !== undefined);
  if (selected.length > 1) throw new NaverProductError("PRODUCT_SEARCH_INVALID");
  if (selected.length === 1) {
    const [key, [type, field]] = selected[0];
    body.searchKeywordType = type;
    if (key === "sellerManagementCode") {
      if (typeof criteria[key] !== "string" || !criteria[key].trim()) throw new NaverProductError("PRODUCT_SEARCH_INVALID");
      body[field] = criteria[key].trim();
    } else body[field] = productNos(criteria[key]);
  }
  return body;
}

function createNaverProductService({ client }) {
  if (!client || typeof client.request !== "function") throw new TypeError("NAVER_CLIENT_REQUIRED");
  return {
    async searchProducts(criteria) {
      const body = buildSearchBody(criteria);
      const result = await client.request("/v1/products/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), retryOnAuth: true,
      });
      if (!result.data || !Array.isArray(result.data.contents)) throw new NaverProductError("NAVER_PRODUCT_RESPONSE_INVALID");
      return {
        items: result.data.contents.flatMap(normalizeSearchProduct),
        page: body.page, size: body.size,
        first: result.data.first === true, last: result.data.last === true,
      };
    },
    async getOriginProduct(originProductNo) {
      const id = externalId(originProductNo, { required: true });
      const result = await client.request(`/v2/products/origin-products/${id}`, { method: "GET" });
      return normalizeOriginProduct(result.data);
    },
    async getChannelProduct(channelProductNo) {
      const id = externalId(channelProductNo, { required: true });
      const result = await client.request(`/v2/products/channel-products/${id}`, { method: "GET" });
      return normalizeChannelProduct(result.data);
    },
  };
}

function validateInternalProductForNaverMapping(product) {
  if (!product) return "INTERNAL_PRODUCT_NOT_FOUND";
  if (product.purchase_type !== "direct") return "INTERNAL_PRODUCT_NOT_DIRECT";
  if (product.status !== "active") return "INTERNAL_PRODUCT_INACTIVE";
  if (!Number.isSafeInteger(product.price) || product.price <= 0) return "INTERNAL_PRODUCT_PRICE_INVALID";
  return null;
}

function validateExternalProductForNaverMapping(product) {
  if (!product?.originProductNo || !product.channelProductNo || !product.name) return "NAVER_PRODUCT_RESPONSE_INVALID";
  if (product.channelServiceType !== "STOREFARM") return "NAVER_CHANNEL_UNSUPPORTED";
  if (!KNOWN_PRODUCT_STATUSES.has(product.statusType)) return "NAVER_PRODUCT_STATUS_UNSUPPORTED";
  if (["DELETE", "PROHIBITION"].includes(product.statusType)) return "NAVER_PRODUCT_STATUS_UNSUPPORTED";
  if (product.hasOptions) return "NAVER_PRODUCT_OPTION_UNSUPPORTED";
  return null;
}

function createSellerManagementCode(internalProductId) {
  const normalized = String(internalProductId).normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "").toUpperCase();
  return `SM-${normalized}`;
}

module.exports = {
  NaverProductError, buildSearchBody, createNaverProductService, createSellerManagementCode,
  externalId, hasUnsupportedOptions, normalizeChannelProduct, normalizeOriginProduct,
  normalizeSearchProduct, validateExternalProductForNaverMapping,
  validateInternalProductForNaverMapping,
};
