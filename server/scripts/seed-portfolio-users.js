require("dotenv").config();
if (process.env.NODE_ENV === "production") throw new Error("운영 환경에서는 시연 계정을 생성할 수 없습니다.");
if (process.env.ALLOW_PORTFOLIO_SEED !== "true") {
  throw new Error("시연 계정을 만들려면 ALLOW_PORTFOLIO_SEED=true를 명시해 주세요.");
}

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");

const accounts = [
  {
    username: process.env.PORTFOLIO_ADMIN_USERNAME || "portfolio_admin",
    email: process.env.PORTFOLIO_ADMIN_EMAIL || "admin@tteokjip.local",
    password: process.env.PORTFOLIO_ADMIN_PASSWORD || "Admin123!",
    name: "포트폴리오 관리자",
    phone: "01000000001",
    role: "admin",
  },
  {
    username: process.env.PORTFOLIO_USER_USERNAME || "portfolio_user",
    email: process.env.PORTFOLIO_USER_EMAIL || "user@tteokjip.local",
    password: process.env.PORTFOLIO_USER_PASSWORD || "User123!",
    name: "포트폴리오 회원",
    phone: "01000000002",
    role: "customer",
  },
];

const now = new Date().toISOString();
for (const account of accounts) {
  const existing = db.prepare("SELECT id FROM user_accounts WHERE username = ? OR email = ?").get(account.username, account.email);
  const passwordHash = bcrypt.hashSync(account.password, 10);
  if (existing) {
    db.prepare(`UPDATE user_accounts
      SET username=?, email=?, password_hash=?, name=?, phone=?, role=?, status='active', updated_at=?
      WHERE id=?`)
      .run(account.username, account.email, passwordHash, account.name, account.phone, account.role, now, existing.id);
  } else {
    db.prepare(`INSERT INTO user_accounts
      (id, username, email, password_hash, name, phone, role, status, terms_agreed_at, privacy_agreed_at, marketing_consent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?)`)
      .run(crypto.randomUUID(), account.username, account.email, passwordHash, account.name, account.phone, account.role, now, now, now, now);
  }
}

for (const account of accounts) {
  const saved = db.prepare("SELECT username, password_hash, role, status FROM user_accounts WHERE username = ?").get(account.username);
  if (!saved || saved.role !== account.role || saved.status !== "active" || !bcrypt.compareSync(account.password, saved.password_hash)) {
    throw new Error(`${account.username} 계정 검증에 실패했습니다.`);
  }
}

console.log("포트폴리오 관리자와 일반 사용자 계정을 준비했습니다.");
db.close();
