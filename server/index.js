require("dotenv").config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "tteokjip-secret-change-in-production") {
  console.warn("⚠️  [보안] JWT_SECRET이 기본값입니다. 배포 전 반드시 강한 값으로 교체하세요 (server/.env)");
}

const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");
const { notifyPickupReminders } = require("./services/notify");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/inventory", require("./routes/inventory"));
app.use("/api/recipes", require("./routes/recipes"));
app.use("/api/purchase-orders", require("./routes/purchase-orders"));
app.use("/api/suppliers", require("./routes/suppliers"));
app.use("/api/activity-logs", require("./routes/activity-logs"));
app.use("/api/notify", require("./routes/notify"));
app.use("/api/payments", require("./routes/payments"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "존재하지 않는 API 엔드포인트입니다." });
  }
  res.redirect("/");
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "서버 오류가 발생했습니다." });
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

const server = app.listen(PORT, () => {
  console.log(`따뜻한 떡집 서버 실행 중 → http://localhost:${PORT}`);
  if ((process.env.NOTIFICATION_MODE || "none") !== "none") {
    schedulePickupReminders();
  }
});

process.on("SIGTERM", () => {
  console.log("[서버] 종료 신호 수신. 정상 종료 중…");
  server.close(() => process.exit(0));
});
