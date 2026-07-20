const https = require("https");

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.PASSWORD_RESET_FROM);
}

function sendPasswordResetEmail(to, resetUrl) {
  return new Promise((resolve) => {
    if (!isEmailConfigured()) return resolve({ ok: false, reason: "이메일 서비스 미설정" });
    const body = JSON.stringify({
      from: process.env.PASSWORD_RESET_FROM,
      to: [to],
      subject: "[따뜻한 떡집] 비밀번호 재설정 안내",
      html: `<p>아래 버튼을 눌러 비밀번호를 재설정해 주세요.</p><p><a href="${resetUrl}">비밀번호 재설정</a></p><p>이 링크는 15분 후 만료됩니다.</p>`,
    });
    const request = https.request({
      hostname: "api.resend.com", path: "/emails", method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, reason: raw }));
    });
    request.on("error", (error) => resolve({ ok: false, reason: error.message }));
    request.write(body); request.end();
  });
}

module.exports = { isEmailConfigured, sendPasswordResetEmail };
