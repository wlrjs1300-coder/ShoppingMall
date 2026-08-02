process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "portfolio-seed-test-secret-at-least-32-bytes";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../index");
const db = require("../db");
const { runPortfolioSeed } = require("../scripts/seed-portfolio-users");

const scriptPath = path.join(__dirname, "../scripts/seed-portfolio-users.js");
const portfolioUsernames = ["portfolio_admin", "portfolio_user"];

function clearPortfolioAccounts() {
  db.prepare("DELETE FROM user_accounts WHERE username IN (?, ?)").run(...portfolioUsernames);
}

function createExistingAdmin() {
  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync("ExistingAdminPassword1!", 4);
  db.prepare(`INSERT INTO user_accounts
    (id,username,email,password_hash,name,phone,role,status,
     terms_agreed_at,privacy_agreed_at,marketing_consent,created_at,updated_at)
    VALUES ('existing-admin','existing_admin','existing@admin.test',?,'기존 관리자','01099999999',
      'admin','active',?,?,0,?,?)`)
    .run(passwordHash, now, now, now, now);
  db.prepare(`INSERT INTO admin_accounts
    (user_id,role,is_active,token_version,created_at,updated_at)
    VALUES ('existing-admin','finance',1,7,?,?)`)
    .run(now, now);
}

function clearExistingAdmin() {
  db.prepare("DELETE FROM user_accounts WHERE id='existing-admin'").run();
}

test.beforeEach(() => {
  clearPortfolioAccounts();
  clearExistingAdmin();
});

test.after(() => db.close());

test("portfolio seed creates customer and active super administrator with hashed passwords", () => {
  runPortfolioSeed({ db });

  const users = db.prepare(`SELECT id,username,email,password_hash,role,status
    FROM user_accounts WHERE username IN (?, ?) ORDER BY username`).all(...portfolioUsernames);
  assert.equal(users.length, 2);
  const adminUser = users.find((user) => user.username === "portfolio_admin");
  const customer = users.find((user) => user.username === "portfolio_user");
  assert.equal(adminUser.role, "admin");
  assert.equal(customer.role, "customer");
  assert.equal(adminUser.status, "active");
  assert.equal(customer.status, "active");
  assert.notEqual(adminUser.password_hash, "Admin123!");
  assert.notEqual(customer.password_hash, "User123!");
  assert.equal(bcrypt.compareSync("Admin123!", adminUser.password_hash), true);
  assert.equal(bcrypt.compareSync("User123!", customer.password_hash), true);

  const admin = db.prepare("SELECT role,is_active,token_version FROM admin_accounts WHERE user_id=?").get(adminUser.id);
  assert.deepEqual({ ...admin }, { role: "super_admin", is_active: 1, token_version: 0 });
});

test("portfolio seed rerun creates no duplicates and safely restores only its administrator", () => {
  runPortfolioSeed({ db });
  const firstUsers = db.prepare(`SELECT id,username FROM user_accounts
    WHERE username IN (?, ?) ORDER BY username`).all(...portfolioUsernames);
  const adminId = firstUsers.find((user) => user.username === "portfolio_admin").id;
  const createdAt = db.prepare("SELECT created_at FROM admin_accounts WHERE user_id=?").get(adminId).created_at;
  db.prepare("UPDATE admin_accounts SET role='viewer', is_active=0, token_version=5 WHERE user_id=?").run(adminId);

  runPortfolioSeed({ db });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_accounts WHERE username IN (?, ?)").get(...portfolioUsernames).count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admin_accounts WHERE user_id=?").get(adminId).count, 1);
  assert.deepEqual(db.prepare(`SELECT id,username FROM user_accounts
    WHERE username IN (?, ?) ORDER BY username`).all(...portfolioUsernames), firstUsers);
  const restoredAdmin = db.prepare("SELECT role,is_active,token_version,created_at,updated_at FROM admin_accounts WHERE user_id=?").get(adminId);
  assert.equal(restoredAdmin.role, "super_admin");
  assert.equal(restoredAdmin.is_active, 1);
  assert.equal(restoredAdmin.token_version, 6);
  assert.equal(restoredAdmin.created_at, createdAt);

  runPortfolioSeed({ db });
  assert.deepEqual(
    db.prepare("SELECT role,is_active,token_version,created_at,updated_at FROM admin_accounts WHERE user_id=?").get(adminId),
    restoredAdmin,
  );
});

test("seeded portfolio administrator can exchange a customer login for a super_admin session", async () => {
  runPortfolioSeed({ db });
  const agent = request.agent(app);
  await agent.post("/api/users/login")
    .send({ identifier: "portfolio_admin", password: "Admin123!" }).expect(200);
  const response = await agent.post("/api/users/admin-session").expect(200);
  assert.equal(response.body.admin.role, "super_admin");
  for (const permission of ["orders:read", "orders:write", "orders:pii:read", "orders:pii:write", "admin_users:manage"]) {
    assert.ok(response.body.admin.permissions.includes(permission), permission);
  }
  assert.equal(typeof response.body.token, "string");
  assert.equal("tokenVersion" in response.body.admin, false);
});

test("portfolio seed preserves every unrelated administrator field", () => {
  createExistingAdmin();
  const userBefore = db.prepare("SELECT password_hash,role,status,updated_at FROM user_accounts WHERE id='existing-admin'").get();
  const adminBefore = db.prepare("SELECT role,is_active,token_version,created_at,updated_at FROM admin_accounts WHERE user_id='existing-admin'").get();

  runPortfolioSeed({ db });

  assert.deepEqual(db.prepare("SELECT password_hash,role,status,updated_at FROM user_accounts WHERE id='existing-admin'").get(), userBefore);
  assert.deepEqual(db.prepare("SELECT role,is_active,token_version,created_at,updated_at FROM admin_accounts WHERE user_id='existing-admin'").get(), adminBefore);
});

test("portfolio seed rejects an unexpected username or email collision without overwriting it", () => {
  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync("UnrelatedPassword1!", 4);
  db.prepare(`INSERT INTO user_accounts
    (id,username,email,password_hash,name,phone,role,status,
     terms_agreed_at,privacy_agreed_at,marketing_consent,created_at,updated_at)
    VALUES ('collision','portfolio_admin','unexpected@example.test',?,'충돌 계정','01088888888',
      'customer','active',?,?,0,?,?)`)
    .run(passwordHash, now, now, now, now);

  assert.throws(() => runPortfolioSeed({ db }), /포트폴리오 계정 식별 정보가 기존 계정과 충돌/);
  const collision = db.prepare("SELECT email,password_hash,role FROM user_accounts WHERE id='collision'").get();
  assert.deepEqual({ ...collision }, { email: "unexpected@example.test", password_hash: passwordHash, role: "customer" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_accounts WHERE username='portfolio_user'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admin_accounts WHERE user_id='collision'").get().count, 0);
});

test("portfolio seed rolls back both users when administrator insertion fails", () => {
  createExistingAdmin();
  db.exec(`CREATE TEMP TRIGGER fail_portfolio_admin_insert BEFORE INSERT ON admin_accounts
    WHEN NEW.user_id <> 'existing-admin' BEGIN SELECT RAISE(ABORT, 'injected admin failure'); END`);
  try {
    assert.throws(() => runPortfolioSeed({ db }), /injected admin failure/);
  } finally {
    db.exec("DROP TRIGGER fail_portfolio_admin_insert");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_accounts WHERE username IN (?, ?)").get(...portfolioUsernames).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admin_accounts WHERE user_id='existing-admin'").get().count, 1);
});

test("portfolio seed CLI requires opt-in and rejects production before opening a database", () => {
  for (const [label, environment, expected] of [
    ["missing opt-in", { NODE_ENV: "development" }, /ALLOW_PORTFOLIO_SEED=true/],
    ["production", { NODE_ENV: "production", ALLOW_PORTFOLIO_SEED: "true" }, /운영 환경에서는/],
  ]) {
    const missingDbPath = path.join(os.tmpdir(), `portfolio-seed-guard-${label}-${Date.now()}`, "should-not-exist.sqlite");
    const result = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, ...environment, DB_PATH: missingDbPath },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, label);
    assert.match(`${result.stdout}${result.stderr}`, expected, label);
    assert.equal(fs.existsSync(missingDbPath), false, label);
  }
});
