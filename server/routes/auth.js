const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

router.post("/login", (req, res) => {
  const { code } = req.body;
  if (!code || code !== process.env.ADMIN_CODE) {
    return res.status(401).json({ error: "확인 코드가 올바르지 않습니다." });
  }
  const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: "24h" });
  res.json({ token });
});

module.exports = router;
