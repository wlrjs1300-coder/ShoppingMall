process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "naver-order-read-test-secret-at-least-32-bytes";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");
const {
  PiiCryptoError, canonicalize, decryptPii, encryptPii, maskName, maskPhone,
} = require("../lib/pii-crypto");
const {
  NaverOrderImportError,
  canonicalHash,
  createNaverOrderImportRepository,
  normalizeChangeFeedItem,
  normalizeDetailedProductOrder,
  resolveProductMapping,
} = require("../services/naver-order-import-service");
const {
  createNaverOrderService, productOrderIds,
} = require("../services/naver-order-service");

const PII_KEY = Buffer.alloc(32, 7).toString("base64");

function feed(overrides = {}) {
  return {
    orderId: "202607290000000001",
    productOrderId: "202607290000000101",
    lastChangedType: "PAYED",
    lastChangedDate: "2026-07-29T10:00:00+09:00",
    paymentDate: "2026-07-29T09:59:00+09:00",
    productOrderStatus: "PAYED",
    claimType: null,
    claimStatus: null,
    receiverAddressChanged: false,
    ...overrides,
  };
}

function detail(overrides = {}) {
  const value = {
    order: {
      orderId: "202607290000000001",
      orderDate: "2026-07-29T09:58:00+09:00",
      paymentDate: "2026-07-29T09:59:00+09:00",
      paymentMeans: "신용카드",
      totalPaymentAmount: 12000,
      ordererName: "테스트주문자",
      ordererTel: "01011112222",
    },
    productOrder: {
      productOrderId: "202607290000000101",
      productId: "800000000000000001",
      originalProductId: "900000000000000001",
      groupProductId: "700000000000000001",
      packageNumber: "600000000000000001",
      itemNo: "fixture-item",
      optionManageCode: "fixture-option-code",
      sellerProductCode: "SM-INJEOLMI",
      productName: "Fixture rice cake",
      productOption: "",
      initialQuantity: 2,
      remainQuantity: 2,
      unitPrice: 6000,
      initialPaymentAmount: 12000,
      remainPaymentAmount: 12000,
      productOrderStatus: "PAYED",
      shippingMemo: "Fixture memo only",
      shippingAddress: {
        name: "테스트수령인",
        tel1: "01033334444",
        zipCode: "12345",
        baseAddress: "테스트시 테스트구",
        detailedAddress: "테스트로 1",
        entryMethod: "LOBBY_PW",
        entryMethodContent: "fixture-entry",
        longitude: "127.0",
        latitude: "37.0",
      },
      individualCustomUniqueCode: "never-store-this",
      takingAddress: { baseAddress: "never-store-seller-address" },
    },
  };
  return {
    ...value,
    ...overrides,
    order: { ...value.order, ...(overrides.order || {}) },
    productOrder: { ...value.productOrder, ...(overrides.productOrder || {}) },
  };
}

function normalized(overrides = {}) {
  const change = normalizeChangeFeedItem(feed(overrides.feed));
  return normalizeDetailedProductOrder(detail(overrides.detail), change);
}

function repository() {
  return createNaverOrderImportRepository({
    db, piiKey: PII_KEY, piiKeyVersion: "fixture-v1",
  });
}

function cleanup() {
  db.prepare("DELETE FROM sales_channel_order_import_items").run();
  db.prepare("DELETE FROM sales_channel_order_imports").run();
  db.prepare("DELETE FROM activity_logs WHERE action='naver_order_import_upserted'").run();
  db.prepare("DELETE FROM sales_channel_product_mappings WHERE id LIKE 'n3-%'").run();
}

test.afterEach(cleanup);

test("migration 13 creates empty constrained header and item staging tables", () => {
  assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 16);
  for (const table of ["sales_channel_order_imports", "sales_channel_order_import_items"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
  }
  const itemColumns = db.prepare("PRAGMA table_info(sales_channel_order_import_items)").all();
  for (const column of [
    "external_product_order_id", "external_channel_product_no", "external_claim_id",
    "external_group_product_id", "external_package_number", "external_item_no",
    "external_option_manage_code",
  ]) {
    assert.equal(itemColumns.find((entry) => entry.name === column).type, "TEXT");
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(sales_channel_order_import_items)").all();
  assert.ok(foreignKeys.some((key) => key.table === "sales_channel_order_imports"
    && key.from === "channel_order_import_id" && key.on_delete === "CASCADE"));
  assert.ok(foreignKeys.some((key) => key.table === "sales_channel_product_mappings"
    && key.from === "product_mapping_id" && key.on_delete === "SET NULL"));
  assert.ok(foreignKeys.some((key) => key.table === "products"
    && key.from === "internal_product_id" && key.on_delete === "SET NULL"));
  const headerIndexes = db.prepare("PRAGMA index_list(sales_channel_order_imports)").all();
  const itemIndexes = db.prepare("PRAGMA index_list(sales_channel_order_import_items)").all();
  assert.ok(headerIndexes.some((index) => index.unique));
  assert.ok(itemIndexes.some((index) => index.unique));
  const namedIndexes = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'`).all().map((row) => row.name);
  assert.equal(new Set(namedIndexes).size, namedIndexes.length);
});

test("migration constraints reject duplicate IDs, negative values and partial encryption tuples", () => {
  const now = new Date().toISOString();
  const insertHeader = (id, externalId, extra = {}) => db.prepare(`INSERT INTO sales_channel_order_imports
    (id, channel, external_order_id, import_status, order_amount, order_pii_ciphertext,
     order_pii_iv, order_pii_auth_tag, order_pii_key_version, created_at, updated_at)
    VALUES (?, 'naver', ?, 'IMPORTED', ?, ?, ?, ?, ?, ?, ?)`).run(
    id, externalId, extra.amount ?? 0, extra.ciphertext ?? null, extra.iv ?? null,
    extra.authTag ?? null, extra.keyVersion ?? null, now, now,
  );
  insertHeader("n3-header-one", "1");
  assert.throws(() => insertHeader("n3-header-two", "1"), /UNIQUE/);
  assert.throws(() => insertHeader("n3-negative", "2", { amount: -1 }), /CHECK/);
  assert.throws(() => insertHeader("n3-partial", "3", { ciphertext: "x" }), /CHECK/);
  const insertItem = (id, productOrderId, extra = {}) => db.prepare(`
    INSERT INTO sales_channel_order_import_items
      (id, channel, channel_order_import_id, external_product_order_id, initial_quantity,
       item_pii_ciphertext, item_pii_iv, item_pii_auth_tag, item_pii_key_version,
       mapping_status, created_at, updated_at)
    VALUES (?, 'naver', 'n3-header-one', ?, ?, ?, ?, ?, ?, 'UNMAPPED', ?, ?)
  `).run(
    id, productOrderId, extra.quantity ?? 0, extra.ciphertext ?? null, extra.iv ?? null,
    extra.authTag ?? null, extra.keyVersion ?? null, now, now,
  );
  insertItem("n3-item-one", "11");
  assert.throws(() => insertItem("n3-item-two", "11"), /UNIQUE/);
  assert.throws(() => insertItem("n3-item-negative", "12", { quantity: -1 }), /CHECK/);
  assert.throws(() => insertItem("n3-item-partial", "13", { ciphertext: "x" }), /CHECK/);
  assert.throws(
    () => db.prepare("UPDATE sales_channel_order_import_items SET channel_order_import_id='missing'").run(),
    /FOREIGN KEY/,
  );
});

test("AES-256-GCM uses random IV, authenticates data and exposes only safe errors", () => {
  const pii = { name: "테스트주문자", phone: "01011112222" };
  const first = encryptPii(pii, { key: PII_KEY, keyVersion: "v1" });
  const second = encryptPii(pii, { key: PII_KEY, keyVersion: "v1" });
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.ciphertext.includes(pii.name), false);
  assert.deepEqual(decryptPii(first, { key: PII_KEY }), pii);
  assert.throws(
    () => decryptPii({ ...first, authTag: Buffer.alloc(16).toString("base64") }, { key: PII_KEY }),
    (error) => error instanceof PiiCryptoError
      && error.code === "PII_AUTHENTICATION_FAILED"
      && !error.message.includes("테스트주문자"),
  );
  assert.equal(maskName("홍길동"), "홍*동");
  assert.equal(maskPhone("01012345678"), "010-****-5678");
});

test("PII crypto rejects malformed inputs, wrong keys and non-JSON canonical values", () => {
  const encrypted = encryptPii({ name: "fixture-private-name" }, {
    key: PII_KEY, keyVersion: "v1",
  });
  assert.equal(Buffer.from(encrypted.iv, "base64").length, 12);
  assert.equal(Buffer.from(encrypted.authTag, "base64").length, 16);
  for (const field of ["ciphertext", "iv", "authTag"]) {
    assert.throws(
      () => decryptPii({ ...encrypted, [field]: `${encrypted[field]}!` }, { key: PII_KEY }),
      (error) => error.code === "PII_AUTHENTICATION_FAILED",
    );
  }
  assert.throws(
    () => decryptPii(encrypted, { key: Buffer.alloc(32, 8).toString("base64") }),
    (error) => error.code === "PII_AUTHENTICATION_FAILED",
  );
  assert.throws(
    () => decryptPii({ ...encrypted, authTag: Buffer.alloc(16, 1).toString("base64") }, { key: PII_KEY }),
    (error) => error.code === "PII_AUTHENTICATION_FAILED",
  );
  for (const invalid of [undefined, () => {}, Symbol("x"), 1n, NaN, Infinity]) {
    assert.throws(() => canonicalize(invalid), (error) => error.code === "PII_VALUE_INVALID");
  }
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalize(circular), (error) => error.code === "PII_VALUE_INVALID");
  const inherited = Object.create({ polluted: "secret" });
  inherited.safe = "value";
  assert.throws(() => canonicalize(inherited), (error) => error.code === "PII_VALUE_INVALID");
  const nullPrototype = Object.create(null);
  nullPrototype.safe = "value";
  assert.equal(canonicalize(nullPrototype), "{\"safe\":\"value\"}");
  assert.equal(encrypted.ciphertext.includes("fixture-private-name"), false);
});

test("canonical arrays are dense JSON arrays without extra enumerable properties", () => {
  assert.equal(canonicalize([]), "[]");
  const canonical = canonicalize([3, { b: 2, a: 1 }, ["nested"]]);
  assert.equal(canonical, "[3,{\"a\":1,\"b\":2},[\"nested\"]]");
  assert.deepEqual(JSON.parse(canonical), [3, { a: 1, b: 2 }, ["nested"]]);

  const firstMissing = Array(2);
  firstMissing[1] = "second";
  const middleMissing = ["first", "second", "third"];
  delete middleMissing[1];
  const lastMissing = ["first", "second", "third"];
  delete lastMissing[2];
  const nestedMissing = [["first", "second"]];
  delete nestedMissing[0][0];
  const withExtra = ["first"];
  withExtra.extra = "not-json";

  for (const invalid of [
    firstMissing, middleMissing, lastMissing, nestedMissing, withExtra,
    [undefined], [() => {}], [Symbol("x")], [1n],
  ]) {
    assert.throws(() => canonicalize(invalid), (error) => error.code === "PII_VALUE_INVALID");
  }
});

test("order wrapper uses fixed paths, encoded continuation and a 300-ID detailed POST", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const client = { request: async (requestPath, options) => {
    calls.push({ requestPath, options });
    if (options.method === "GET") {
      return {
        data: {
          data: [feed()],
          more: { moreFrom: "2026-07-29T10:00:00+09:00", moreSequence: "7" },
        },
        traceId: "fixture-trace",
      };
    }
    return { data: { data: [detail()] } };
  } };
  const service = createNaverOrderService({ client });
  const changed = await service.getLastChangedProductOrders({
    lastChangedFrom: "2026-07-29T00:00:00+09:00",
    lastChangedTo: "2026-07-29T23:59:59+09:00",
    moreSequence: "6",
    limitCount: 300,
    signal,
  });
  assert.match(calls[0].requestPath, /^\/v1\/pay-order\/seller\/product-orders\/last-changed-statuses\?/);
  const query = new URL(calls[0].requestPath, "https://fixture.invalid").searchParams;
  assert.equal(query.get("moreSequence"), "6");
  assert.equal(query.get("limitCount"), "300");
  assert.equal(calls[0].options.signal, signal);
  assert.equal(changed.more.moreSequence, "7");

  await service.getProductOrders(
    ["202607290000000101", "202607290000000101"],
    { quantityClaimCompatibility: true, signal },
  );
  assert.equal(calls[1].requestPath, "/v1/pay-order/seller/product-orders/query");
  assert.equal(calls[1].options.retryOnAuth, true);
  assert.equal(calls[1].options.signal, signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    productOrderIds: ["202607290000000101"],
    quantityClaimCompatibility: true,
  });
});

test("wrapper input validation rejects empty, 301, numeric and unsafe product order IDs", () => {
  assert.throws(() => productOrderIds([]), NaverOrderImportError);
  assert.throws(() => productOrderIds(Array.from({ length: 301 }, (_, index) => String(index + 1))), NaverOrderImportError);
  assert.throws(() => productOrderIds([123]), NaverOrderImportError);
  assert.throws(() => productOrderIds([Number.MAX_SAFE_INTEGER + 1]), NaverOrderImportError);
});

test("normalization preserves string IDs, offsets, unknown status and minimal PII only", () => {
  const value = normalized({
    feed: { productOrderStatus: "FUTURE_STATUS" },
    detail: { productOrder: { productOrderStatus: "FUTURE_STATUS" } },
  });
  assert.equal(value.header.externalOrderId, "202607290000000001");
  assert.equal(value.item.externalProductOrderId, "202607290000000101");
  assert.equal(value.item.externalChannelProductNo, "800000000000000001");
  assert.equal(value.header.sourceChangedAt, "2026-07-29T10:00:00+09:00");
  assert.equal(value.item.externalProductOrderStatus, "FUTURE_STATUS");
  assert.equal(value.item.initialQuantity, 2);
  assert.equal(value.item.remainingQuantity, 2);
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "never-store-this", "never-store-seller-address", "127.0", "37.0",
    "takingAddress", "individualCustomUniqueCode",
  ]) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(Object.keys(value.item.pii).sort(), [
    "baseAddress", "detailedAddress", "entryMethod", "entryMethodContent",
    "postalCode", "recipientName", "recipientPhone", "shippingMemo",
  ]);
});

test("normalization rejects numeric IDs, malformed quantities, amounts and dates", () => {
  assert.throws(() => normalizeChangeFeedItem(feed({ orderId: 123 })), NaverOrderImportError);
  assert.throws(() => normalizeDetailedProductOrder(detail({
    productOrder: { initialQuantity: -1 },
  })), NaverOrderImportError);
  assert.throws(() => normalizeDetailedProductOrder(detail({
    order: { totalPaymentAmount: 1.2 },
  })), NaverOrderImportError);
  assert.throws(() => normalizeDetailedProductOrder(detail({
    order: { orderDate: "not-a-date" },
  })), NaverOrderImportError);
});

test("date normalization accepts only valid RFC3339 date-times and preserves offsets", () => {
  for (const value of [
    "2026-07-29T10:30:00Z",
    "2026-07-29T10:30:00+09:00",
    "2026-07-29T10:30:00.123+09:00",
  ]) {
    assert.equal(normalizeChangeFeedItem(feed({ lastChangedDate: value })).lastChangedAt, value);
  }
  for (const value of [
    "2026-07-29",
    "2026-07-29T10:30:00",
    "July 29 2026",
    "2026-02-30T10:30:00Z",
    "2026-07-29T25:30:00Z",
    1785292200000,
    "",
  ]) {
    assert.throws(
      () => normalizeChangeFeedItem(feed({ lastChangedDate: value })),
      (error) => error.code === "NAVER_ORDER_RESPONSE_INVALID",
    );
  }
});

test("canonical hash is stable across key order and independent of random encryption output", () => {
  assert.equal(canonicalHash({ b: 2, a: { y: 2, x: 1 } }), canonicalHash({ a: { x: 1, y: 2 }, b: 2 }));
  const snapshot = normalized();
  const hash = canonicalHash(snapshot);
  encryptPii(snapshot.header.pii, { key: PII_KEY, keyVersion: "v1" });
  encryptPii(snapshot.header.pii, { key: PII_KEY, keyVersion: "v1" });
  assert.equal(canonicalHash(snapshot), hash);
});

test("only ACTIVE product mappings connect imports; disabled and missing mappings remain UNMAPPED", () => {
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO sales_channel_product_mappings (
    id, channel, internal_product_id, external_origin_product_no, external_channel_product_no,
    channel_service_type, external_product_name, external_status, mapping_status, created_at, updated_at
  ) VALUES (?, 'naver', ?, ?, ?, 'STOREFARM', 'fixture', 'SALE', ?, ?, ?)`);
  insert.run("n3-active", "injeolmi", "900000000000000001", "800000000000000001", "ACTIVE", now, now);
  insert.run("n3-disabled", "mugwort-injeolmi", "900000000000000002", "800000000000000002", "DISABLED", now, now);
  assert.deepEqual(resolveProductMapping(db, "800000000000000001"), {
    productMappingId: "n3-active", internalProductId: "injeolmi", mappingStatus: "MAPPED",
  });
  assert.deepEqual(resolveProductMapping(db, "800000000000000002"), {
    productMappingId: null, internalProductId: null, mappingStatus: "UNMAPPED",
  });
  assert.equal(resolveProductMapping(db, "999").mappingStatus, "UNMAPPED");
});

test("repository inserts, no-ops, updates, ignores stale snapshots and encrypts PII", () => {
  const repo = repository();
  const first = normalized();
  const inserted = repo.upsertOrderImport({ header: first.header, items: [first.item], actor: "fixture-admin" });
  assert.equal(inserted.outcome, "insert");
  assert.equal(inserted.items[0].outcome, "insert");
  const headerRow = db.prepare("SELECT * FROM sales_channel_order_imports").get();
  const itemRow = db.prepare("SELECT * FROM sales_channel_order_import_items").get();
  assert.equal(headerRow.order_pii_ciphertext.includes("테스트주문자"), false);
  assert.equal(itemRow.item_pii_ciphertext.includes("테스트수령인"), false);
  assert.equal(itemRow.mapping_status, "UNMAPPED");
  assert.deepEqual({
    groupProductId: itemRow.external_group_product_id,
    packageNumber: itemRow.external_package_number,
    itemNo: itemRow.external_item_no,
    optionManageCode: itemRow.external_option_manage_code,
  }, {
    groupProductId: "700000000000000001",
    packageNumber: "600000000000000001",
    itemNo: "fixture-item",
    optionManageCode: "fixture-option-code",
  });
  assert.equal(itemRow.payload_hash, canonicalHash(first.item));
  assert.equal(repo.upsertOrderImport({ header: first.header, items: [first.item] }).outcome, "noop");

  const newer = normalized({
    feed: { lastChangedDate: "2026-07-29T11:00:00+09:00" },
    detail: { productOrder: { remainQuantity: 1 } },
  });
  const updated = repo.upsertOrderImport({ header: newer.header, items: [newer.item] });
  assert.equal(updated.outcome, "update");
  assert.equal(updated.items[0].outcome, "update");
  assert.equal(db.prepare("SELECT remaining_quantity FROM sales_channel_order_import_items").get().remaining_quantity, 1);

  const stale = normalized({
    feed: { lastChangedDate: "2026-07-29T09:00:00+09:00" },
    detail: { productOrder: { remainQuantity: 0 } },
  });
  assert.equal(repo.upsertOrderImport({ header: stale.header, items: [stale.item] }).outcome, "stale");
  assert.equal(db.prepare("SELECT remaining_quantity FROM sales_channel_order_import_items").get().remaining_quantity, 1);
});

test("external item identifiers remain TEXT, update verbatim and reject numeric values", () => {
  const repo = repository();
  const first = normalized();
  repo.upsertOrderImport({ header: first.header, items: [first.item] });
  const changed = normalized({
    feed: { lastChangedDate: "2026-07-29T11:00:00+09:00" },
    detail: { productOrder: {
      groupProductId: "700000000000000009",
      packageNumber: "600000000000000009",
      itemNo: "item-0009",
      optionManageCode: "option-0009",
    } },
  });
  repo.upsertOrderImport({ header: changed.header, items: [changed.item] });
  const row = db.prepare(`SELECT external_group_product_id, external_package_number,
    external_item_no, external_option_manage_code, payload_hash
    FROM sales_channel_order_import_items`).get();
  assert.deepEqual({ ...row }, {
    external_group_product_id: "700000000000000009",
    external_package_number: "600000000000000009",
    external_item_no: "item-0009",
    external_option_manage_code: "option-0009",
    payload_hash: canonicalHash(changed.item),
  });
  for (const field of ["groupProductId", "packageNumber", "itemNo", "optionManageCode"]) {
    assert.throws(
      () => normalizeDetailedProductOrder(detail({ productOrder: { [field]: Number.MAX_SAFE_INTEGER + 1 } })),
      (error) => error.code === "NAVER_ORDER_RESPONSE_INVALID",
    );
  }
});

test("repository requires every item to belong to the header before and inside its transaction", () => {
  const repo = repository();
  const first = normalized();
  const second = normalized({
    feed: {
      orderId: "202607290000000002",
      productOrderId: "202607290000000102",
    },
    detail: {
      order: { orderId: "202607290000000002" },
      productOrder: { productOrderId: "202607290000000102" },
    },
  });
  for (const items of [
    [{ ...first.item, externalOrderId: undefined }],
    [{ ...first.item, externalOrderId: second.header.externalOrderId }],
    [first.item, second.item],
  ]) {
    const beforeAudit = db.prepare("SELECT COUNT(*) count FROM activity_logs").get().count;
    assert.throws(
      () => repo.upsertOrderImport({ header: first.header, items }),
      (error) => error.code === "NAVER_ORDER_HEADER_CONFLICT",
    );
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_order_imports").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_order_import_items").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM activity_logs").get().count, beforeAudit);
  }
});

test("audit records null create state, exact update state and MANUAL_REVIEW conflict state", () => {
  const repo = repository();
  const first = normalized();
  repo.upsertOrderImport({ header: first.header, items: [first.item] });
  let log = db.prepare(`SELECT previous_value, next_value FROM activity_logs
    WHERE action='naver_order_import_upserted' ORDER BY created_at DESC`).get();
  assert.equal(log.previous_value, null);
  assert.equal(log.next_value, "IMPORTED");

  db.prepare("UPDATE sales_channel_order_imports SET import_status='PARTIAL'").run();
  const newer = normalized({ feed: { lastChangedDate: "2026-07-29T11:00:00+09:00" } });
  repo.upsertOrderImport({ header: newer.header, items: [newer.item] });
  log = db.prepare(`SELECT previous_value, next_value FROM activity_logs
    WHERE action='naver_order_import_upserted' ORDER BY rowid DESC`).get();
  assert.equal(log.previous_value, "PARTIAL");
  assert.equal(log.next_value, "IMPORTED");

  const conflict = normalized({
    feed: { lastChangedDate: "2026-07-29T11:00:00+09:00" },
    detail: { productOrder: { remainQuantity: 1 } },
  });
  repo.upsertOrderImport({ header: conflict.header, items: [conflict.item] });
  log = db.prepare(`SELECT previous_value, next_value FROM activity_logs
    WHERE action='naver_order_import_upserted' ORDER BY rowid DESC`).get();
  assert.equal(log.previous_value, "IMPORTED");
  assert.equal(log.next_value, "MANUAL_REVIEW");

  const headerConflict = normalized({
    feed: { lastChangedDate: "2026-07-29T11:00:00+09:00" },
    detail: { order: { paymentMeans: "CHANGED" } },
  });
  repo.upsertOrderImport({ header: headerConflict.header, items: [headerConflict.item] });
  log = db.prepare(`SELECT previous_value, next_value FROM activity_logs
    WHERE action='naver_order_import_upserted' ORDER BY rowid DESC`).get();
  assert.equal(log.previous_value, "MANUAL_REVIEW");
  assert.equal(log.next_value, "MANUAL_REVIEW");
});

test("noop header with mapping-only update audits the status actually retained in DB", () => {
  const repo = repository();
  const first = normalized();
  repo.upsertOrderImport({ header: first.header, items: [first.item] });
  db.prepare("UPDATE sales_channel_order_imports SET import_status='PARTIAL'").run();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sales_channel_product_mappings (
    id, channel, internal_product_id, external_origin_product_no, external_channel_product_no,
    channel_service_type, external_product_name, external_status, mapping_status, created_at, updated_at
  ) VALUES ('n3-audit-mapping', 'naver', 'injeolmi', ?, ?, 'STOREFARM',
    'fixture', 'SALE', 'ACTIVE', ?, ?)`).run(
    first.item.externalOriginProductNo, first.item.externalChannelProductNo, now, now,
  );

  const result = repo.upsertOrderImport({ header: first.header, items: [first.item] });
  assert.equal(result.outcome, "noop");
  assert.equal(result.items[0].outcome, "mapping_update");
  assert.equal(
    db.prepare("SELECT import_status FROM sales_channel_order_imports").get().import_status,
    "PARTIAL",
  );
  const log = db.prepare(`SELECT previous_value, next_value FROM activity_logs
    WHERE action='naver_order_import_upserted' ORDER BY rowid DESC`).get();
  assert.deepEqual({ ...log }, { previous_value: "PARTIAL", next_value: "PARTIAL" });
});

test("same timestamp with different canonical content becomes MANUAL_REVIEW", () => {
  const repo = repository();
  const first = normalized();
  repo.upsertOrderImport({ header: first.header, items: [first.item] });
  const changed = normalized({ detail: { productOrder: { remainQuantity: 1 } } });
  const result = repo.upsertOrderImport({ header: changed.header, items: [changed.item] });
  assert.equal(result.items[0].outcome, "conflict");
  const header = db.prepare("SELECT import_status, last_error_code FROM sales_channel_order_imports").get();
  assert.deepEqual({ ...header }, {
    import_status: "MANUAL_REVIEW", last_error_code: "SNAPSHOT_CONFLICT",
  });
});

test("moving one productOrderId to another header conflicts and audit failure rolls back", () => {
  const repo = repository();
  const first = normalized();
  repo.upsertOrderImport({ header: first.header, items: [first.item] });
  const moved = normalized({
    feed: {
      orderId: "202607290000000002",
      lastChangedDate: "2026-07-29T11:00:00+09:00",
    },
    detail: {
      order: { orderId: "202607290000000002" },
    },
  });
  assert.throws(
    () => repo.upsertOrderImport({ header: moved.header, items: [moved.item] }),
    (error) => error.code === "NAVER_PRODUCT_ORDER_HEADER_CONFLICT",
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_order_imports").get().count, 1);

  cleanup();
  db.exec(`CREATE TEMP TRIGGER fail_n3_audit BEFORE INSERT ON activity_logs
    WHEN NEW.action='naver_order_import_upserted'
    BEGIN SELECT RAISE(FAIL, 'fixture sensitive audit failure'); END`);
  try {
    assert.throws(
      () => repo.upsertOrderImport({ header: first.header, items: [first.item] }),
      (error) => error.code === "NAVER_ORDER_IMPORT_WRITE_FAILED"
        && !error.message.includes("fixture sensitive"),
    );
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sales_channel_order_imports").get().count, 0);
  } finally {
    db.exec("DROP TRIGGER fail_n3_audit");
  }
});

test("staging repository never changes existing orders, order_items or payments", () => {
  const counts = Object.fromEntries(["orders", "order_items", "payments"].map(
    (table) => [table, db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count],
  ));
  const value = normalized();
  repository().upsertOrderImport({ header: value.header, items: [value.item] });
  for (const [table, count] of Object.entries(counts)) {
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, count);
  }
  const source = [
    "routes/orders.js", "routes/payments.js", "index.js",
  ].map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");
  assert.equal(source.includes("sales_channel_order_imports"), false);
});
