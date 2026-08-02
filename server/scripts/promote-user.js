const db = require("../db");

const identifier = String(process.argv[2] || "").trim().toLowerCase();
if (!identifier) {
  console.error("사용법: npm run user:promote -- <아이디 또는 이메일>");
  process.exitCode = 1;
} else {
  const user = db.prepare("SELECT id, username, email, role FROM user_accounts WHERE username = ? OR email = ?").get(identifier, identifier);
  if (!user) {
    console.error("해당 회원을 찾지 못했습니다.");
    process.exitCode = 1;
  } else {
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE user_accounts SET role = 'admin', updated_at = ? WHERE id = ?").run(now, user.id);
      db.prepare(`INSERT INTO admin_accounts (user_id, role, is_active, token_version, created_at, updated_at)
        VALUES (?, 'super_admin', 1, 0, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET role='super_admin', is_active=1,
          token_version=admin_accounts.token_version+1, updated_at=excluded.updated_at`)
        .run(user.id, now, now);
      db.exec("COMMIT");
      console.log(`${user.username || user.email} 계정을 활성 최고 관리자로 준비했습니다.`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
