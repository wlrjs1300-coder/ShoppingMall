const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

function portfolioAccounts(env = process.env) {
  return [
    {
      username: env.PORTFOLIO_ADMIN_USERNAME || "portfolio_admin",
      email: env.PORTFOLIO_ADMIN_EMAIL || "admin@tteokjip.local",
      password: env.PORTFOLIO_ADMIN_PASSWORD || "Admin123!",
      name: "포트폴리오 관리자",
      phone: "01000000001",
      role: "admin",
    },
    {
      username: env.PORTFOLIO_USER_USERNAME || "portfolio_user",
      email: env.PORTFOLIO_USER_EMAIL || "user@tteokjip.local",
      password: env.PORTFOLIO_USER_PASSWORD || "User123!",
      name: "포트폴리오 회원",
      phone: "01000000002",
      role: "customer",
    },
  ];
}

function findPortfolioAccount(db, account) {
  const matches = db.prepare(`SELECT id, username, email
    FROM user_accounts WHERE username = ? OR email = ?`).all(account.username, account.email);
  if (!matches.length) return null;
  if (matches.length !== 1 || matches[0].username !== account.username || matches[0].email !== account.email) {
    throw new Error(`${account.username} 포트폴리오 계정 식별 정보가 기존 계정과 충돌합니다.`);
  }
  return matches[0];
}

function runPortfolioSeed({ db, env = process.env, now = new Date().toISOString(), createId = crypto.randomUUID } = {}) {
  if (!db) throw new Error("포트폴리오 계정 저장소가 필요합니다.");
  const accounts = portfolioAccounts(env);
  const passwordHashes = new Map(accounts.map((account) => [account.username, bcrypt.hashSync(account.password, 10)]));

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const account of accounts) {
      const existing = findPortfolioAccount(db, account);
      const passwordHash = passwordHashes.get(account.username);
      if (existing) {
        const updated = db.prepare(`UPDATE user_accounts
          SET password_hash=?, name=?, phone=?, role=?, status='active', updated_at=?
          WHERE id=? AND username=? AND email=?`)
          .run(passwordHash, account.name, account.phone, account.role, now,
            existing.id, account.username, account.email);
        if (updated.changes !== 1) throw new Error(`${account.username} 포트폴리오 계정을 갱신하지 못했습니다.`);
      } else {
        db.prepare(`INSERT INTO user_accounts
          (id, username, email, password_hash, name, phone, role, status,
           terms_agreed_at, privacy_agreed_at, marketing_consent, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?)`)
          .run(createId(), account.username, account.email, passwordHash, account.name,
            account.phone, account.role, now, now, now, now);
      }
    }

    const adminAccount = findPortfolioAccount(db, accounts[0]);
    db.prepare(`INSERT INTO admin_accounts
      (user_id, role, is_active, token_version, created_at, updated_at)
      VALUES (?, 'super_admin', 1, 0, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token_version=admin_accounts.token_version + CASE
          WHEN admin_accounts.role <> 'super_admin' OR admin_accounts.is_active <> 1 THEN 1 ELSE 0 END,
        role='super_admin', is_active=1,
        updated_at=CASE
          WHEN admin_accounts.role <> 'super_admin' OR admin_accounts.is_active <> 1
          THEN excluded.updated_at ELSE admin_accounts.updated_at END`)
      .run(adminAccount.id, now, now);

    for (const account of accounts) {
      const saved = db.prepare("SELECT username, email, password_hash, role, status FROM user_accounts WHERE username = ?").get(account.username);
      if (!saved || saved.email !== account.email || saved.role !== account.role || saved.status !== "active"
        || !bcrypt.compareSync(account.password, saved.password_hash)) {
        throw new Error(`${account.username} 포트폴리오 계정 검증에 실패했습니다.`);
      }
    }
    const savedAdmin = db.prepare("SELECT role, is_active, token_version FROM admin_accounts WHERE user_id = ?").get(adminAccount.id);
    if (!savedAdmin || savedAdmin.role !== "super_admin" || savedAdmin.is_active !== 1
      || !Number.isInteger(savedAdmin.token_version) || savedAdmin.token_version < 0) {
      throw new Error("portfolio_admin 관리자 계정 검증에 실패했습니다.");
    }

    db.exec("COMMIT");
    return { customer: accounts[1].username, admin: accounts[0].username, adminRole: savedAdmin.role };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function main() {
  require("dotenv").config();
  const { assertNonProductionScript } = require("./production-guard");
  assertNonProductionScript("포트폴리오 계정 생성");
  if (process.env.ALLOW_PORTFOLIO_SEED !== "true") {
    throw new Error("시연 계정을 만들려면 ALLOW_PORTFOLIO_SEED=true를 명시해 주세요.");
  }

  const db = require("../db");
  try {
    const result = runPortfolioSeed({ db });
    console.log(`Portfolio customer ready: ${result.customer}`);
    console.log(`Portfolio admin ready: ${result.admin} (${result.adminRole})`);
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { portfolioAccounts, runPortfolioSeed };
