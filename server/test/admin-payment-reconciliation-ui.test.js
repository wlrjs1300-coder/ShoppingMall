const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const orders = fs.readFileSync(path.join(root, "js", "admin", "orders.js"), "utf8");
const events = fs.readFileSync(path.join(root, "js", "admin", "events.js"), "utf8");

test("관리자 결제 재조정 UI는 RECONCILE_REQUIRED에만 버튼을 표시한다", () => {
  assert.match(orders, /status === "RECONCILE_REQUIRED"/);
  assert.match(orders, /결제 확인 필요/);
  assert.match(orders, /needsReconciliation \? `[^`]*admin-payment-reconcile-button/);
  for (const status of ["DONE", "CANCELED", "PARTIAL_CANCELED", "CANCELING", "CONFIRMING", "PENDING", "FAILED"]) {
    assert.doesNotMatch(orders, new RegExp(`status === "${status}".*admin-payment-reconcile-button`));
  }
});

test("재조정은 공통 확인·인증 API를 사용하고 주문별 중복 요청을 차단한다", () => {
  assert.match(orders, /AppUI\.confirm\(/);
  assert.match(orders, /confirmText: "결제 상태 확인"/);
  assert.match(orders, /adminPaymentReconciliations\.has\(orderId\)/);
  assert.match(orders, /adminPaymentReconciliations\.add\(orderId\)/);
  assert.match(orders, /apiFetchResult\(`\/payments\/\$\{encodeURIComponent\(orderId\)\}\/reconcile`, \{ method: "POST" \}\)/);
  assert.doesNotMatch(orders, /Authorization|Bearer/);
  assert.match(events, /reconcileAdminPayment\(orderId, actionButton\)/);
});

test("재조정은 로딩 접근성, 안전한 오류 매핑, 서버 재조회를 제공한다", () => {
  assert.match(orders, /setAttribute\("aria-busy", "true"\)/);
  assert.match(orders, /textContent = "확인 중\.\.\."/);
  assert.match(orders, /await loadFromApi\(\)/);
  assert.match(orders, /adminPaymentStates\.clear\(\)/);
  assert.match(orders, /renderAdminDashboard\(\)/);
  for (const reason of [
    "PAYMENT_NOT_FOUND", "PAYMENT_KEY_MISSING", "PAYMENT_KEY_CONFLICT", "ORDER_ID_MISMATCH",
    "AMOUNT_MISMATCH", "PROVIDER_TIMEOUT", "PROVIDER_NETWORK_ERROR", "PROVIDER_UNAVAILABLE",
    "INVALID_LOCAL_STATUS",
  ]) assert.match(orders, new RegExp(`${reason}:`));
  assert.match(orders, /결제 상태를 확인하지 못했습니다\./);
  assert.doesNotMatch(orders, /paymentKey.*textContent|idempotency.*textContent|lastError.*innerHTML/);
});

test("성공·멱등·취소·부분환불 결과를 구분한다", () => {
  assert.match(orders, /이미 최신 결제 상태로 반영되어 있습니다\./);
  assert.match(orders, /결제 상태가 정상적으로 확인되었습니다\./);
  assert.match(orders, /결제 취소 상태가 확인되었습니다\./);
  assert.match(orders, /부분환불 상태가 확인되었습니다\./);
});

test("주문별 결제 조회 실패를 안전한 최소 상태로 격리한다", () => {
  const hydration = orders.slice(
    orders.indexOf("function hydrateAdminPaymentStates"),
    orders.indexOf("function getAdminReconciliationSuccessMessage")
  );
  assert.match(hydration, /\.catch\(\(\) => \{/);
  assert.match(hydration, /status: "UNAVAILABLE", lastError: null/);
  assert.match(hydration, /\.finally\(\(\) => \{/);
  assert.match(hydration, /adminPaymentStateLoads\.delete\(order\.id\)/);
  assert.doesNotMatch(hydration, /catch\(\s*(?:error|err)\s*\)/);
  assert.match(orders, /adminPaymentStates\.get\(order\.id\)\?\.status === "RECONCILE_REQUIRED"/);
});

test("재조정 예외는 성공 여부에 따라 안내를 구분하고 항상 UI 잠금을 해제한다", () => {
  const reconciliation = orders.slice(
    orders.indexOf("async function reconcileAdminPayment"),
    orders.indexOf("function updateAdminBulkBar")
  );
  assert.match(reconciliation, /let reconciliationSucceeded = false/);
  assert.match(reconciliation, /reconciliationSucceeded = true/);
  assert.match(reconciliation, /if \(!refreshedOrder \|\| !refreshedPayment\) throw/);
  assert.match(reconciliation, /\} catch \{/);
  assert.match(reconciliation, /결제 상태를 확인하지 못했습니다\./);
  assert.match(reconciliation, /결제 상태 확인은 완료됐지만 최신 화면을 불러오지 못했습니다\. 페이지를 새로고침해 주세요\./);
  assert.match(reconciliation, /\} finally \{/);
  assert.match(reconciliation, /adminPaymentReconciliations\.delete\(orderId\)/);
  assert.match(reconciliation, /triggerButton\.disabled = false/);
  assert.match(reconciliation, /removeAttribute\("aria-busy"\)/);
  assert.doesNotMatch(reconciliation, /catch\(\s*(?:error|err)\s*\)|console\.(?:log|error)/);
});
