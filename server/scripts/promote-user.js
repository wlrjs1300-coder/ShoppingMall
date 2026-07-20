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
  } else if (user.role === "admin") {
    console.log(`${user.username || user.email} 계정은 이미 관리자입니다.`);
  } else {
    db.prepare("UPDATE user_accounts SET role = 'admin', updated_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);
    console.log(`${user.username || user.email} 계정에 관리자 권한을 부여했습니다.`);
  }
}
