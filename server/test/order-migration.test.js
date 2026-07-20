const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

test("기존 단일 상품 주문을 orders와 order_items 구조로 마이그레이션한다", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tteok-order-migration-"));
  const dbPath = path.join(directory, "legacy.db");
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY, customer TEXT, phone TEXT, product TEXT, price_text TEXT,
        quantity INTEGER, unit_price REAL, revenue REAL, cost REAL, pickup_date TEXT,
        pickup_time TEXT, fulfillment_type TEXT, logistics_status TEXT, delivery_address TEXT,
        status TEXT, memo TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        user_id TEXT, product_id TEXT, checkout_id TEXT
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare(`
      INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-order", "기존 고객", "01012345678", "기존 인절미", "3,500원", 2, 3500, 7000, 2000, "2099-01-01", "12:00", "pickup", "픽업대기", null, "접수대기", "기존 메모", now, now, null, "injeolmi", null);
    legacy.close();

    const probe = `
      const db = require('./db');
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get('legacy-order');
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all('legacy-order');
      process.stdout.write(JSON.stringify({ order, items }));
    `;
    const childEnv = { ...process.env, DB_PATH: dbPath, NODE_ENV: "test" };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["-e", probe], {
      cwd: path.join(__dirname, ".."),
      env: childEnv,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const migrated = JSON.parse(result.stdout);
    assert.equal(migrated.order.customer_name, "기존 고객");
    assert.equal(migrated.order.total_amount, 7000);
    assert.equal(migrated.items.length, 1);
    assert.equal(migrated.items[0].product_name, "기존 인절미");
    assert.equal(migrated.items[0].unit_price, 3500);
    assert.equal(migrated.items[0].quantity, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
