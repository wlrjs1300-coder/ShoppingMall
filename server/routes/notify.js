const express = require("express");
const { sendSms, notifyPickupReminders } = require("../services/notify");
const { requireAuth } = require("../middleware/auth");
const db = require("../db");

const router = express.Router();

// GET /api/notify/config — 알림 설정 현황 조회
router.get("/config", requireAuth, (req, res) => {
  const mode = (process.env.NOTIFICATION_MODE || "none").toLowerCase();
  res.json({
    mode,
    active: mode !== "none",
    smsReady: !!(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && process.env.SOLAPI_SENDER_PHONE),
    kakaoReady: !!(process.env.KAKAO_PLUS_FRIEND_ID && process.env.KAKAO_TEMPLATE_ORDER),
    templates: {
      order: process.env.KAKAO_TEMPLATE_ORDER || null,
      ready: process.env.KAKAO_TEMPLATE_READY || null,
      remind: process.env.KAKAO_TEMPLATE_REMIND || null,
    },
  });
});

// POST /api/notify/test — 테스트 SMS 발송 (관리자 본인 번호 확인용)
router.post("/test", requireAuth, async (req, res) => {
  const { phone, message = `[따뜻한 떡집] 알림 테스트 메시지입니다.` } = req.body;
  if (!phone) return res.status(400).json({ error: "수신 번호(phone)가 필요합니다." });
  const result = await sendSms(phone, message).catch((e) => ({ ok: false, reason: e.message }));
  res.json(result);
});

// POST /api/notify/reminders — D-1 픽업 리마인더 즉시 실행
router.post("/reminders", requireAuth, async (req, res) => {
  const sent = await notifyPickupReminders(db).catch((e) => {
    console.error("[알림] 리마인더 오류:", e);
    return -1;
  });
  res.json({ ok: sent >= 0, sent });
});

module.exports = router;
