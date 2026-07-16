const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const dbPath = process.env.DB_PATH || path.join(__dirname, "tteokjip.db");
const db = new DatabaseSync(dbPath);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer TEXT,
    phone TEXT,
    product TEXT,
    price_text TEXT,
    quantity INTEGER DEFAULT 1,
    unit_price REAL DEFAULT 0,
    revenue REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    pickup_date TEXT,
    pickup_time TEXT,
    fulfillment_type TEXT DEFAULT 'pickup',
    logistics_status TEXT,
    delivery_address TEXT,
    status TEXT DEFAULT '접수대기',
    memo TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
    paid_at TEXT
  );

  -- 쇼핑몰 회원 계정 (관리자 CRM용 customers 테이블과는 완전히 별개)
  CREATE TABLE IF NOT EXISTS user_accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
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

// orders: 회원 주문 연결용 nullable FK (기존 주문은 전부 NULL로 남아 비회원 주문으로 유지됨)
ensureColumn("orders", "user_id", "user_id TEXT REFERENCES user_accounts(id)");

// orders.user_id도 FK라 "내 주문 목록" 조회 시 필터링에 쓰일 컬럼 — 인덱스 추가
db.exec("CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)");

module.exports = db;
