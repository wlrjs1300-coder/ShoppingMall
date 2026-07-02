require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");
const { notifyPickupReminders } = require("./services/notify");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// 배포 환경에서 프론트엔드 정적 파일 서빙 (API와 같은 origin 유지)
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "서버 오류가 발생했습니다." });
});

// D-1 픽업 리마인더: 매일 오전 9시 실행
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

app.listen(PORT, () => {
  console.log(`따뜻한 떡집 서버 실행 중 → http://localhost:${PORT}`);
  if ((process.env.NOTIFICATION_MODE || "none") !== "none") {
    schedulePickupReminders();
  }
});
