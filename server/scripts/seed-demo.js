require("dotenv").config();
if (process.env.NODE_ENV === "production") throw new Error("운영 환경에서는 데모 계정을 생성할 수 없습니다.");

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");

const username = process.env.DEMO_USERNAME || "portfolio_demo";
const email = process.env.DEMO_EMAIL || "demo@tteokjip.local";
const password = process.env.DEMO_PASSWORD || "Demo123!";
const now = new Date().toISOString();
const existing = db.prepare("SELECT id FROM user_accounts WHERE username=? OR email=?").get(username, email);

if (existing) {
  db.prepare("UPDATE user_accounts SET password_hash=?, status='active', updated_at=? WHERE id=?")
    .run(bcrypt.hashSync(password, 10), now, existing.id);
} else {
  db.prepare(`INSERT INTO user_accounts
    (id, username, email, password_hash, name, phone, status, terms_agreed_at, privacy_agreed_at, marketing_consent, created_at, updated_at)
    VALUES (?, ?, ?, ?, '포트폴리오 체험자', '01000000000', 'active', ?, ?, 0, ?, ?)`)
    .run(crypto.randomUUID(), username, email, bcrypt.hashSync(password, 10), now, now, now, now);
}

console.log(`데모 고객 계정 준비 완료: ${username} / ${password}`);
db.close();
