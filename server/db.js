const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(path.join(__dirname, "tteokjip.db"));

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
`);

// 기존 DB 스키마 마이그레이션
const migrate = (sql) => { try { db.exec(sql); } catch {} };

// inventory_logs: 구 컬럼(ingredient/amount/unit/action) → 신 컬럼
migrate("ALTER TABLE inventory_logs ADD COLUMN quantity INTEGER");
migrate("ALTER TABLE inventory_logs ADD COLUMN order_count INTEGER");
migrate("ALTER TABLE inventory_logs ADD COLUMN materials TEXT");

// suppliers: items 컬럼 추가
migrate("ALTER TABLE suppliers ADD COLUMN items TEXT");

module.exports = db;
