const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const dbPath = process.env.DB_PATH || path.join(__dirname, "tteokjip.db");
const db = new DatabaseSync(dbPath);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    fulfillment_type TEXT NOT NULL DEFAULT 'pickup',
    delivery_address TEXT,
    pickup_date TEXT,
    pickup_time TEXT,
    subtotal INTEGER NOT NULL DEFAULT 0,
    delivery_fee INTEGER NOT NULL DEFAULT 0,
    total_amount INTEGER NOT NULL DEFAULT 0,
    cost INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '접수대기',
    payment_status TEXT NOT NULL DEFAULT '결제대기',
    amount_status TEXT NOT NULL DEFAULT 'confirmed',
    logistics_status TEXT,
    memo TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT,
    product_name TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    quantity_unit TEXT NOT NULL DEFAULT 'pack',
    line_total INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    type TEXT DEFAULT '일반',
    memo TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS customer_notes (
    customer_key TEXT PRIMARY KEY,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    stock REAL DEFAULT 0,
    unit TEXT NOT NULL,
    safe_stock REAL DEFAULT 0,
    memo TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inventory_logs (
    id TEXT PRIMARY KEY,
    product TEXT,
    quantity INTEGER,
    order_count INTEGER,
    materials TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recipes (
    product TEXT NOT NULL,
    ingredient TEXT NOT NULL,
    amount REAL NOT NULL,
    unit TEXT NOT NULL,
    PRIMARY KEY (product, ingredient)
  );

  CREATE TABLE IF NOT EXISTS production_completions (
    order_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    completed_at TEXT NOT NULL,
    PRIMARY KEY (order_id, product_name),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    inventory_id TEXT,
    name TEXT NOT NULL,
    amount REAL DEFAULT 0,
    unit TEXT,
    supplier TEXT,
    unit_cost REAL DEFAULT 0,
    status TEXT DEFAULT '발주요청',
    received_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    contact TEXT,
    memo TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    category TEXT,
    message TEXT,
    tab TEXT DEFAULT 'orders',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL,
    order_name TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    payment_key TEXT,
    status TEXT DEFAULT 'PENDING',
    requested_at TEXT NOT NULL,
    paid_at TEXT,
    canceled_at TEXT,
    link_token_hash TEXT,
    link_token_expires_at TEXT,
    link_token_used_at TEXT,
    session_token_hash TEXT,
    session_token_expires_at TEXT,
    confirm_idempotency_key TEXT,
    cancel_idempotency_key TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    toss_secret TEXT
  );

  -- 쇼핑몰 회원 계정 (관리자 CRM용 customers 테이블과는 완전히 별개)
  CREATE TABLE IF NOT EXISTS user_accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer'
      CHECK (role IN ('customer', 'admin')),
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'withdrawn')),
    terms_agreed_at TEXT NOT NULL,
    privacy_agreed_at TEXT NOT NULL,
    marketing_consent INTEGER NOT NULL DEFAULT 0
      CHECK (marketing_consent IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_addresses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    address_name TEXT,
    recipient_name TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    postal_code TEXT,
    address TEXT NOT NULL,
    address_detail TEXT,
    is_default INTEGER NOT NULL DEFAULT 0
      CHECK (is_default IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id)
      REFERENCES user_accounts(id)
      ON DELETE CASCADE
  );

  -- user_addresses.user_id는 FK라 조회 시 자주 필터링됨 (내 배송지 목록)
  CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id ON user_addresses(user_id);

  -- 상품 카탈로그 (1단계: 읽기 전용 조회만. 장바구니/주문 연동은 다음 단계)
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,

    purchase_type TEXT NOT NULL
      CHECK (purchase_type IN ('direct', 'consultation')),

    price INTEGER
      CHECK (price IS NULL OR price >= 0),

    image_url TEXT NOT NULL,
    description TEXT,

    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'inactive')),

    display_order INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    CHECK (
      (purchase_type = 'direct' AND price IS NOT NULL)
      OR
      (purchase_type = 'consultation' AND price IS NULL)
    )
  );

  -- 목록 조회가 항상 status='active' + display_order 정렬이라 복합 인덱스로 커버
  CREATE INDEX IF NOT EXISTS idx_products_status_display ON products(status, display_order);

  CREATE TABLE IF NOT EXISTS product_inquiries (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    desired_date TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '접수',
    created_at TEXT NOT NULL,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
  CREATE INDEX IF NOT EXISTS idx_product_inquiries_created_at ON product_inquiries(created_at DESC);

  -- 휴대폰 인증번호 (회원가입 필수 단계). 번호당 여러 행이 쌓일 수 있어 항상
  -- "가장 최근에 인증됐고 아직 소비되지 않은 행"을 조회해서 사용한다.
  CREATE TABLE IF NOT EXISTS phone_verifications (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_phone_verifications_phone ON phone_verifications(phone);
`);

// 기존 DB 스키마 마이그레이션
const migrate = (sql) => { try { db.exec(sql); } catch {} };

// inventory_logs: 구 컬럼(ingredient/amount/unit/action) → 신 컬럼
migrate("ALTER TABLE inventory_logs ADD COLUMN quantity INTEGER");
migrate("ALTER TABLE inventory_logs ADD COLUMN order_count INTEGER");
migrate("ALTER TABLE inventory_logs ADD COLUMN materials TEXT");

// suppliers: items 컬럼 추가
migrate("ALTER TABLE suppliers ADD COLUMN items TEXT");

// 컬럼이 이미 있는 "정상적인 재실행"과 진짜 스키마 오류(오타, 잘못된 REFERENCES 등)를
// 구분하기 위해 PRAGMA table_info로 존재 여부를 먼저 확인한 뒤에만 ALTER를 실행한다.
// (위 migrate()처럼 에러를 통째로 삼키면 진짜 오류도 조용히 묻힐 수 있어 신규 컬럼엔 이 방식을 쓴다)
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

// 6단계 결제 보안 컬럼. 토큰 원문은 저장하지 않고 SHA-256 해시만 보관한다.
ensureColumn("payments", "canceled_at", "canceled_at TEXT");
ensureColumn("payments", "link_token_hash", "link_token_hash TEXT");
ensureColumn("payments", "link_token_expires_at", "link_token_expires_at TEXT");
ensureColumn("payments", "link_token_used_at", "link_token_used_at TEXT");
ensureColumn("payments", "session_token_hash", "session_token_hash TEXT");
ensureColumn("payments", "session_token_expires_at", "session_token_expires_at TEXT");
ensureColumn("payments", "confirm_idempotency_key", "confirm_idempotency_key TEXT");
ensureColumn("payments", "cancel_idempotency_key", "cancel_idempotency_key TEXT");
ensureColumn("payments", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("payments", "last_error", "last_error TEXT");
ensureColumn("payments", "toss_secret", "toss_secret TEXT");
ensureColumn("phone_verifications", "code_hash", "code_hash TEXT");
ensureColumn("user_accounts", "login_failed_count", "login_failed_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("user_accounts", "login_locked_until", "login_locked_until TEXT");
ensureColumn("user_accounts", "role", "role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin'))");
ensureColumn("orders", "guest_password_hash", "guest_password_hash TEXT");
ensureColumn("orders", "guest_address", "guest_address TEXT");
ensureColumn("order_items", "quantity_unit", "quantity_unit TEXT NOT NULL DEFAULT 'pack'");

// 과거 버전에서 평문으로 저장한 인증번호도 서버 시작 즉시 해시로 전환한다.
// 이후 code 컬럼에는 원문 대신 고정 표식만 남긴다.
const crypto = require("crypto");
const authPepper = process.env.AUTH_CODE_PEPPER || process.env.JWT_SECRET || "local-development-pepper";
const legacyPhoneCodes = db.prepare("SELECT id, phone, code FROM phone_verifications WHERE code <> 'hashed'").all();
const updateLegacyPhoneCode = db.prepare("UPDATE phone_verifications SET code='hashed', code_hash=? WHERE id=?");
for (const row of legacyPhoneCodes) {
  const digest = crypto.createHmac("sha256", authPepper).update(`${row.phone}:${row.code}`).digest("hex");
  updateLegacyPhoneCode.run(digest, row.id);
}

function migrateOrdersToOrderItems() {
  const columns = db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
  if (columns.includes("customer_name")) return;

  const legacyRows = db.prepare("SELECT * FROM orders ORDER BY created_at ASC, id ASC").all();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec("DROP TABLE IF EXISTS order_items");
    db.exec("DROP TABLE IF EXISTS order_idempotency");
    db.exec("ALTER TABLE orders RENAME TO orders_legacy");
    db.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        fulfillment_type TEXT NOT NULL DEFAULT 'pickup',
        delivery_address TEXT,
        pickup_date TEXT,
        pickup_time TEXT,
        subtotal INTEGER NOT NULL DEFAULT 0,
        delivery_fee INTEGER NOT NULL DEFAULT 0,
        total_amount INTEGER NOT NULL DEFAULT 0,
        cost INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '접수대기',
        payment_status TEXT NOT NULL DEFAULT '결제대기',
        amount_status TEXT NOT NULL DEFAULT 'confirmed',
        logistics_status TEXT,
        memo TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES user_accounts(id)
      );
      CREATE TABLE order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        product_id TEXT,
        product_name TEXT NOT NULL,
        unit_price INTEGER NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        quantity_unit TEXT NOT NULL DEFAULT 'pack',
        line_total INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id)
      );
    `);

    const grouped = new Map();
    for (const row of legacyRows) {
      const groupId = row.checkout_id || row.id;
      if (!grouped.has(groupId)) grouped.set(groupId, []);
      grouped.get(groupId).push(row);
    }
    const insertHeader = db.prepare(`
      INSERT INTO orders
        (id, user_id, customer_name, customer_phone, fulfillment_type, delivery_address, pickup_date, pickup_time,
         subtotal, delivery_fee, total_amount, cost, status, logistics_status, memo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, quantity_unit, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [orderId, rows] of grouped) {
      const first = rows[0];
      const items = rows.map((row) => {
        const quantity = Math.max(1, Number(row.quantity || 1));
        const unitPrice = Math.max(0, Number(row.unit_price || 0));
        return { row, quantity, unitPrice, lineTotal: unitPrice * quantity };
      });
      const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const cost = rows.reduce((sum, row) => sum + Math.max(0, Number(row.cost || 0)), 0);
      insertHeader.run(
        orderId, first.user_id || null, first.customer || "고객", first.phone || "",
        first.fulfillment_type || "pickup", first.delivery_address || null, first.pickup_date || null,
        first.pickup_time || null, subtotal, subtotal, cost, first.status || "접수대기",
        first.logistics_status || null, first.memo || null, first.created_at, first.updated_at,
      );
      items.forEach((item, index) => insertItem.run(
        `item-${orderId}-${index + 1}`, orderId, item.row.product_id || null,
        item.row.product || "상품", item.unitPrice, item.quantity, item.quantity === Math.floor(item.quantity) ? "pack" : "mal", item.lineTotal,
      ));
    }
    db.exec("DROP TABLE orders_legacy");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

migrateOrdersToOrderItems();

// 기존 회원은 username이 NULL인 채로 유지하고 신규 회원부터 아이디를 필수로 받는다.
ensureColumn("user_accounts", "username", "username TEXT");
ensureColumn("user_accounts", "profile_completed", "profile_completed INTEGER NOT NULL DEFAULT 1");
ensureColumn("product_inquiries", "admin_reply", "admin_reply TEXT");
ensureColumn("product_inquiries", "admin_memo", "admin_memo TEXT");
ensureColumn("product_inquiries", "responded_at", "responded_at TEXT");
ensureColumn("product_inquiries", "updated_at", "updated_at TEXT");
ensureColumn("product_inquiries", "user_id", "user_id TEXT");
ensureColumn("product_inquiries", "customer_read_at", "customer_read_at TEXT");
ensureColumn("product_inquiries", "photos_json", "photos_json TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_product_inquiries_user_id ON product_inquiries(user_id, created_at DESC)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_username ON user_accounts(username)");

db.exec(`
  CREATE TABLE IF NOT EXISTS social_identities (
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, provider_user_id),
    FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_social_identities_user_id ON social_identities(user_id);

  CREATE TABLE IF NOT EXISTS social_link_attempts (
    token_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    email TEXT,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (provider, provider_user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_social_link_attempts_expires_at ON social_link_attempts(expires_at);

  CREATE TABLE IF NOT EXISTS social_signup_attempts (
    token_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(provider, provider_user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_social_signup_attempts_expires_at ON social_signup_attempts(expires_at);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
`);

// orders.user_id도 FK라 "내 주문 목록" 조회 시 필터링에 쓰일 컬럼 — 인덱스 추가
db.exec("CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id)");

db.exec(`
  CREATE TABLE IF NOT EXISTS order_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    order_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS checkout_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    checkout_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_status_history (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    previous_status TEXT,
    next_status TEXT NOT NULL,
    changed_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id, created_at);
`);

// 상품 초기 시드: server/data/products.js에 없는 id만 매 시작 시 채워 넣는다.
// INSERT OR REPLACE를 쓰지 않는 이유 — 이미 존재하는 행(관리자가 나중에 가격/상태를 바꿨을 수 있는 행)을
// 서버 재시작마다 시드값으로 덮어써 버리면 운영 중 수정 사항이 사라진다. OR IGNORE는 PK 충돌 시
// 아무것도 하지 않으므로, 이미 있는 상품은 그대로 두고 없는 id만 안전하게 추가된다.
function seedProducts() {
  const seedList = require("./data/products");
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO products
      (id, name, category, purchase_type, price, image_url, description, status, display_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  for (const product of seedList) {
    insert.run(
      product.id, product.name, product.category, product.purchaseType,
      product.price, product.imageUrl, product.description, product.displayOrder,
      now, now,
    );
  }
}
seedProducts();

function seedDefaultRecipes() {
  if (db.prepare("SELECT COUNT(*) AS count FROM recipes").get().count > 0) return;
  const defaults = [
    [["송편", "꿀떡", "쑥절편", "흰절편", "가래떡"], [["멥쌀가루", 0.08, "kg"]]],
    [["백일", "수수팥"], [["멥쌀가루", 0.08, "kg"], ["팥앙금", 0.04, "kg"]]],
    [["답례", "단체"], [["멥쌀가루", 0.06, "kg"], ["개별 포장지", 1, "장"]]],
    [["찰떡", "인절미"], [["찹쌀가루", 0.08, "kg"]]],
    [["모듬", "선물"], [["멥쌀가루", 0.05, "kg"], ["찹쌀가루", 0.05, "kg"], ["개별 포장지", 1, "장"]]],
  ];
  const insert = db.prepare("INSERT INTO recipes (product, ingredient, amount, unit) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const [keywords, materials] of defaults) {
      for (const keyword of keywords) for (const [ingredient, amount, unit] of materials) insert.run(keyword, ingredient, amount, unit);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
seedDefaultRecipes();

// 이후 스키마 변경은 migrations.js에 버전을 올려 추가한다.
require("./migrations").runMigrations(db);
// 구형 orders 테이블 재구성 이후에도 비회원 주문 인증 컬럼을 보장한다.
ensureColumn("orders", "guest_password_hash", "guest_password_hash TEXT");
ensureColumn("orders", "guest_address", "guest_address TEXT");
ensureColumn("orders", "payment_status", "payment_status TEXT NOT NULL DEFAULT '결제대기'");
ensureColumn("orders", "amount_status", "amount_status TEXT NOT NULL DEFAULT 'confirmed'");
ensureColumn("orders", "workflow_status", "workflow_status TEXT NOT NULL DEFAULT '결제대기'");
ensureColumn("orders", "production_status", "production_status TEXT NOT NULL DEFAULT '생산 대기'");
ensureColumn("orders", "production_assignee", "production_assignee TEXT");
ensureColumn("orders", "packaging_type", "packaging_type TEXT NOT NULL DEFAULT '기본 포장'");

module.exports = db;
