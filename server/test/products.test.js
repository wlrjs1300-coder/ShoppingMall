// 테스트 전용 환경변수 (실제 .env 값을 덮어쓰지 않도록 앱을 불러오기 전에 설정)
process.env.DB_PATH = ":memory:";
process.env.ADMIN_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret-for-products-tests-only";
process.env.NOTIFICATION_MODE = "none";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../index");
const db = require("../db");
const seedList = require("../data/products");

const now = new Date().toISOString();
function insertProduct(overrides = {}) {
  const base = {
    id: `test-product-${Math.random().toString(36).slice(2, 8)}`,
    name: "테스트 상품",
    category: "테스트",
    purchase_type: "direct",
    price: 1000,
    image_url: "assets/products/test.png",
    description: "설명",
    status: "active",
    display_order: 999,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO products (id, name, category, purchase_type, price, image_url, description, status, display_order, created_at, updated_at)
    VALUES (@id, @name, @category, @purchase_type, @price, @image_url, @description, @status, @display_order, @now, @now)
  `).run({ ...base, now });
  return base;
}

// 재시딩(=서버 재시작) 상황을 같은 프로세스 안에서 시뮬레이션하기 위한 헬퍼.
// db.js의 seedProducts()와 동일한 INSERT OR IGNORE 로직을 그대로 재현한다.
function reseed() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO products
      (id, name, category, purchase_type, price, image_url, description, status, display_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const t = new Date().toISOString();
  for (const p of seedList) {
    insert.run(p.id, p.name, p.category, p.purchaseType, p.price, p.imageUrl, p.description, p.displayOrder, t, t);
  }
}

// ─── 스키마 ──────────────────────────────────────────────────

test("products 테이블과 필수 컬럼이 존재한다", () => {
  const cols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  for (const col of ["id", "name", "category", "purchase_type", "price", "image_url", "description", "status", "display_order", "created_at", "updated_at"]) {
    assert.ok(cols.includes(col), `${col} 컬럼 누락`);
  }
});

test("id가 PRIMARY KEY다", () => {
  const cols = db.prepare("PRAGMA table_info(products)").all();
  const idCol = cols.find((c) => c.name === "id");
  assert.equal(idCol.pk, 1);
});

test("idx_products_status_display 인덱스가 존재한다", () => {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_products_status_display'").all();
  assert.equal(rows.length, 1);
});

test("purchase_type이 direct/consultation 외의 값이면 거부된다", () => {
  assert.throws(() => insertProduct({ purchase_type: "invalid" }), /CHECK constraint failed/);
});

test("status가 active/inactive 외의 값이면 거부된다", () => {
  assert.throws(() => insertProduct({ status: "deleted" }), /CHECK constraint failed/);
});

test("direct 상품인데 price가 NULL이면 거부된다", () => {
  assert.throws(() => insertProduct({ purchase_type: "direct", price: null }), /CHECK constraint failed/);
});

test("consultation 상품인데 price가 값이 있으면 거부된다", () => {
  assert.throws(() => insertProduct({ purchase_type: "consultation", price: 1000 }), /CHECK constraint failed/);
});

test("price가 음수면 거부된다", () => {
  assert.throws(() => insertProduct({ price: -100 }), /CHECK constraint failed/);
});

test("id가 중복되면 거부된다", () => {
  const p = insertProduct({ id: "dup-test-id" });
  assert.throws(() => insertProduct({ id: p.id }), /UNIQUE constraint failed/);
});

// ─── 시드 데이터 ─────────────────────────────────────────────

test("시드 상품이 정확히 30개다", () => {
  assert.equal(db.prepare("SELECT COUNT(*) c FROM products WHERE id LIKE '%' AND id NOT LIKE 'test-product-%' AND id NOT LIKE 'dup-test%'").get().c >= 30, true);
  // 정확한 30개 검증은 순수 시드 id 목록으로 별도 확인
  const seedIds = seedList.map((p) => p.id);
  const rows = db.prepare(`SELECT id FROM products WHERE id IN (${seedIds.map(() => "?").join(",")})`).all(...seedIds);
  assert.equal(rows.length, 30);
});

test("direct 25개, consultation 5개다", () => {
  const seedIds = seedList.map((p) => p.id);
  const placeholders = seedIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT purchase_type, COUNT(*) c FROM products WHERE id IN (${placeholders}) GROUP BY purchase_type`).all(...seedIds);
  const map = Object.fromEntries(rows.map((r) => [r.purchase_type, r.c]));
  assert.equal(map.direct, 25);
  assert.equal(map.consultation, 5);
});

test("시드 id에 중복이 없다", () => {
  const ids = seedList.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("display_order가 1~30에 중복·누락 없이 정확히 대응한다", () => {
  const orders = seedList.map((p) => p.displayOrder).sort((a, b) => a - b);
  assert.deepEqual(orders, Array.from({ length: 30 }, (_, i) => i + 1));
});

test("direct 상품 가격은 정수이며 0보다 크다", () => {
  for (const p of seedList.filter((p) => p.purchaseType === "direct")) {
    assert.ok(Number.isInteger(p.price) && p.price > 0, `${p.id}의 price가 올바르지 않음: ${p.price}`);
  }
});

test("consultation 상품 가격은 모두 NULL이다", () => {
  for (const p of seedList.filter((p) => p.purchaseType === "consultation")) {
    assert.equal(p.price, null, `${p.id}의 price가 NULL이 아님`);
  }
});

test("모든 상품의 image_url이 비어 있지 않다", () => {
  for (const p of seedList) {
    assert.ok(p.imageUrl && p.imageUrl.length > 0, `${p.id}의 image_url이 비어 있음`);
  }
});

test("재시딩(서버 재시작 시뮬레이션)해도 상품 수가 늘어나지 않는다", () => {
  const before = db.prepare("SELECT COUNT(*) c FROM products").get().c;
  reseed();
  const after = db.prepare("SELECT COUNT(*) c FROM products").get().c;
  assert.equal(after, before);
});

test("기존 상품 값을 수정한 뒤 재시딩해도 덮어써지지 않는다", () => {
  db.prepare("UPDATE products SET price = 77777, status = 'inactive' WHERE id = 'injeolmi'").run();
  reseed();
  const row = db.prepare("SELECT price, status FROM products WHERE id = 'injeolmi'").get();
  assert.equal(row.price, 77777);
  assert.equal(row.status, "inactive");
  // 다음 테스트에 영향 주지 않도록 원복
  db.prepare("UPDATE products SET price = 3500, status = 'active' WHERE id = 'injeolmi'").run();
});

// ─── API ─────────────────────────────────────────────────────

test("GET /api/products는 200과 상품 배열을 반환한다", async () => {
  const res = await request(app).get("/api/products");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.products));
});

test("GET /api/products는 active 상품만 반환한다", async () => {
  db.prepare("UPDATE products SET status = 'inactive' WHERE id = 'yaksik'").run();
  const res = await request(app).get("/api/products");
  const found = res.body.products.find((p) => p.id === "yaksik");
  assert.equal(found, undefined);
  db.prepare("UPDATE products SET status = 'active' WHERE id = 'yaksik'").run();
});

test("GET /api/products는 displayOrder 오름차순으로 반환한다", async () => {
  const res = await request(app).get("/api/products");
  const orders = res.body.products.map((p) => p.displayOrder);
  const sorted = [...orders].sort((a, b) => a - b);
  assert.deepEqual(orders, sorted);
});

test("응답의 가격은 숫자 또는 null이다", async () => {
  const res = await request(app).get("/api/products");
  for (const p of res.body.products) {
    assert.ok(p.price === null || typeof p.price === "number", `${p.id}의 price 타입 이상: ${typeof p.price}`);
  }
});

test("공개 상품 응답은 화면과 장바구니에 필요한 단일 상품 정보를 모두 포함한다", async () => {
  const res = await request(app).get("/api/products");
  for (const product of res.body.products) {
    for (const field of ["id", "name", "category", "purchaseType", "price", "imageUrl", "description", "displayOrder"]) {
      assert.ok(Object.hasOwn(product, field), `${product.id} 응답에 ${field} 누락`);
    }
  }
});

test("GET /api/products/:id는 존재하는 active 상품을 정상 반환한다", async () => {
  const res = await request(app).get("/api/products/honey-seolgi");
  assert.equal(res.status, 200);
  assert.equal(res.body.product.id, "honey-seolgi");
  assert.equal(res.body.product.name, "꿀설기");
  assert.equal(res.body.product.price, 3500);
  assert.equal(res.body.product.purchaseType, "direct");
});

test("상담 전용 상품은 price:null, purchaseType:consultation으로 반환된다", async () => {
  const res = await request(app).get("/api/products/baekil");
  assert.equal(res.status, 200);
  assert.equal(res.body.product.price, null);
  assert.equal(res.body.product.purchaseType, "consultation");
});

test("존재하지 않는 상품 ID는 404를 반환한다", async () => {
  const res = await request(app).get("/api/products/no-such-product-xyz");
  assert.equal(res.status, 404);
});

test("inactive 상품은 공개 단일조회에서 404로 숨겨진다", async () => {
  db.prepare("UPDATE products SET status = 'inactive' WHERE id = 'garaetteok'").run();
  const res = await request(app).get("/api/products/garaetteok");
  assert.equal(res.status, 404);
  db.prepare("UPDATE products SET status = 'active' WHERE id = 'garaetteok'").run();
});

test("SQL 삽입 형태의 id를 보내도 서버 오류 없이 안전하게 404를 반환한다", async () => {
  const res = await request(app).get("/api/products/" + encodeURIComponent("' OR '1'='1"));
  assert.equal(res.status, 404);
});

test("응답에 내부 SQL/스택 정보가 노출되지 않는다", async () => {
  const res = await request(app).get("/api/products/no-such-product-xyz");
  const text = JSON.stringify(res.body);
  assert.ok(!/SQLITE|at Object|node_modules|\.js:\d+/.test(text), `민감 정보 노출 의심: ${text}`);
});
