const crypto = require("node:crypto");

function securityHeaders(req, res, next) {
  const isPostcodePage = req.path === "/mypage.html";
  res.setHeader("X-Content-Type-Options", "nosniff");
  // 클릭재킹 방어는 아래 CSP의 frame-ancestors 'none'으로 일원화합니다.
  // X-Frame-Options: DENY는 카카오 우편번호 서비스의 about:blank 중첩 프레임과 충돌합니다.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
  if (req.path === "/postcode.html") return next();
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.tosspayments.com https://t1.daumcdn.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://*.tosspayments.com https://*.daum.net https://postcode.map.kakao.com",
    "frame-src https://*.tosspayments.com https://postcode.map.kakao.com https://*.daum.net https://*.kakao.com",
    "child-src https://postcode.map.kakao.com https://*.daum.net https://*.kakao.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.tosspayments.com",
    isPostcodePage ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
  ].join("; "));
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

function requestContext(req, res, next) {
  req.id = req.get("x-request-id") || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  const startedAt = Date.now();
  res.on("finish", () => {
    if (res.statusCode < 500 && process.env.NODE_ENV !== "production") return;
    console.error(JSON.stringify({ level: "error", requestId: req.id, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt }));
  });
  next();
}

module.exports = { requestContext, securityHeaders };
