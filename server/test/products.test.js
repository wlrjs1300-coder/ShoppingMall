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
let adminToken = "";

async function getAdminToken() {
  if (adminToken) return adminToken;
  const response = await request(app).post("/api/auth/login").send({ code: process.env.ADMIN_CODE }).expect(200);
  adminToken = response.body.token;
  return adminToken;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}
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
  for (const col of ["id", "name", "category", "purchase_type", "price", "unit_weight_grams", "half_mal_weight_grams", "mal_weight_grams", "image_url", "description", "status", "display_order", "created_at", "updated_at"]) {
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

test("시드 상품이 정확히 31개다", () => {
  assert.equal(db.prepare("SELECT COUNT(*) c FROM products WHERE id LIKE '%' AND id NOT LIKE 'test-product-%' AND id NOT LIKE 'dup-test%'").get().c >= 31, true);
  // 정확한 31개 검증은 순수 시드 id 목록으로 별도 확인
  const seedIds = seedList.map((p) => p.id);
  const rows = db.prepare(`SELECT id FROM products WHERE id IN (${seedIds.map(() => "?").join(",")})`).all(...seedIds);
  assert.equal(rows.length, 31);
});

test("direct 26개, consultation 5개다", () => {
  const seedIds = seedList.map((p) => p.id);
  const placeholders = seedIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT purchase_type, COUNT(*) c FROM products WHERE id IN (${placeholders}) GROUP BY purchase_type`).all(...seedIds);
  const map = Object.fromEntries(rows.map((r) => [r.purchase_type, r.c]));
  assert.equal(map.direct, 26);
  assert.equal(map.consultation, 5);
});

test("시드 id에 중복이 없다", () => {
  const ids = seedList.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("display_order가 1~31에 중복·누락 없이 정확히 대응한다", () => {
  const orders = seedList.map((p) => p.displayOrder).sort((a, b) => a - b);
  assert.deepEqual(orders, Array.from({ length: 31 }, (_, i) => i + 1));
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

test("모듬찰떡은 확정된 상품명·팩 가격·중량·짧은 설명을 반환한다", async () => {
  const res = await request(app).get("/api/products/assorted-chaltteok");
  assert.equal(res.status, 200);
  assert.equal(res.body.product.name, "모듬찰떡");
  assert.equal(res.body.product.price, 4000);
  assert.equal(res.body.product.unitWeightGrams, 230);
  assert.equal(res.body.product.description, "단호박과 밤, 팥, 검은콩을 넉넉히 넣어 만든 수제 모듬찰떡");
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

// ─── 관리자 메뉴 관리 API ───────────────────────────────────

test("관리자 상품 목록은 인증을 요구하고 판매 중지 상품도 반환한다", async () => {
  await request(app).get("/api/products/admin").expect(401);
  db.prepare("UPDATE products SET status='inactive' WHERE id='yaksik'").run();
  const token = await getAdminToken();
  const response = await request(app).get("/api/products/admin").set(auth(token)).expect(200);
  assert.equal(response.body.products.find((product) => product.id === "yaksik")?.status, "inactive");
  db.prepare("UPDATE products SET status='active' WHERE id='yaksik'").run();
});

test("기존 메뉴 수정 응답은 상세 페이지와 같은 기본 원산지를 제공한다", async () => {
  const token = await getAdminToken();
  const response = await request(app).get("/api/products/admin").set(auth(token)).expect(200);
  const yaksik = response.body.products.find((product) => product.id === "yaksik");
  assert.deepEqual(yaksik.originItems, [
    { ingredient: "찹쌀", origin: "국내산" },
    { ingredient: "흑설탕", origin: "외국산" },
    { ingredient: "밤", origin: "국내산" },
    { ingredient: "대추", origin: "국내산" },
    { ingredient: "잣", origin: "국내산" },
    { ingredient: "참기름", origin: "국내산" },
  ]);
});

test("흰절편 상세 페이지는 네 개의 원산지 항목을 입력 순서대로 제공한다", async () => {
  const response = await request(app).get("/api/products/white-jeolpyeon").expect(200);
  assert.deepEqual(response.body.product.originItems, [
    { ingredient: "멥쌀", origin: "국내산" },
    { ingredient: "소금", origin: "국내산" },
    { ingredient: "설탕", origin: "외국산" },
    { ingredient: "참기름", origin: "국내산" },
  ]);
});

test("관리자는 상세 페이지가 요구하는 필드로 새 메뉴를 등록하고 수정한다", async () => {
  const token = await getAdminToken();
  const created = await request(app).post("/api/products/admin").set(auth(token)).send({
    id: "seasonal-strawberry-seolgi",
    name: "딸기 설기",
    category: "시즌",
    purchaseType: "direct",
    price: 5500,
    unitWeightGrams: 240,
    halfMalWeightGrams: 4100,
    malWeightGrams: 8500,
    imageUrl: "assets/products/menu-honey-seolgi.png",
    description: "봄 시즌 한정 메뉴",
    status: "active",
    displayOrder: 31,
  }).expect(201);
  assert.equal(created.body.product.name, "딸기 설기");
  assert.equal(created.body.product.unitWeightGrams, 240);
  assert.equal(created.body.product.halfMalWeightGrams, 4100);
  assert.equal(created.body.product.malWeightGrams, 8500);
  assert.equal((await request(app).get("/api/products/seasonal-strawberry-seolgi").expect(200)).body.product.price, 5500);

  const updated = await request(app).put("/api/products/admin/seasonal-strawberry-seolgi").set(auth(token)).send({
    name: "딸기 설기 예약",
    category: "시즌",
    purchaseType: "consultation",
    price: 9999,
    imageUrl: "assets/products/menu-honey-seolgi.png",
    description: "예약 상담 메뉴",
    status: "inactive",
    displayOrder: 32,
  }).expect(200);
  assert.equal(updated.body.product.purchaseType, "consultation");
  assert.equal(updated.body.product.price, null);
  await request(app).get("/api/products/seasonal-strawberry-seolgi").expect(404);
});

test("신규 메뉴의 상품 ID는 입력하지 않아도 서버에서 자동 생성한다", async () => {
  const token = await getAdminToken();
  const created = await request(app).post("/api/products/admin").set(auth(token)).send({
    name: "자동 ID 메뉴",
    category: "테스트",
    purchaseType: "direct",
    price: 5000,
    imageUrl: "assets/products/menu-honey-seolgi.png",
    description: "자동 생성 검증",
    status: "inactive",
    displayOrder: 98,
  }).expect(201);
  assert.match(created.body.product.id, /^menu-[a-f0-9]{8}$/);
  await request(app).delete(`/api/products/admin/${created.body.product.id}`).set(auth(token)).expect(200);
});

test("관리자 상품 입력은 ID, 가격, 이미지와 노출 순서를 검증한다", async () => {
  const token = await getAdminToken();
  const base = { name: "검증 상품", category: "테스트", purchaseType: "direct", price: 1000,
    imageUrl: "assets/products/menu-honey-seolgi.png", status: "active", displayOrder: 40 };
  await request(app).post("/api/products/admin").set(auth(token)).send({ ...base, id: "잘못된 ID" }).expect(400);
  await request(app).post("/api/products/admin").set(auth(token)).send({ ...base, id: "bad-price", price: 0 }).expect(400);
  await request(app).post("/api/products/admin").set(auth(token)).send({ ...base, id: "bad-image", imageUrl: "javascript:alert(1)" }).expect(400);
  await request(app).post("/api/products/admin").set(auth(token)).send({ ...base, id: "bad-order", displayOrder: 10000 }).expect(400);
});

test("사용 이력이 없는 관리자 추가 메뉴만 영구 삭제할 수 있다", async () => {
  const token = await getAdminToken();
  const id = "unused-admin-product";
  await request(app).post("/api/products/admin").set(auth(token)).send({
    id, name: "잘못 등록한 메뉴", category: "테스트", purchaseType: "direct", price: 1000,
    imageUrl: "assets/products/menu-honey-seolgi.png", description: "삭제 테스트", status: "inactive", displayOrder: 99,
  }).expect(201);
  await request(app).delete(`/api/products/admin/${id}`).set(auth(token)).expect(200);
  assert.equal(db.prepare("SELECT 1 FROM products WHERE id=?").get(id), undefined);
  assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE action='product_deleted' AND entity_id=?").get(id));
});

test("기본 메뉴는 재시딩으로 되살아나지 않도록 영구 삭제를 차단한다", async () => {
  const token = await getAdminToken();
  const response = await request(app).delete("/api/products/admin/injeolmi").set(auth(token)).expect(409);
  assert.equal(response.body.reason, "PRODUCT_HISTORY_EXISTS");
  assert.ok(db.prepare("SELECT 1 FROM products WHERE id='injeolmi'").get());
});
