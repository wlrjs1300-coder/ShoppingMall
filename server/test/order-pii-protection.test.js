process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const db = require("../db");
const { migrations } = require("../migrations");
const {
  PiiKeyringError, getPiiKey, parsePiiKeyring,
} = require("../lib/pii-keyring");
const {
  OrderPiiError, buildOrderPiiColumns, decryptOrderPii, encryptOrderPii,
  maskOrderPii, readOrderPii,
} = require("../services/order-pii-service");

const keyV1 = Buffer.alloc(32, 11).toString("base64");
const keyV2 = Buffer.alloc(32, 22).toString("base64");
const keysJson = JSON.stringify([
  { version: "v1", key: keyV1 },
  { version: "v2", key: keyV2 },
]);
const keyring = parsePiiKeyring(keysJson, "v2");
const fixturePii = {
  customerName: "테스트고객",
  customerPhone: "010-1234-5678",
  deliveryAddress: "테스트시 테스트구 예시로 10",
  guestAddress: null,
};

function createLegacyOrder(database, id = "legacy-order") {
  database.prepare(`INSERT INTO orders (
    id, customer_name, customer_phone, fulfillment_type, delivery_address,
    subtotal, delivery_fee, total_amount, cost, status, payment_status,
    amount_status, created_at, updated_at
  ) VALUES (?, ?, ?, 'delivery', ?, 1000, 0, 1000, 0, '접수대기',
    '결제대기', 'confirmed', ?, ?)`).run(
    id, fixturePii.customerName, "01012345678", fixturePii.deliveryAddress,
    "2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z",
  );
}

test("migration 15 adds nullable TEXT PII columns without changing existing orders or seeding rows", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    fulfillment_type TEXT NOT NULL,
    delivery_address TEXT,
    subtotal INTEGER NOT NULL,
    delivery_fee INTEGER NOT NULL,
    total_amount INTEGER NOT NULL,
    cost INTEGER NOT NULL,
    status TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    amount_status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  createLegacyOrder(database);
  migrations.find((migration) => migration.version === 15).up(database);
  const columns = new Map(
    database.prepare("PRAGMA table_info(orders)").all().map((column) => [column.name, column]),
  );
  for (const name of [
    "pii_ciphertext", "pii_iv", "pii_auth_tag", "pii_key_version",
    "customer_name_masked", "customer_phone_masked", "delivery_region_masked",
    "pii_migrated_at",
  ]) {
    assert.equal(columns.get(name).type, "TEXT");
    assert.equal(columns.get(name).notnull, 0);
  }
  assert.equal(database.prepare("SELECT COUNT(*) count FROM orders").get().count, 1);
  const legacy = database.prepare("SELECT * FROM orders WHERE id='legacy-order'").get();
  assert.equal(legacy.customer_name, fixturePii.customerName);
  assert.equal(legacy.pii_ciphertext, null);
  database.close();
});

test("migration 15 enforces complete encryption tuples and metadata limits", () => {
  const id = "pii-migration-constraint";
  createLegacyOrder(db, id);
  assert.doesNotThrow(() => createLegacyOrder(db, "pii-plaintext-insert"));
  assert.throws(
    () => db.prepare(`INSERT INTO orders (
      id, customer_name, customer_phone, fulfillment_type, subtotal, delivery_fee,
      total_amount, cost, status, payment_status, amount_status, created_at, updated_at,
      pii_ciphertext
    ) VALUES ('pii-partial-insert', 'fixture', '01000000000', 'pickup', 0, 0,
      0, 0, '접수대기', '결제대기', 'confirmed', '2026-07-30', '2026-07-30', 'partial')`).run(),
    /ORDER_PII_TUPLE_INVALID/,
  );
  assert.throws(
    () => db.prepare("UPDATE orders SET pii_ciphertext='partial' WHERE id=?").run(id),
    /ORDER_PII_TUPLE_INVALID/,
  );
  assert.doesNotThrow(() => db.prepare(`UPDATE orders SET
    pii_ciphertext='cipher', pii_iv='iv', pii_auth_tag='tag', pii_key_version='v1'
    WHERE id=?`).run(id));
  for (const [column, length] of [
    ["pii_key_version", 101],
    ["customer_name_masked", 201],
    ["customer_phone_masked", 101],
    ["delivery_region_masked", 301],
  ]) {
    assert.throws(
      () => db.prepare(`UPDATE orders SET ${column}=? WHERE id=?`).run("x".repeat(length), id),
      /ORDER_PII_METADATA_INVALID/,
    );
  }
});

test("keyring accepts multiple canonical keys and active and historical versions", () => {
  const ring = parsePiiKeyring(keysJson, "v2");
  assert.equal(ring.activeVersion, "v2");
  assert.equal(ring.hasVersion("v1"), true);
  assert.equal(ring.hasVersion("missing"), false);
  assert.deepEqual(getPiiKey(ring, "v1"), Buffer.alloc(32, 11));
  assert.deepEqual(getPiiKey(ring, "v2"), Buffer.alloc(32, 22));
});

test("keyring safely rejects malformed, sparse, duplicate, unknown-field and invalid versions", () => {
  const cases = [
    ["{", "v1", "ORDER_PII_KEYRING_JSON_INVALID"],
    ["{}", "v1", "ORDER_PII_KEYRING_INVALID"],
    ["[]", "v1", "ORDER_PII_KEYRING_INVALID"],
    ["[,]", "v1", "ORDER_PII_KEYRING_JSON_INVALID"],
    [JSON.stringify([
      { version: "v1", key: keyV1 },
      { version: "v1", key: keyV2 },
    ]), "v1", "ORDER_PII_KEY_VERSION_DUPLICATE"],
    [JSON.stringify([{ version: "v1", key: keyV1, extra: true }]), "v1", "ORDER_PII_KEYRING_ITEM_INVALID"],
    [JSON.stringify([{ version: "", key: keyV1 }]), "v1", "ORDER_PII_KEY_VERSION_INVALID"],
    [JSON.stringify([{ version: "v1", key: "bad" }]), "v1", "ORDER_PII_KEY_INVALID"],
    [JSON.stringify([{ version: "v1", key: Buffer.alloc(31).toString("base64") }]), "v1", "ORDER_PII_KEY_INVALID"],
    [JSON.stringify([{ version: "v1", key: keyV1 }]), "v2", "ORDER_PII_ACTIVE_KEY_UNKNOWN"],
  ];
  for (const [json, active, code] of cases) {
    assert.throws(
      () => parsePiiKeyring(json, active),
      (error) => error instanceof PiiKeyringError && error.code === code
        && !error.message.includes(keyV1) && !error.message.includes(keyV2),
    );
  }
});

test("keyring encapsulates key buffers and returns a fresh copy for every access", () => {
  const ring = parsePiiKeyring(keysJson, "v2");
  assert.deepEqual(Object.keys(ring).sort(), ["activeVersion", "getKey", "hasVersion"]);
  assert.equal(ring.keys, undefined);
  const exposed = ring.getKey("v1");
  exposed.fill(0);
  assert.deepEqual(ring.getKey("v1"), Buffer.alloc(32, 11));
  assert.notStrictEqual(ring.getKey("v1"), ring.getKey("v1"));
});

test("order PII uses the active key, decrypts historical keys and randomizes IVs", () => {
  const first = encryptOrderPii(fixturePii, keyring);
  const second = encryptOrderPii(fixturePii, keyring);
  assert.equal(first.keyVersion, "v2");
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(decryptOrderPii({
    pii_ciphertext: first.ciphertext,
    pii_iv: first.iv,
    pii_auth_tag: first.authTag,
    pii_key_version: first.keyVersion,
  }, keyring), { ...fixturePii, customerPhone: "01012345678" });

  const old = encryptOrderPii(fixturePii, parsePiiKeyring(keysJson, "v1"));
  assert.equal(decryptOrderPii({
    pii_ciphertext: old.ciphertext,
    pii_iv: old.iv,
    pii_auth_tag: old.authTag,
    pii_key_version: old.keyVersion,
  }, keyring).customerName, fixturePii.customerName);
});

test("wrong tags and unknown versions fail without exposing protected values", () => {
  const encrypted = encryptOrderPii(fixturePii, keyring);
  const row = {
    pii_ciphertext: encrypted.ciphertext,
    pii_iv: encrypted.iv,
    pii_auth_tag: Buffer.alloc(16, 1).toString("base64"),
    pii_key_version: encrypted.keyVersion,
    customer_name: fixturePii.customerName,
    customer_phone: "01012345678",
  };
  assert.throws(
    () => readOrderPii(row, keyring),
    (error) => error instanceof OrderPiiError
      && error.code === "ORDER_PII_DECRYPTION_FAILED"
      && !error.message.includes(fixturePii.customerName),
  );
  assert.throws(
    () => decryptOrderPii({ ...row, pii_key_version: "missing" }, keyring),
    (error) => error.code === "ORDER_PII_DECRYPTION_FAILED",
  );
});

test("encrypted rows never use legacy fallback while legacy rows remain readable", () => {
  assert.deepEqual(readOrderPii({
    customer_name: fixturePii.customerName,
    customer_phone: "01012345678",
    delivery_address: fixturePii.deliveryAddress,
    guest_address: null,
    pii_ciphertext: null,
    pii_iv: null,
    pii_auth_tag: null,
    pii_key_version: null,
  }, keyring), { ...fixturePii, customerPhone: "01012345678" });
  assert.throws(
    () => readOrderPii({
      customer_name: fixturePii.customerName,
      customer_phone: "01012345678",
      pii_ciphertext: "partial",
      pii_iv: null,
      pii_auth_tag: null,
      pii_key_version: null,
    }, keyring),
    (error) => error.code === "ORDER_PII_ENCRYPTED_DATA_INVALID",
  );
});

test("legacy read reports incomplete identity but permits missing addresses", () => {
  const base = {
    customer_name: fixturePii.customerName,
    customer_phone: "01012345678",
    delivery_address: null,
    guest_address: null,
    pii_ciphertext: null,
    pii_iv: null,
    pii_auth_tag: null,
    pii_key_version: null,
  };
  assert.deepEqual(readOrderPii(base, keyring), {
    customerName: fixturePii.customerName,
    customerPhone: "01012345678",
    deliveryAddress: null,
    guestAddress: null,
  });
  for (const row of [
    { ...base, customer_name: null },
    { ...base, customer_name: " " },
    { ...base, customer_phone: null },
    { ...base, customer_phone: "" },
  ]) {
    assert.throws(
      () => readOrderPii(row, keyring),
      (error) => error.code === "ORDER_PII_LEGACY_INCOMPLETE",
    );
  }
});

test("delivery region derivation never retains detailed address tokens", () => {
  for (const address of [
    "강남대로 123",
    "테헤란로 10길",
    "OO아파트 101동",
    "123 Main Street",
    "상세주소",
  ]) {
    const masked = maskOrderPii({ ...fixturePii, deliveryAddress: address });
    assert.equal(masked.deliveryRegionMasked, null);
    assert.equal(JSON.stringify(masked).includes(address), false);
    for (const token of address.split(/\s+/)) {
      assert.equal(JSON.stringify(masked).includes(token), false);
    }
  }
});

test("column builder returns encrypted storage and masked derivatives without raw PII", () => {
  const columns = buildOrderPiiColumns(fixturePii, keyring, "2026-07-30T00:00:00.000Z");
  assert.equal(columns.piiKeyVersion, "v2");
  assert.equal(columns.piiMigratedAt, "2026-07-30T00:00:00.000Z");
  assert.deepEqual(maskOrderPii(fixturePii), {
    customerNameMasked: "테***객",
    customerPhoneMasked: "010-****-5678",
    deliveryRegionMasked: null,
  });
  const serialized = JSON.stringify(columns);
  for (const raw of [fixturePii.customerName, "01012345678", fixturePii.deliveryAddress]) {
    assert.equal(serialized.includes(raw), false);
  }
});
