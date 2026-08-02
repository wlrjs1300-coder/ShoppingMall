process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "naver-product-mapping-test-secret-at-least-32-bytes";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const db = require("../db");
const app = require("../index");
const route = require("../routes/naver-product-mappings");
const {
  NaverProductError,
  buildSearchBody,
  createNaverProductService,
  hasUnsupportedOptions,
  normalizeChannelProduct,
  validateExternalProductForNaverMapping,
  validateInternalProductForNaverMapping,
} = require("../services/naver-product-service");

function token(role = "super_admin") {
  return jwt.sign({ sub: `naver-map-${role}`, role }, process.env.JWT_SECRET, { algorithm: "HS256" });
}

function auth(role) {
  return { Authorization: `Bearer ${token(role)}` };
}

function external(overrides = {}) {
  return {
    originProductNo: "900000000000000001",
    groupProductNo: null,
    channelProductNo: "800000000000000001",
    channelServiceType: "STOREFARM",
    categoryId: "50000001",
    name: "Fixture product",
    sellerManagementCode: "SM-INJEOLMI",
    statusType: "SALE",
    displayStatusType: "ON",
    salePrice: 10000,
    discountedPrice: null,
    stockQuantity: 10,
    hasOptions: false,
    ...overrides,
  };
}

function stubService(product = external()) {
  return {
    getChannelProduct: async () => product,
    searchProducts: async () => ({ items: [product], page: 1, size: 50, first: true, last: true }),
  };
}

function insertMapping({
  id, internalProductId, channelProductNo, originProductNo = "900000000000000001",
  sellerManagementCode = null, mappingStatus = "ACTIVE", createdAt = new Date().toISOString(),
}) {
  db.prepare(`INSERT INTO sales_channel_product_mappings (
    id, channel, internal_product_id, external_origin_product_no, external_channel_product_no,
    seller_management_code, channel_service_type, external_product_name, external_status,
    mapping_status, created_at, updated_at
  ) VALUES (?, 'naver', ?, ?, ?, ?, 'STOREFARM', 'fixture', 'SALE', ?, ?, ?)`).run(
    id, internalProductId, originProductNo, channelProductNo, sellerManagementCode,
    mappingStatus, createdAt, createdAt,
  );
}

function removeMappings() {
  db.prepare("DELETE FROM sales_channel_product_mappings").run();
  db.prepare("DELETE FROM activity_logs WHERE action LIKE 'naver_product_mapping_%'").run();
  route.setServiceFactoryForTest(null);
}

test.afterEach(removeMappings);

test("migration creates constrained mapping storage without seeded mappings", () => {
  const columns = db.prepare("PRAGMA table_info(sales_channel_product_mappings)").all().map((row) => row.name);
  for (const name of [
    "internal_product_id", "external_origin_product_no", "external_channel_product_no",
    "mapping_status", "inventory_sync_enabled", "price_sync_enabled", "safety_stock",
  ]) assert.ok(columns.includes(name));
  const foreignKey = db.prepare("PRAGMA foreign_key_list(sales_channel_product_mappings)").all()
    .find((row) => row.from === "internal_product_id");
  assert.equal(foreignKey.table, "products");
  assert.equal(foreignKey.on_delete, "RESTRICT");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_product_mappings").get().count, 0);
  const now = new Date().toISOString();
  const insert = (id, internalId, channelNo, safety = 0) => db.prepare(`INSERT INTO sales_channel_product_mappings
    (id, internal_product_id, external_origin_product_no, external_channel_product_no,
     channel_service_type, external_product_name, external_status, safety_stock, created_at, updated_at)
    VALUES (?, ?, '11', ?, 'STOREFARM', 'fixture', 'SALE', ?, ?, ?)`)
    .run(id, internalId, channelNo, safety, now, now);
  insert("map-one", "injeolmi", "21");
  const defaults = db.prepare("SELECT inventory_sync_enabled, price_sync_enabled FROM sales_channel_product_mappings WHERE id='map-one'").get();
  assert.equal(defaults.inventory_sync_enabled, 0);
  assert.equal(defaults.price_sync_enabled, 0);
  assert.throws(() => insert("map-two", "injeolmi", "22"), /UNIQUE/);
  assert.throws(() => insert("map-three", "black-sesame-injeolmi", "21"), /UNIQUE/);
  assert.throws(() => insert("map-four", "black-sesame-injeolmi", "24", -1), /CHECK/);
});

test("search wrapper sends only the selected official search fields and keeps pagination contract", async () => {
  let captured;
  const service = createNaverProductService({
    client: { request: async (path, options) => {
      captured = { path, options, body: JSON.parse(options.body) };
      return { data: { contents: [], first: true, last: true } };
    } },
  });
  await service.searchProducts({ sellerManagementCode: " code-1 ", page: 1, size: 500 });
  assert.equal(captured.path, "/v1/products/search");
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(captured.body, {
    searchKeywordType: "SELLER_CODE", sellerManagementCode: "code-1", page: 1, size: 500,
  });
  assert.equal("originProductNos" in captured.body, false);
  assert.deepEqual(buildSearchBody({ originProductNos: ["900000000000000001", "900000000000000001"] }), {
    searchKeywordType: "PRODUCT_NO", originProductNos: ["900000000000000001"], page: 1, size: 50,
  });
  assert.deepEqual(buildSearchBody({ channelProductNos: "800000000000000001" }).channelProductNos, ["800000000000000001"]);
  for (const criteria of [{ page: 0 }, { size: 501 }, { sellerManagementCode: " " }, { originProductNos: [] }]) {
    assert.throws(() => buildSearchBody(criteria), NaverProductError);
  }
});

test("detail wrappers use fixed encoded numeric paths and normalize safe fields only", async () => {
  const calls = [];
  const raw = {
    originProductNo: "900000000000000001",
    smartstoreChannelProductNo: "800000000000000001",
    originProduct: {
      name: "Fixture product", statusType: "SALE", leafCategoryId: "50000001",
      salePrice: 10000, stockQuantity: 2, sellerCodeInfo: { sellerManagementCode: " CODE " },
    },
  };
  const service = createNaverProductService({
    client: { request: async (path) => { calls.push(path); return { data: raw }; } },
  });
  const channel = await service.getChannelProduct("800000000000000001");
  assert.equal(calls[0], "/v2/products/channel-products/800000000000000001");
  assert.equal(channel.channelProductNo, "800000000000000001");
  assert.equal(channel.originProductNo, "900000000000000001");
  assert.equal(channel.sellerManagementCode, "CODE");
  assert.equal(channel.hasOptions, false);
  assert.equal("originProduct" in channel, false);
  await service.getOriginProduct("900000000000000001");
  assert.equal(calls[1], "/v2/products/origin-products/900000000000000001");
});

test("unsafe identifiers, malformed price and stock, and incomplete responses are rejected", () => {
  assert.throws(() => normalizeChannelProduct({
    originProductNo: Number.MAX_SAFE_INTEGER + 1, channelProductNo: "2",
    channelServiceType: "STOREFARM", name: "x", statusType: "SALE",
  }), /네이버 상품/);
  for (const field of ["salePrice", "stockQuantity"]) {
    assert.throws(() => normalizeChannelProduct({
      originProductNo: "1", channelProductNo: "2", channelServiceType: "STOREFARM",
      name: "x", statusType: "SALE", [field]: 1.2,
    }), NaverProductError);
  }
  assert.throws(() => normalizeChannelProduct({}), NaverProductError);
});

test("option detection is conservative and eligibility reasons are stable", () => {
  assert.equal(hasUnsupportedOptions({}), false);
  for (const optionInfo of [{}, { useStockManagement: false }, { optionCombinations: [] }, { customOptions: [] }]) {
    assert.equal(hasUnsupportedOptions({ optionInfo }), true);
  }
  assert.equal(validateInternalProductForNaverMapping(null), "INTERNAL_PRODUCT_NOT_FOUND");
  assert.equal(validateInternalProductForNaverMapping({ purchase_type: "consultation" }), "INTERNAL_PRODUCT_NOT_DIRECT");
  assert.equal(validateInternalProductForNaverMapping({ purchase_type: "direct", status: "inactive", price: 1 }), "INTERNAL_PRODUCT_INACTIVE");
  assert.equal(validateInternalProductForNaverMapping({ purchase_type: "direct", status: "active", price: null }), "INTERNAL_PRODUCT_PRICE_INVALID");
  assert.equal(validateInternalProductForNaverMapping({ purchase_type: "direct", status: "active", price: 1 }), null);
  assert.equal(validateExternalProductForNaverMapping(external()), null);
  assert.equal(validateExternalProductForNaverMapping(external({ channelServiceType: "WINDOW" })), "NAVER_CHANNEL_UNSUPPORTED");
  for (const statusType of ["DELETE", "PROHIBITION"]) {
    assert.equal(validateExternalProductForNaverMapping(external({ statusType })), "NAVER_PRODUCT_STATUS_UNSUPPORTED");
  }
  for (const statusType of ["OUTOFSTOCK", "SUSPENSION"]) {
    assert.equal(validateExternalProductForNaverMapping(external({ statusType })), null);
  }
  assert.equal(validateExternalProductForNaverMapping(external({ hasOptions: true })), "NAVER_PRODUCT_OPTION_UNSUPPORTED");
});

test("read APIs enforce authentication and least-privilege read access", async () => {
  await request(app).get("/api/sales-channels/naver/product-mappings").expect(401);
  await request(app).get("/api/sales-channels/naver/product-mappings").set(auth("viewer")).expect(200);
  route.setServiceFactoryForTest(() => stubService());
  await request(app).post("/api/sales-channels/naver/products/search").set(auth("operations")).send({}).expect(200);
  await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth("viewer")).send({ internalProductId: "injeolmi", channelProductNo: "800000000000000001" }).expect(403);
});

test("seller management code filtering precedes total calculation and pagination", async () => {
  insertMapping({
    id: "filter-matched", internalProductId: "injeolmi", channelProductNo: "101",
    sellerManagementCode: "SM-INJEOLMI", createdAt: "2026-01-01T00:00:00.000Z",
  });
  insertMapping({
    id: "filter-missing", internalProductId: "mugwort-injeolmi", channelProductNo: "102",
    createdAt: "2026-01-03T00:00:00.000Z",
  });
  insertMapping({
    id: "filter-mismatch-one", internalProductId: "castella-injeolmi", channelProductNo: "103",
    sellerManagementCode: "OTHER-ONE", createdAt: "2026-01-04T00:00:00.000Z",
  });
  insertMapping({
    id: "filter-mismatch-two", internalProductId: "black-sesame-injeolmi", channelProductNo: "104",
    sellerManagementCode: "OTHER-TWO", createdAt: "2026-01-02T00:00:00.000Z",
  });

  const matched = await request(app).get(
    "/api/sales-channels/naver/product-mappings?sellerManagementCodeStatus=MATCHED&page=1&size=1",
  ).set(auth("viewer")).expect(200);
  assert.equal(matched.body.total, 1);
  assert.equal(matched.body.items[0].id, "filter-matched");
  assert.equal(matched.body.last, true);

  const missing = await request(app).get(
    "/api/sales-channels/naver/product-mappings?sellerManagementCodeStatus=MISSING",
  ).set(auth("viewer")).expect(200);
  assert.equal(missing.body.total, 1);
  assert.equal(missing.body.items[0].id, "filter-missing");

  const mismatchPage = await request(app).get(
    "/api/sales-channels/naver/product-mappings?sellerManagementCodeStatus=MISMATCH&page=2&size=1",
  ).set(auth("viewer")).expect(200);
  assert.equal(mismatchPage.body.total, 2);
  assert.equal(mismatchPage.body.items.length, 1);
  assert.equal(mismatchPage.body.last, true);
  await request(app).get(
    "/api/sales-channels/naver/product-mappings?sellerManagementCodeStatus=UNVERIFIED",
  ).set(auth("viewer")).expect(400);
});

test("mapping create is atomic, idempotent, conflict-safe and returns no raw provider data", async () => {
  route.setServiceFactoryForTest(() => stubService());
  const body = { internalProductId: "injeolmi", channelProductNo: "800000000000000001" };
  const created = await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send(body).expect(201);
  assert.equal(created.body.mappingStatus, "ACTIVE");
  assert.equal(created.body.inventorySyncEnabled, false);
  assert.equal(JSON.stringify(created.body).includes("access_token"), false);
  const repeated = await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send(body).expect(200);
  assert.equal(repeated.body.id, created.body.id);
  route.setServiceFactoryForTest(() => stubService(external({ channelProductNo: "800000000000000002" })));
  await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send({ ...body, channelProductNo: "800000000000000002" }).expect(409);
  assert.ok(db.prepare("SELECT id FROM activity_logs WHERE action='naver_product_mapping_created'").get());
});

test("idempotent and preflight-conflict requests never call the external service", async () => {
  insertMapping({
    id: "existing-idempotent", internalProductId: "injeolmi",
    channelProductNo: "800000000000000001", sellerManagementCode: "SM-INJEOLMI",
  });
  let calls = 0;
  route.setServiceFactoryForTest(() => ({
    getChannelProduct: async () => { calls += 1; throw new Error("external outage"); },
  }));
  await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send({
      internalProductId: "injeolmi", channelProductNo: "800000000000000001",
    }).expect(200);
  await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send({
      internalProductId: "injeolmi", channelProductNo: "800000000000000002",
    }).expect(409);
  assert.equal(calls, 0);
});

test("transaction recheck returns a concurrent identical mapping and rejects another combination", async () => {
  let mode = "same";
  route.setServiceFactoryForTest(() => ({
    getChannelProduct: async (channelProductNo) => {
      if (mode === "same") {
        insertMapping({
          id: "concurrent-same", internalProductId: "injeolmi",
          channelProductNo, sellerManagementCode: "SM-INJEOLMI",
        });
      } else {
        insertMapping({
          id: "concurrent-conflict", internalProductId: "injeolmi",
          channelProductNo: "800000000000000099", sellerManagementCode: "SM-INJEOLMI",
        });
      }
      return external({ channelProductNo });
    },
  }));
  const same = await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send({
      internalProductId: "injeolmi", channelProductNo: "800000000000000001",
    }).expect(200);
  assert.equal(same.body.id, "concurrent-same");

  removeMappings();
  mode = "conflict";
  route.setServiceFactoryForTest(() => ({
    getChannelProduct: async (channelProductNo) => {
      insertMapping({
        id: "concurrent-conflict", internalProductId: "injeolmi",
        channelProductNo: "800000000000000099", sellerManagementCode: "SM-INJEOLMI",
      });
      return external({ channelProductNo });
    },
  }));
  await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send({
      internalProductId: "injeolmi", channelProductNo: "800000000000000002",
    }).expect(409);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_product_mappings").get().count, 1);
});

test("audit failure rolls back mapping creation", async () => {
  route.setServiceFactoryForTest(() => stubService());
  db.exec(`CREATE TEMP TRIGGER fail_naver_mapping_audit BEFORE INSERT ON activity_logs
    WHEN NEW.action='naver_product_mapping_created'
    BEGIN SELECT RAISE(FAIL, 'forced secret provider error'); END`);
  try {
    const response = await request(app).post("/api/sales-channels/naver/product-mappings")
      .set(auth()).send({ internalProductId: "injeolmi", channelProductNo: "800000000000000001" }).expect(500);
    assert.equal(JSON.stringify(response.body).includes("forced secret"), false);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_product_mappings").get().count, 0);
  } finally {
    db.exec("DROP TRIGGER fail_naver_mapping_audit");
  }
});

test("mapping can be listed, disabled, re-enabled, safety-stock changed and physically cannot be deleted", async () => {
  route.setServiceFactoryForTest(() => stubService());
  const created = await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send({ internalProductId: "injeolmi", channelProductNo: "800000000000000001" }).expect(201);
  await request(app).patch(`/api/sales-channels/naver/product-mappings/${created.body.id}`)
    .set(auth()).send({ enabled: false, safetyStock: 3 }).expect(200)
    .expect((response) => {
      assert.equal(response.body.mappingStatus, "DISABLED");
      assert.equal(response.body.safetyStock, 3);
    });
  await request(app).patch(`/api/sales-channels/naver/product-mappings/${created.body.id}`)
    .set(auth()).send({ mappingStatus: "ACTIVE" }).expect(200);
  await request(app).get("/api/sales-channels/naver/product-mappings?mappingStatus=ACTIVE&page=1&size=1")
    .set(auth("viewer")).expect(200).expect((response) => assert.equal(response.body.items.length, 1));
  await request(app).get(`/api/sales-channels/naver/product-mappings/${created.body.id}`).set(auth("viewer")).expect(200);
  await request(app).get("/api/sales-channels/naver/product-mappings/missing").set(auth("viewer")).expect(404);
  await request(app).delete(`/api/sales-channels/naver/product-mappings/${created.body.id}`).set(auth()).expect(404);
  await request(app).patch(`/api/sales-channels/naver/product-mappings/${created.body.id}`)
    .set(auth()).send({ externalChannelProductNo: "99" }).expect(400);
});

test("verification updates successful, missing and option-unsupported states without deleting history", async () => {
  route.setServiceFactoryForTest(() => stubService());
  const created = await request(app).post("/api/sales-channels/naver/product-mappings")
    .set(auth()).send({ internalProductId: "injeolmi", channelProductNo: "800000000000000001" }).expect(201);
  await request(app).post(`/api/sales-channels/naver/product-mappings/${created.body.id}/verify`)
    .set(auth()).expect(200).expect((response) => assert.equal(response.body.mappingStatus, "ACTIVE"));
  route.setServiceFactoryForTest(() => stubService(external({ hasOptions: true })));
  await request(app).post(`/api/sales-channels/naver/product-mappings/${created.body.id}/verify`)
    .set(auth()).expect(200).expect((response) => assert.equal(response.body.mappingStatus, "UNSUPPORTED_OPTION"));
  route.setServiceFactoryForTest(() => ({
    getChannelProduct: async () => { const error = new Error("provider raw secret"); error.status = 404; throw error; },
  }));
  const missing = await request(app).post(`/api/sales-channels/naver/product-mappings/${created.body.id}/verify`)
    .set(auth()).expect(200);
  assert.equal(missing.body.mappingStatus, "EXTERNAL_NOT_FOUND");
  assert.equal(JSON.stringify(missing.body).includes("provider raw"), false);
  assert.ok(db.prepare("SELECT id FROM sales_channel_product_mappings WHERE id=?").get(created.body.id));
});

test("verification preserves concurrent DISABLED state and records external problems", async () => {
  insertMapping({
    id: "verify-disabled", internalProductId: "injeolmi",
    channelProductNo: "800000000000000001", sellerManagementCode: "SM-INJEOLMI",
  });
  route.setServiceFactoryForTest(() => ({
    getChannelProduct: async () => {
      db.prepare("UPDATE sales_channel_product_mappings SET mapping_status='DISABLED' WHERE id='verify-disabled'").run();
      return external({ hasOptions: true });
    },
  }));
  const response = await request(app).post(
    "/api/sales-channels/naver/product-mappings/verify-disabled/verify",
  ).set(auth()).expect(200);
  assert.equal(response.body.mappingStatus, "DISABLED");
  assert.equal(response.body.lastErrorCode, "NAVER_PRODUCT_OPTION_UNSUPPORTED");
});

test("verification rolls back when mapping identifiers change during the external call", async () => {
  insertMapping({
    id: "verify-conflict", internalProductId: "injeolmi",
    channelProductNo: "800000000000000001", sellerManagementCode: "SM-INJEOLMI",
  });
  const auditBefore = db.prepare(
    "SELECT COUNT(*) count FROM activity_logs WHERE action='naver_product_mapping_verified'",
  ).get().count;
  route.setServiceFactoryForTest(() => ({
    getChannelProduct: async () => {
      db.prepare(`UPDATE sales_channel_product_mappings
        SET external_origin_product_no='900000000000000099' WHERE id='verify-conflict'`).run();
      return external();
    },
  }));
  const response = await request(app).post(
    "/api/sales-channels/naver/product-mappings/verify-conflict/verify",
  ).set(auth()).expect(409);
  assert.equal(response.body.reason, "PRODUCT_MAPPING_CONFLICT");
  const row = db.prepare("SELECT * FROM sales_channel_product_mappings WHERE id='verify-conflict'").get();
  assert.equal(row.mapping_status, "ACTIVE");
  assert.equal(row.last_verified_at, null);
  assert.equal(row.last_error_code, null);
  const auditAfter = db.prepare(
    "SELECT COUNT(*) count FROM activity_logs WHERE action='naver_product_mapping_verified'",
  ).get().count;
  assert.equal(auditAfter, auditBefore);
});
