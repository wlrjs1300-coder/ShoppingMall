const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { migrations } = require("../migrations");
const seededProducts = require("../data/products");

test("migration 29 fills only empty seeded detail images and preserves administrator data", () => {
  const migration = migrations.find((item) => item.version === 29);
  const seeded = seededProducts.find((product) => product.id === "baekil");
  const customDetails = ["assets/products/admin-custom-detail.png"];
  const db = new DatabaseSync(":memory:");

  db.exec(`CREATE TABLE products (
    id TEXT PRIMARY KEY,
    detail_images_json TEXT,
    updated_at TEXT
  )`);
  const insert = db.prepare("INSERT INTO products (id, detail_images_json, updated_at) VALUES (?, ?, ?)");
  insert.run("baekil", "[]", "before");
  insert.run("susupat", JSON.stringify(customDetails), "before");
  insert.run("admin-only-product", "[]", "before");

  migration.up(db);

  assert.deepEqual(JSON.parse(db.prepare("SELECT detail_images_json FROM products WHERE id='baekil'").get().detail_images_json), seeded.detailImages);
  assert.deepEqual(JSON.parse(db.prepare("SELECT detail_images_json FROM products WHERE id='susupat'").get().detail_images_json), customDetails);
  assert.equal(db.prepare("SELECT detail_images_json FROM products WHERE id='admin-only-product'").get().detail_images_json, "[]");
  db.close();
});
