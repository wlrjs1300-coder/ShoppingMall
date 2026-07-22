const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { assertProductionConfig } = require("./config");
if (require.main === module) assertProductionConfig();
const db = require("./db");
const { notifyPickupReminders } = require("./services/notify");
const { requestContext, securityHeaders } = require("./middleware/security");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

app.use(requestContext);
app.use(securityHeaders);
app.use(cors({
  origin(origin, callback) {
    if (!origin || process.env.NODE_ENV !== "production") return callback(null, true);
    const allowed = String(process.env.ALLOWED_ORIGIN || "").split(",").map((value) => value.trim()).filter(Boolean);
    return callback(null, allowed.includes(origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: "6mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, ".."), {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  setHeaders(res, filePath) {
    if (/\.html$|sw\.js$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    } else if (ext === ".css") {
      res.setHeader("Content-Type", "text/css; charset=utf-8");
    } else if (ext === ".js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    }
  },
}));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/auth/social", require("./routes/social-auth"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/users", require("./routes/users"));
app.use("/api/users/password-reset", require("./routes/password-reset"));
app.use("/api/products", require("./routes/products"));
app.use("/api/inquiries", require("./routes/inquiries"));
app.use("/api/phone", require("./routes/phone"));
app.use("/api/inventory", require("./routes/inventory"));
app.use("/api/recipes", require("./routes/recipes"));
app.use("/api/purchase-orders", require("./routes/purchase-orders"));
app.use("/api/suppliers", require("./routes/suppliers"));
app.use("/api/activity-logs", require("./routes/activity-logs"));
app.use("/api/notify", require("./routes/notify"));
app.use("/api/payments", require("./routes/payments"));

app.get("/api/site-config", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    name: process.env.STORE_NAME || "따뜻한 떡집",
    phone: process.env.STORE_PHONE || "031-000-0000",
    hours: process.env.STORE_HOURS || "09:00 - 19:00",
    address: process.env.STORE_ADDRESS || "경기도 화성시 소재",
    parking: process.env.STORE_PARKING || "건물 내 주차 공간 이용 가능",
    storeUrl: process.env.STORE_URL || "https://smartstore.naver.com/",
  });
});

app.get("/api/health", (req, res) => {
  try {
    db.prepare("SELECT 1 AS ok").get();
    const migration = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, database: "ready", schemaVersion: migration.version, uptimeSeconds: Math.floor(process.uptime()) });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "존재하지 않는 API 엔드포인트입니다." });
  }
  res.status(404).sendFile(path.join(__dirname, "..", "404.html"));
});

app.use((err, req, res, next) => {
  console.error(JSON.stringify({ level: "error", requestId: req.id, message: err.message, stack: process.env.NODE_ENV === "production" ? undefined : err.stack }));
  res.status(500).json({ error: "서버 오류가 발생했습니다.", requestId: req.id });
});

function schedulePickupReminders() {
  function msUntil9am() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }
  function runAndReschedule() {
    notifyPickupReminders(db).catch(console.error);
    setTimeout(runAndReschedule, msUntil9am());
  }
  const ms = msUntil9am();
  setTimeout(runAndReschedule, ms);
  console.log(`[알림] D-1 리마인더 스케줄러 등록 (${Math.round((ms / 3600000) * 10) / 10}시간 후 첫 실행)`);
}

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`따뜻한 떡집 서버 실행 중 → http://localhost:${PORT}`);
    if ((process.env.NOTIFICATION_MODE || "none") !== "none") {
      schedulePickupReminders();
    }
  });

  process.on("SIGTERM", () => {
    console.log("[서버] 종료 신호 수신. 정상 종료 중…");
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

module.exports = app;
