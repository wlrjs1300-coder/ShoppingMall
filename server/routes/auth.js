const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const router = express.Router();
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { error: "로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

router.post("/login", adminLoginLimiter, (req, res) => {
  const { code } = req.body;
  const supplied = Buffer.from(String(code || ""));
  const expected = Buffer.from(String(process.env.ADMIN_CODE || ""));
  const matches = supplied.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(supplied, expected);
  if (!matches) {
    return res.status(401).json({ error: "확인 코드가 올바르지 않습니다." });
  }
  const token = jwt.sign({ sub: "admin:root", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "24h" });
  res.json({ token });
});

module.exports = router;
