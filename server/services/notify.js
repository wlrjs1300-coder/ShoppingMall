const https = require("https");
const crypto = require("crypto");

const notifiedReminders = new Set(); // 서버 재시작 전까지 중복 발송 방지

function buildAuth() {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const sig = crypto
    .createHmac("sha256", process.env.SOLAPI_API_SECRET || "")
    .update(date + salt)
    .digest("hex");
  return `HMAC-SHA256 apiKey=${process.env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${sig}`;
}

function normalizePhone(p) {
  return p ? p.replace(/[-\s]/g, "") : null;
}

function solapiRequest(message) {
  return new Promise((resolve) => {
    const apiKey = process.env.SOLAPI_API_KEY;
    const apiSecret = process.env.SOLAPI_API_SECRET;
    if (!apiKey || !apiSecret) return resolve({ ok: false, reason: "Solapi API 키 미설정" });

    const body = JSON.stringify({ message });
    const opts = {
      hostname: "api.solapi.com",
      path: "/messages/v4/send",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: buildAuth(),
      },
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode < 300, data: JSON.parse(data) });
        } catch {
          resolve({ ok: false, reason: data });
        }
      });
    });

    req.on("error", (e) => resolve({ ok: false, reason: e.message }));
    req.write(body);
    req.end();
  });
}

async function sendSms(to, text) {
  const phone = normalizePhone(to);
  const sender = normalizePhone(process.env.SOLAPI_SENDER_PHONE);
  if (!phone) return { ok: false, reason: "수신 번호 없음" };
  if (!sender) return { ok: false, reason: "발신 번호 미설정 (SOLAPI_SENDER_PHONE)" };
  return solapiRequest({ to: phone, from: sender, text, type: "SMS" });
}

async function sendKakao(to, templateId, variables) {
  const phone = normalizePhone(to);
  const sender = normalizePhone(process.env.SOLAPI_SENDER_PHONE);
  const pfId = process.env.KAKAO_PLUS_FRIEND_ID;
  if (!phone || !sender || !pfId || !templateId) {
    return { ok: false, reason: "카카오 설정 미완료 (KAKAO_PLUS_FRIEND_ID, KAKAO_TEMPLATE_*)" };
  }
  return solapiRequest({
    to: phone,
    from: sender,
    kakaoOptions: { pfId, templateId, variables },
  });
}

// 모드에 따라 카카오 알림톡 또는 SMS 발송
async function notify(to, text, kakaoTemplateId, variables) {
  const mode = (process.env.NOTIFICATION_MODE || "none").toLowerCase();
  if (mode === "none") return { ok: false, reason: "알림 비활성화 (NOTIFICATION_MODE=none)" };
  if (mode === "kakao" && kakaoTemplateId) return sendKakao(to, kakaoTemplateId, variables);
  return sendSms(to, text);
}

const storeName = () => process.env.STORE_NAME || "따뜻한 떡집";
const storePhone = () => process.env.STORE_PHONE || "";

// 주문 접수 알림
async function notifyOrderReceived(order) {
  if (!order.phone) return null;
  const contactSuffix = storePhone() ? ` 문의: ${storePhone()}` : "";
  const text = `[${storeName()}] ${order.customer || "고객"}님의 ${order.product || "주문"} ${order.quantity || 1}개가 접수되었습니다. 픽업일: ${order.pickupDate || "별도 안내"}${contactSuffix}`;
  return notify(order.phone, text, process.env.KAKAO_TEMPLATE_ORDER, {
    customer: order.customer || "고객",
    product: order.product || "주문",
    quantity: String(order.quantity || 1),
    pickupDate: order.pickupDate || "별도 안내",
  }).catch(() => null);
}

// 준비 완료 알림
async function notifyOrderReady(order) {
  if (!order.phone) return null;
  const label = order.fulfillmentType === "delivery" ? "배송" : "픽업";
  const text = `[${storeName()}] ${order.customer || "고객"}님, ${order.product || "주문"}이 준비 완료되었습니다. ${label} 준비가 완료되었으니 확인 부탁드립니다.`;
  return notify(order.phone, text, process.env.KAKAO_TEMPLATE_READY, {
    customer: order.customer || "고객",
    product: order.product || "주문",
    label,
  }).catch(() => null);
}

// D-1 픽업 리마인더 (매일 오전 9시 실행)
async function notifyPickupReminders(db) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT o.*, COALESCE(SUM(oi.quantity), 0) AS total_quantity,
        GROUP_CONCAT(oi.product_name, ', ') AS product_names
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.pickup_date = ? AND o.status NOT IN ('픽업완료', '배송완료', '취소')
       GROUP BY o.id`
    )
    .all(tomorrowStr);

  let sent = 0;
  for (const row of rows) {
    const dedupKey = `remind-${row.id}-${todayStr}`;
    if (notifiedReminders.has(dedupKey) || !row.customer_phone) continue;

    const text = `[${storeName()}] ${row.customer_name || "고객"}님, 내일(${tomorrowStr}) ${row.product_names || "주문"} ${row.total_quantity || 1}개 픽업이 예정되어 있습니다.`;
    const result = await notify(row.customer_phone, text, process.env.KAKAO_TEMPLATE_REMIND, {
      customer: row.customer_name || "고객",
      product: row.product_names || "주문",
      quantity: String(row.total_quantity || 1),
      pickupDate: tomorrowStr,
    }).catch(() => null);

    if (result?.ok) {
      notifiedReminders.add(dedupKey);
      sent++;
    }
  }

  if (sent > 0 || rows.length > 0) {
    console.log(`[알림] D-1 리마인더: 대상 ${rows.length}건, 발송 ${sent}건 (${tomorrowStr} 픽업)`);
  }
  return sent;
}

module.exports = { sendSms, notify, notifyOrderReceived, notifyOrderReady, notifyPickupReminders };
