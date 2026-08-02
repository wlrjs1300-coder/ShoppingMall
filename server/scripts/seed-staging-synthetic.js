const bcrypt = require("bcryptjs");
const { buildOrderPiiColumns } = require("../services/order-pii-service");
const { parsePiiKeyring } = require("../lib/pii-keyring");

const FIXTURE_PREFIX = "staging-synthetic-";
const ACCOUNTS = Object.freeze([
  { id: `${FIXTURE_PREFIX}admin-super`, username: "staging_super_admin", email: "super-admin@staging.example.test", name: "Staging Super Admin", phone: "01000001001", role: "admin", adminRole: "super_admin", passwordKey: "STAGING_SUPER_ADMIN_PASSWORD" },
  { id: `${FIXTURE_PREFIX}admin-operations`, username: "staging_operations", email: "operations@staging.example.test", name: "Staging Operations", phone: "01000001002", role: "admin", adminRole: "operations", passwordKey: "STAGING_OPERATIONS_PASSWORD" },
  { id: `${FIXTURE_PREFIX}admin-finance`, username: "staging_finance", email: "finance@staging.example.test", name: "Staging Finance", phone: "01000001003", role: "admin", adminRole: "finance", passwordKey: "STAGING_FINANCE_PASSWORD" },
  { id: `${FIXTURE_PREFIX}admin-viewer`, username: "staging_viewer", email: "viewer@staging.example.test", name: "Staging Viewer", phone: "01000001004", role: "admin", adminRole: "viewer", passwordKey: "STAGING_VIEWER_PASSWORD" },
  { id: `${FIXTURE_PREFIX}customer`, username: "staging_customer", email: "customer@staging.example.test", name: "Staging Customer", phone: "01000001005", role: "customer", passwordKey: "STAGING_CUSTOMER_PASSWORD" },
]);
const ORDER_IDS = Object.freeze({
  legacy: `${FIXTURE_PREFIX}order-legacy`,
  encrypted: `${FIXTURE_PREFIX}order-encrypted`,
  update: `${FIXTURE_PREFIX}order-pii-update`,
});

function requiredPasswords(env) {
  const values = new Map();
  for (const account of ACCOUNTS) {
    const password = typeof env[account.passwordKey] === "string" ? env[account.passwordKey] : "";
    const bytes = Buffer.byteLength(password);
    if (password.length < 8 || bytes > 72) throw new Error(`staging 계정 비밀번호 설정이 올바르지 않습니다: ${account.passwordKey}`);
    values.set(account.id, password);
  }
  return values;
}

function assertOwnedAccount(db, account) {
  const matches = db.prepare("SELECT id,username,email FROM user_accounts WHERE id=? OR username=? OR email=?")
    .all(account.id, account.username, account.email);
  if (!matches.length) return null;
  if (matches.length !== 1 || matches[0].id !== account.id
    || matches[0].username !== account.username || matches[0].email !== account.email) {
    throw new Error("staging synthetic 계정 식별자가 기존 데이터와 충돌합니다.");
  }
  return matches[0];
}

function assertOwnedOrder(db, orderId) {
  const row = db.prepare("SELECT id,memo FROM orders WHERE id=?").get(orderId);
  if (row && row.memo !== FIXTURE_PREFIX) throw new Error("staging synthetic 주문 식별자가 기존 데이터와 충돌합니다.");
  return row;
}

function insertOrder(db, { id, userId, product, encrypted, keyring, now }) {
  const pii = {
    customerName: encrypted ? "Encrypted Synthetic Customer" : "Legacy Synthetic Customer",
    customerPhone: encrypted ? "01000002002" : "01000002001",
    deliveryAddress: null,
    guestAddress: null,
  };
  const protectedColumns = encrypted ? buildOrderPiiColumns(pii, keyring, now) : null;
  db.prepare(`INSERT INTO orders
    (id,user_id,customer_name,customer_phone,fulfillment_type,subtotal,total_amount,cost,status,
     payment_status,amount_status,workflow_status,production_status,memo,created_at,updated_at,
     pii_ciphertext,pii_iv,pii_auth_tag,pii_key_version,customer_name_masked,customer_phone_masked,
     delivery_region_masked,pii_migrated_at)
    VALUES (?,?,?,?, 'pickup',?,?,0,'접수대기','결제대기','confirmed','결제대기','생산 대기',?,?,?, ?,?,?,?,?,?,?,?)`)
    .run(id, userId, encrypted ? "[protected]" : pii.customerName,
      encrypted ? "[protected]" : pii.customerPhone, product.price, product.price,
      FIXTURE_PREFIX, now, now,
      protectedColumns?.piiCiphertext || null, protectedColumns?.piiIv || null,
      protectedColumns?.piiAuthTag || null, protectedColumns?.piiKeyVersion || null,
      protectedColumns?.customerNameMasked || null, protectedColumns?.customerPhoneMasked || null,
      null, protectedColumns?.piiMigratedAt || null);
  db.prepare(`INSERT INTO order_items
    (id,order_id,product_id,product_name,unit_price,quantity,line_total,quantity_unit)
    VALUES (?,?,?,?,?,1,?,'pack')`)
    .run(`${id}-item`, id, product.id, product.name, product.price, product.price);
}

function runStagingSyntheticSeed({ db, env = process.env, now = new Date().toISOString(), bcryptRounds = 10 } = {}) {
  if (!db) throw new Error("staging synthetic 저장소가 필요합니다.");
  const passwords = requiredPasswords(env);
  const keyring = parsePiiKeyring(env.ORDER_PII_KEYS_JSON, env.ORDER_PII_ACTIVE_KEY_VERSION);
  const product = db.prepare("SELECT id,name,price FROM products WHERE status='active' AND price IS NOT NULL ORDER BY display_order LIMIT 1").get();
  if (!product) throw new Error("staging synthetic 주문에 사용할 canonical 상품이 없습니다.");
  const hashes = new Map(ACCOUNTS.map((account) => [account.id, bcrypt.hashSync(passwords.get(account.id), bcryptRounds)]));
  const summary = { created: 0, reused: 0, repaired: 0, conflicts: 0, accounts: ACCOUNTS.length, orders: 3, payments: 1 };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const account of ACCOUNTS) {
      const existing = assertOwnedAccount(db, account);
      if (existing) {
        const result = db.prepare(`UPDATE user_accounts SET password_hash=?,name=?,phone=?,role=?,status='active',updated_at=?
          WHERE id=? AND username=? AND email=?`).run(hashes.get(account.id), account.name, account.phone,
          account.role, now, account.id, account.username, account.email);
        if (result.changes !== 1) throw new Error("staging synthetic 계정을 복원하지 못했습니다.");
        summary.repaired += 1;
      } else {
        db.prepare(`INSERT INTO user_accounts
          (id,username,email,password_hash,name,phone,role,status,terms_agreed_at,privacy_agreed_at,marketing_consent,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'active',?,?,0,?,?)`)
          .run(account.id, account.username, account.email, hashes.get(account.id), account.name,
            account.phone, account.role, now, now, now, now);
        summary.created += 1;
      }
      if (account.adminRole) {
        db.prepare(`INSERT INTO admin_accounts (user_id,role,is_active,token_version,created_at,updated_at)
          VALUES (?,?,1,0,?,?) ON CONFLICT(user_id) DO UPDATE SET
          token_version=admin_accounts.token_version + CASE WHEN admin_accounts.role<>excluded.role OR admin_accounts.is_active<>1 THEN 1 ELSE 0 END,
          role=excluded.role,is_active=1,updated_at=excluded.updated_at`)
          .run(account.id, account.adminRole, now, now);
      }
    }

    for (const orderId of Object.values(ORDER_IDS)) assertOwnedOrder(db, orderId);
    for (const [kind, orderId] of Object.entries(ORDER_IDS)) {
      if (db.prepare("SELECT 1 FROM orders WHERE id=?").get(orderId)) {
        summary.reused += 1;
        continue;
      }
      insertOrder(db, {
        id: orderId, userId: ACCOUNTS.at(-1).id, product,
        encrypted: kind !== "legacy", keyring, now,
      });
      summary.created += 1;
    }

    const payment = db.prepare("SELECT id,order_id FROM payments WHERE id=? OR order_id=?")
      .all(`${FIXTURE_PREFIX}payment-legacy`, ORDER_IDS.legacy);
    if (payment.length) {
      if (payment.length !== 1 || payment[0].id !== `${FIXTURE_PREFIX}payment-legacy`
        || payment[0].order_id !== ORDER_IDS.legacy) throw new Error("staging synthetic 결제 식별자가 기존 데이터와 충돌합니다.");
      summary.reused += 1;
    } else {
      db.prepare(`INSERT INTO payments
        (id,order_id,amount,order_name,customer_name,customer_phone,status,requested_at)
        VALUES (?,?,?,?,?,?,'PENDING',?)`)
        .run(`${FIXTURE_PREFIX}payment-legacy`, ORDER_IDS.legacy, product.price,
          "Synthetic staging order", "Legacy Payment Synthetic", "01000003001", now);
      summary.created += 1;
    }
    db.exec("COMMIT");
    return { ...summary, schemaVersion: db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function main() {
  require("dotenv").config();
  const { assertStagingSeedAllowed } = require("./production-guard");
  assertStagingSeedAllowed("staging synthetic seed");
  const db = require("../db");
  try {
    const result = runStagingSyntheticSeed({ db });
    console.log(`Staging synthetic seed ready: created=${result.created} reused=${result.reused} repaired=${result.repaired} conflicts=${result.conflicts} accounts=${result.accounts} orders=${result.orders} payments=${result.payments} schemaVersion=${result.schemaVersion}`);
  } finally {
    db.close();
  }
}

if (require.main === module) main();
module.exports = { ACCOUNTS, FIXTURE_PREFIX, ORDER_IDS, requiredPasswords, runStagingSyntheticSeed };
