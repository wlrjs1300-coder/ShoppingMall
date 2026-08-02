const https = require("https");

const mockPayments = new Map();
const REQUEST_TIMEOUT_MS = 8_000;

function request(method, path, body, idempotencyKey) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(`${process.env.TOSS_SECRET_KEY || ""}:`).toString("base64");
    const payload = body ? JSON.stringify(body) : "";
    const headers = { Authorization: `Basic ${encoded}`, "Content-Type": "application/json" };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const req = https.request({ hostname: "api.tosspayments.com", path, method, headers }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: response.statusCode, data: raw }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const error = new Error("Toss API request timed out");
      error.code = "ETIMEDOUT";
      req.destroy(error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function confirmPayment({ paymentKey, orderId, amount, idempotencyKey }) {
  if (process.env.TOSS_MOCK_MODE === "true") {
    if (paymentKey.startsWith("fail-")) return { status: 400, data: { code: "TEST_FAILURE", message: "테스트 결제 실패" } };
    const data = { paymentKey, orderId, totalAmount: amount, status: "DONE", secret: `secret-${orderId}` };
    mockPayments.set(paymentKey, data);
    return { status: 200, data };
  }
  return request("POST", "/v1/payments/confirm", { paymentKey, orderId, amount }, idempotencyKey);
}

async function getPayment(paymentKey) {
  if (process.env.TOSS_MOCK_MODE === "true") {
    const data = mockPayments.get(paymentKey);
    return data ? { status: 200, data } : { status: 404, data: { code: "NOT_FOUND" } };
  }
  return request("GET", `/v1/payments/${encodeURIComponent(paymentKey)}`);
}

async function cancelPayment({ paymentKey, cancelReason, cancelAmount, idempotencyKey }) {
  if (process.env.TOSS_MOCK_MODE === "true") {
    const current = mockPayments.get(paymentKey);
    if (!current) return { status: 404, data: { code: "NOT_FOUND" } };
    const invalidAmount = () => ({
      status: 400,
      data: { code: "INVALID_CANCEL_AMOUNT", message: "취소 금액이 올바르지 않습니다." },
    });
    const totalAmount = Number(current.totalAmount);
    const previousCancels = Array.isArray(current.cancels) ? current.cancels : [];
    const previousAmounts = previousCancels.map((item) => Number(item?.cancelAmount));
    if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0
      || previousAmounts.some((amount) => !Number.isSafeInteger(amount) || amount <= 0)) {
      return invalidAmount();
    }
    const alreadyCanceled = previousAmounts.reduce((sum, amount) => sum + amount, 0);
    if (!Number.isSafeInteger(alreadyCanceled) || alreadyCanceled > totalAmount) return invalidAmount();
    const remaining = totalAmount - alreadyCanceled;
    const requested = cancelAmount === undefined ? remaining : Number(cancelAmount);
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > remaining) return invalidAmount();
    const canceledAmount = alreadyCanceled + requested;
    const data = {
      ...current,
      status: canceledAmount === totalAmount ? "CANCELED" : "PARTIAL_CANCELED",
      balanceAmount: totalAmount - canceledAmount,
      cancels: [...previousCancels, { cancelReason, cancelAmount: requested }],
    };
    mockPayments.set(paymentKey, data);
    return { status: 200, data };
  }
  return request("POST", `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason, ...(cancelAmount ? { cancelAmount } : {}) }, idempotencyKey);
}

module.exports = { confirmPayment, getPayment, cancelPayment, mockPayments };
