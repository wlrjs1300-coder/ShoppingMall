const ADMIN_ORDER_PII_TIMEOUT_MS = 3 * 60 * 1000;
let activeAdminOrderPii = null;
let activeAdminOrderPiiTimer = null;
let activeAdminOrderPiiUpdateTimer = null;

function clearActiveAdminOrderPii({ rerender = false } = {}) {
  const orderId = activeAdminOrderPii?.orderId || null;
  activeAdminOrderPii = null;
  if (activeAdminOrderPiiTimer) clearTimeout(activeAdminOrderPiiTimer);
  activeAdminOrderPiiTimer = null;
  if (activeAdminOrderPiiUpdateTimer) clearTimeout(activeAdminOrderPiiUpdateTimer);
  activeAdminOrderPiiUpdateTimer = null;
  document.querySelector("[data-admin-order-pii-update-form]")?.reset();
  if (rerender && orderId && document.querySelector("[data-admin-order-detail-dialog]")?.open) {
    openAdminOrderDetail(orderId);
  }
}

function setActiveAdminOrderPii(pii) {
  clearActiveAdminOrderPii();
  activeAdminOrderPii = {
    orderId: pii.orderId,
    customer: pii.customer,
    phone: pii.phone,
    deliveryAddress: pii.deliveryAddress,
  };
  activeAdminOrderPiiTimer = setTimeout(
    () => clearActiveAdminOrderPii({ rerender: true }),
    ADMIN_ORDER_PII_TIMEOUT_MS,
  );
}

function getAdminOrderStatusClass(status = "") {
  if (status.includes("취소")) return "is-cancelled";
  if (status.includes("완료")) return "is-complete";
  if (status.includes("배송")) return "is-delivery";
  if (status.includes("준비")) return "is-preparing";
  return "is-waiting";
}

function getUnifiedWorkflowStatus(order) {
  if (["결제취소", "환불완료"].includes(order.paymentStatus) || ["취소", "주문취소"].includes(order.status)) return "취소";
  if (order.workflowStatus === "결제완료") return "접수대기";
  if (order.workflowStatus === "완료") return order.fulfillmentType === "delivery" ? "배송완료" : "픽업완료";
  return order.workflowStatus || (order.paymentStatus === "결제완료" ? "접수대기" : "결제대기");
}

function getAdminOrderStatusLabel(status = "접수대기") {
  return status;
}

const selectedAdminOrderIds = new Set();
const adminPaymentReconciliations = new Set();

const ADMIN_PAYMENT_ERROR_MESSAGES = {
  PAYMENT_NOT_FOUND: "결제 정보를 찾을 수 없습니다.",
  PAYMENT_KEY_MISSING: "결제 식별 정보가 없어 자동 확인할 수 없습니다.",
  PAYMENT_KEY_CONFLICT: "결제 식별 정보 충돌이 확인되었습니다.",
  ORDER_ID_MISMATCH: "결제사의 주문번호가 자체 주문과 일치하지 않습니다.",
  AMOUNT_MISMATCH: "결제사의 결제금액이 자체 주문금액과 일치하지 않습니다.",
  PROVIDER_TIMEOUT: "결제사 응답 시간이 초과되었습니다. 잠시 후 다시 확인해 주세요.",
  PROVIDER_NETWORK_ERROR: "결제사 연결에 실패했습니다. 잠시 후 다시 확인해 주세요.",
  PROVIDER_UNAVAILABLE: "결제사 서비스를 일시적으로 사용할 수 없습니다.",
  INVALID_LOCAL_STATUS: "현재 결제 상태에서는 재조정할 수 없습니다.",
};

function getAdminPaymentErrorMessage(reason, status = 0) {
  if (ADMIN_PAYMENT_ERROR_MESSAGES[reason]) return ADMIN_PAYMENT_ERROR_MESSAGES[reason];
  if (status === 401) return "관리자 인증이 필요합니다. 다시 로그인해 주세요.";
  if (status === 403) return "결제 상태를 확인할 권한이 없습니다.";
  if (status === 404) return "주문 또는 결제 정보를 찾을 수 없습니다.";
  if (status === 502 || status === 0) return "결제사 연결에 실패했습니다. 잠시 후 다시 확인해 주세요.";
  return "결제 상태를 확인하지 못했습니다.";
}

function getAdminPaymentStatusLabel(order) {
  return order.paymentInternalStatus === "RECONCILE_REQUIRED"
    ? "결제 확인 필요"
    : (order.paymentStatus || "결제대기");
}

function getAdminReconciliationSuccessMessage(result) {
  if (result.alreadyDone) return "이미 최신 결제 상태로 반영되어 있습니다.";
  if (result.paymentStatus === "CANCELED") return "결제 취소 상태가 확인되었습니다.";
  if (result.paymentStatus === "PARTIAL_CANCELED") return "부분환불 상태가 확인되었습니다.";
  return "결제 상태가 정상적으로 확인되었습니다.";
}

async function reconcileAdminPayment(orderId, triggerButton) {
  if (adminPaymentReconciliations.has(orderId)) return;
  const confirmed = await AppUI.confirm(
    "Toss Payments의 실제 결제 상태를 조회하여 자체 주문 상태를 재조정합니다.",
    { title: "결제 상태를 다시 확인하시겠습니까?", confirmText: "결제 상태 확인", cancelText: "취소", tone: "info" }
  );
  if (!confirmed || adminPaymentReconciliations.has(orderId)) return;

  adminPaymentReconciliations.add(orderId);
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.setAttribute("aria-busy", "true");
    triggerButton.textContent = "확인 중...";
  }
  const detailWasOpen = Boolean(document.querySelector("[data-admin-order-detail-dialog]")?.open);
  let reconciliationSucceeded = false;
  try {
    const result = await apiFetchResult(`/payments/${encodeURIComponent(orderId)}/reconcile`, { method: "POST" });
    if (!result.ok) {
      AppUI.alert(getAdminPaymentErrorMessage(result.data?.reason, result.status));
      return;
    }
    reconciliationSucceeded = true;
    AppUI.toast(getAdminReconciliationSuccessMessage(result.data), "success");
    await loadFromApi();
    const refreshedOrder = readOrders().find((order) => order.id === orderId);
    if (!refreshedOrder) throw new Error("ORDER_REFRESH_UNAVAILABLE");
    renderAdminDashboard();
    if (detailWasOpen) openAdminOrderDetail(orderId);
  } catch {
    AppUI.alert(reconciliationSucceeded
      ? "결제 상태 확인은 완료됐지만 최신 화면을 불러오지 못했습니다. 페이지를 새로고침해 주세요."
      : "결제 상태를 확인하지 못했습니다.");
  } finally {
    adminPaymentReconciliations.delete(orderId);
    if (triggerButton?.isConnected) {
      triggerButton.disabled = false;
      triggerButton.removeAttribute("aria-busy");
      triggerButton.textContent = "결제 상태 확인";
    }
  }
}

function updateAdminBulkBar() {
  const bar = document.querySelector(".admin-bulk-bar");
  const count = document.querySelector("[data-admin-selected-count]");
  if (bar) bar.hidden = selectedAdminOrderIds.size === 0;
  if (count) count.textContent = String(selectedAdminOrderIds.size);
}

function getAdminOrderNumber(order) {
  const source = String(order.orderNumber || order.id || "");
  const trailingNumber = source.match(/(\d+)$/)?.[1];
  if (trailingNumber) return `ORD-${trailingNumber.padStart(4, "0")}`;
  return source ? `ORD-${source.slice(-6).toUpperCase()}` : "ORD-0000";
}

function renderAdminOrders() {
  const orderList = document.querySelector(".admin-order-list");
  if (!orderList) return;

  const orders = readOrders();
  const empty = document.querySelector(".admin-empty");
  const totalInfo = document.querySelector("[data-admin-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="orders"]');

  const totalQuantity = orders.reduce((sum, order) => sum + Number(order.quantity || 0), 0);
  const totalRevenue = orders.reduce((sum, order) => sum + Number(order.revenue || 0), 0);
  const totalCost = orders.reduce((sum, order) => sum + Number(order.cost || 0), 0);

  document.querySelectorAll('[data-admin-stat="orders"]').forEach(el => { el.textContent = String(orders.length); });
  document.querySelectorAll('[data-admin-stat="quantity"]').forEach(el => { el.textContent = String(totalQuantity); });
  document.querySelectorAll('[data-admin-stat="revenue"]').forEach(el => { el.textContent = formatWon(totalRevenue); });
  document.querySelectorAll('[data-admin-stat="profit"]').forEach(el => { el.textContent = formatWon(totalRevenue - totalCost); });

  const filteredOrders = getFilteredAdminOrders(orders);

  if (totalInfo) totalInfo.textContent = String(filteredOrders.length);
  if (tabCount) tabCount.textContent = String(orders.length);
  if (empty) {
    const isFiltered = orders.length > 0;
    const title = isFiltered ? "검색 조건에 맞는 주문이 없습니다." : "접수된 주문이 없습니다.";
    const desc = isFiltered
      ? "검색어나 상태 필터를 변경해 보세요."
      : "메뉴 페이지에서 주문 요청이 접수되면 여기에 표시됩니다.";
    empty.innerHTML = `<span class="admin-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg></span><strong class="admin-empty-title">${title}</strong><span class="admin-empty-desc">${desc}</span>`;
    empty.hidden = filteredOrders.length > 0;
  }

  orderList.innerHTML = filteredOrders
    .map((order) => {
      const created = new Date(order.createdAt).toLocaleDateString("ko-KR");
      const pickup = [order.pickupDate, order.pickupTime].filter(Boolean).join(" ");
      const fulfillment = getFulfillmentLabel(order.fulfillmentType);
      const paymentStatus = getAdminPaymentStatusLabel(order);
      const needsReconciliation = order.paymentInternalStatus === "RECONCILE_REQUIRED";
      const amountText = order.amountStatus === "pending" ? "금액 미확정" : formatWon(Number(order.revenue || 0));
      const displayOrderNumber = getAdminOrderNumber(order);
      const statusClass = getAdminOrderStatusClass(order.status || "접수대기");
      return `
        <tr class="admin-order-row" data-order-id="${escapeHtml(order.id)}" data-status="${escapeHtml(order.status || "접수대기")}" tabindex="0" aria-label="${escapeHtml(order.customer || "고객")} 주문 상세 보기">
          <td class="admin-select-column"><label class="admin-order-select"><input type="checkbox" data-admin-order-select value="${escapeHtml(order.id)}" ${selectedAdminOrderIds.has(order.id) ? "checked" : ""} /><span class="sr-only">${escapeHtml(displayOrderNumber)} 선택</span></label></td>
          <td><strong>${escapeHtml(displayOrderNumber)}</strong></td>
          <td><span>${created}</span></td>
          <td><strong>${escapeHtml(order.customer || "-")}</strong></td>
          <td><span>${escapeHtml(order.phone || "-")}</span></td>
          <td><strong>${escapeHtml(order.product || "-")}</strong></td>
          <td><strong>${Number(order.quantity || 1)}개</strong></td>
          <td><strong class="admin-order-amount ${order.amountStatus === "pending" ? "is-pending" : ""}">${amountText}</strong></td>
          <td><strong>${escapeHtml(pickup || "-")}</strong></td>
          <td><span>${fulfillment}</span></td>
          <td><div class="admin-combined-status"><span class="admin-order-status-pill ${statusClass}">${escapeHtml(getUnifiedWorkflowStatus(order))}</span>${needsReconciliation ? `<span class="admin-payment-reconcile-badge">결제 확인 필요</span><button class="admin-payment-reconcile-button" type="button" data-admin-payment-reconcile="${escapeHtml(order.id)}">결제 상태 확인</button>` : `<span class="admin-payment-status-label">${escapeHtml(paymentStatus)}</span>`}</div></td>
          <td><button class="admin-order-detail-open" type="button" aria-label="${escapeHtml(displayOrderNumber)} 상세 보기"><span aria-hidden="true">›</span></button></td>
        </tr>
      `;
    })
    .join("");
  updateAdminBulkBar();
}

function getAdminOrderMargin(order) {
  const revenue = Number(order.revenue || 0);
  const cost = Number(order.cost || 0);
  const profit = revenue - cost;
  return { revenue, cost, profit, rate: revenue > 0 ? Math.round((profit / revenue) * 100) : 0 };
}

function getAllowedAdminOrderStatuses(order) {
  const rawCurrent = String(getUnifiedWorkflowStatus(order) || "").replace(/\s+/g, "");
  const statusAliases = {
    결제완료: "접수대기",
    준비중: "접수완료",
    준비완료: order.fulfillmentType === "delivery" ? "배송중" : "픽업준비완료",
    완료: order.fulfillmentType === "delivery" ? "배송완료" : "픽업완료",
    주문취소: "취소",
  };
  const current = statusAliases[rawCurrent] || rawCurrent || "결제대기";
  if (current === "취소") return [current];
  const sequence = order.fulfillmentType === "delivery"
    ? ["결제대기", "접수대기", "접수완료", "배송중", "배송완료"]
    : ["결제대기", "접수대기", "접수완료", "픽업준비완료", "픽업완료"];
  const currentIndex = sequence.indexOf(current);
  // 오래된 주문에 알 수 없는 상태값이 남아 있어도 관리자가 정상 단계로
  // 복구하거나 취소할 수 있도록 전체 선택지를 노출합니다.
  if (currentIndex < 0) return [...sequence, "취소"];
  return [...sequence.slice(currentIndex), ...(currentIndex < sequence.length - 1 ? ["취소"] : [])];
}

function buildOrderFulfillmentJourney(order) {
  const isDelivery = order.fulfillmentType === "delivery";
  const status = getUnifiedWorkflowStatus(order);
  const deliverySteps = [
    ["상품 준비중", "주문 상품을 정성껏 준비하고 있어요."],
    ["배송 준비 완료", "포장과 출고 확인을 마쳤어요."],
    ["배송중", "고객님께 안전하게 이동하고 있어요."],
    ["배송완료", "상품 전달이 완료되었어요."],
  ];
  const pickupSteps = [
    ["상품 준비중", "주문 상품을 정성껏 준비하고 있어요."],
    ["픽업 준비 완료", "포장과 상품 확인을 마쳤어요."],
    ["방문 수령 대기", "예약 시간에 맞춰 보관하고 있어요."],
    ["수령 완료", "매장에서 상품을 전달했어요."],
  ];
  const icons = [
    `<svg viewBox="0 0 64 54" aria-hidden="true"><path class="fill" d="M16 19h32v26H16z"/><path d="M16 19h32v26H16zM22 19c0-7 4-11 10-11s10 4 10 11M24 29h16M32 25v14"/><path class="accent" d="M27 10c2-4 8-4 10 0"/></svg>`,
    `<svg viewBox="0 0 64 54" aria-hidden="true"><path class="fill" d="m12 23 20-10 20 10v22H12z"/><path d="m12 23 20-10 20 10-20 11-20-11Zm0 0v22h40V23M32 34v11M22 18l20 11"/><path class="accent" d="M27 13h10v15l-5 3-5-3z"/></svg>`,
    `<svg class="journey-truck" viewBox="0 0 64 54" aria-hidden="true"><path class="motion-line" d="M5 20h12M2 27h12"/><path class="fill" d="M13 17h27v22H13zM40 25h10l9 9v5H40z"/><path d="M13 17h27v22H13zM40 25h10l9 9v5H40zM50 25v9h9M20 43a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm30 0a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>`,
    `<svg viewBox="0 0 64 54" aria-hidden="true"><path class="fill" d="m10 27 22-17 22 17v20H10z"/><path d="m10 27 22-17 22 17v20H10zM25 47V32h14v15"/><path class="accent" d="m24 26 6 6 12-13"/></svg>`,
  ];
  const steps = isDelivery ? deliverySteps : pickupSteps;
  const indexByStatus = isDelivery
    ? { 결제대기: 0, 접수대기: 0, 접수완료: 1, 배송중: 2, 배송완료: 3 }
    : { 결제대기: 0, 접수대기: 0, 접수완료: 1, 픽업준비완료: 2, 픽업완료: 3 };
  const currentIndex = indexByStatus[status] ?? 0;
  const progress = status === "취소" ? 0 : Math.round((currentIndex / (steps.length - 1)) * 100);
  return `<section class="is-wide admin-order-journey-section${status === "취소" ? " is-cancelled" : ""}" aria-label="${isDelivery ? "배송" : "픽업"} 진행 과정">
    <div class="admin-order-journey-head"><h3>${isDelivery ? "배송 과정" : "픽업 과정"}</h3><span>${status === "취소" ? "취소된 주문" : `${currentIndex + 1} / ${steps.length} 단계`}</span></div>
    <div class="admin-order-journey" style="--journey-progress:${progress / 100}">
      ${steps.map(([label, description], index) => `<article class="${index < currentIndex ? "is-complete" : index === currentIndex && status !== "취소" ? "is-active" : "is-upcoming"}"><div class="admin-journey-illustration">${icons[index]}<span>${index < currentIndex ? "✓" : index + 1}</span></div><strong>${label}</strong><p>${description}</p></article>`).join("")}
    </div>
  </section>`;
}

function openAdminOrderDetail(orderId, { preservePii = false } = {}) {
  const dialog = document.querySelector("[data-admin-order-detail-dialog]");
  const content = document.querySelector("[data-admin-order-detail]");
  const order = readOrders().find((current) => current.id === orderId);
  if (!dialog || !content || !order) return;
  if (!preservePii || activeAdminOrderPii?.orderId !== orderId) clearActiveAdminOrderPii();

  dialog.scrollTop = 0;
  content.scrollTop = 0;

  const created = order.createdAt ? new Date(order.createdAt).toLocaleString("ko-KR") : "-";
  const pickup = [order.pickupDate, order.pickupTime].filter(Boolean).join(" ") || "미정";
  const fulfillment = getFulfillmentLabel(order.fulfillmentType);
  const needsReconciliation = order.paymentInternalStatus === "RECONCILE_REQUIRED";
  const paymentStatus = getAdminPaymentStatusLabel(order);
  const statusClass = getAdminOrderStatusClass(getUnifiedWorkflowStatus(order));
  const { revenue } = getAdminOrderMargin(order);
  const orderItems = Array.isArray(order.items) && order.items.length ? order.items : [{ productName: order.product, unitPrice: order.unitPrice, quantity: order.quantity, lineTotal: Number(order.unitPrice || 0) * Number(order.quantity || 1) }];
  const subtotal = Number(order.subtotal ?? orderItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0));
  const deliveryFee = Number(order.deliveryFee || 0);
  const discount = Math.max(0, subtotal + deliveryFee - revenue);
  const requestMemo = String(order.memo || "").trim();
  const canRefund = ["결제완료", "부분환불"].includes(paymentStatus) && revenue > 0;
  const statusOptions = getAllowedAdminOrderStatuses(order);
  const isCancelled = getUnifiedWorkflowStatus(order) === "취소";
  const savedCancellationReason = String(order.changeReason || order.cancelReason || "").trim();
  const revealedPii = activeAdminOrderPii?.orderId === orderId ? activeAdminOrderPii : null;
  const piiAccessSection = hasAdminPermission("orders:pii:read") ? `
    <section class="admin-order-pii-access" data-admin-order-pii-access>
      <div class="admin-order-card-title"><h3>개인정보 접근</h3></div>
      ${revealedPii ? `
        <dl data-admin-order-pii-revealed>
          <div><dt>고객명</dt><dd>${escapeHtml(revealedPii.customer || "-")}</dd></div>
          <div><dt>연락처</dt><dd>${escapeHtml(revealedPii.phone || "-")}</dd></div>
          <div><dt>배송지</dt><dd>${escapeHtml(revealedPii.deliveryAddress || "-")}</dd></div>
        </dl>
        <p>이 정보는 이 상세 화면에서만 표시되며 3분 후 자동으로 숨겨집니다.</p>
        <button type="button" data-detail-action="hide-pii">개인정보 숨기기</button>
      ` : `
        <label>접근 목적
          <select data-admin-order-pii-reason>
            <option value="">목적을 선택해 주세요</option>
            <option value="delivery_contact">배송 연락</option>
            <option value="pickup_contact">픽업 연락</option>
            <option value="order_issue">주문 문제 처리</option>
            <option value="customer_request">고객 요청</option>
            <option value="address_verification">주소 확인</option>
          </select>
        </label>
        <button type="button" data-detail-action="access-pii">개인정보 보기</button>
      `}
    </section>
  ` : "";
  const piiUpdateSection = hasAdminPermission("orders:pii:write") ? `
    <section class="admin-order-pii-update" data-admin-order-pii-update>
      <div class="admin-order-card-title"><h3>개인정보 수정</h3></div>
      <p>현재 값은 자동으로 채우지 않습니다. 변경할 항목만 입력해 주세요.</p>
      <form data-admin-order-pii-update-form autocomplete="off">
        <label>수정 사유
          <select data-admin-order-pii-update-reason required>
            <option value="">사유를 선택해 주세요</option>
            <option value="customer_request">고객 요청</option>
            <option value="address_correction">주소 정정</option>
            <option value="phone_correction">연락처 정정</option>
            <option value="name_correction">이름 정정</option>
            <option value="order_issue">주문 문제 처리</option>
          </select>
        </label>
        <label>고객명<input type="text" maxlength="50" data-admin-order-pii-update-customer autocomplete="off" /></label>
        <label>연락처<input type="tel" data-admin-order-pii-update-phone autocomplete="off" /></label>
        <label>배송지<input type="text" maxlength="200" data-admin-order-pii-update-address autocomplete="off" /></label>
        <button type="button" data-detail-action="update-pii">개인정보 수정 저장</button>
        <button type="reset" data-detail-action="cancel-pii-update">입력 취소</button>
      </form>
    </section>
  ` : "";
  content.innerHTML = `
    <header class="admin-order-detail-head">
      <div class="admin-order-detail-heading-row"><div class="admin-order-detail-heading"><h2 id="admin-order-detail-title">주문 상세</h2><span>ORDER DETAIL</span></div></div>
      <button type="button" data-admin-order-detail-close aria-label="주문 상세 닫기">×</button>
    </header>
    <div class="admin-order-detail-grid">
      <section class="admin-order-customer-section"><div class="admin-order-card-title"><h3>고객 정보</h3></div><dl><div><dt>고객명</dt><dd><span class="admin-inline-view">${escapeHtml(order.customer || "-")}</span></dd></div><div><dt>연락처</dt><dd><span class="admin-inline-view">${escapeHtml(order.phone || "-")}</span></dd></div><div><dt>주문 접수</dt><dd>${escapeHtml(created)}</dd></div></dl></section>
      <section><h3>배송 및 수령 정보</h3><dl><div><dt>진행 상태</dt><dd><span class="admin-order-status-pill ${statusClass}">${escapeHtml(getUnifiedWorkflowStatus(order))}</span></dd></div><div><dt>수령 방법</dt><dd><span class="admin-inline-view">${escapeHtml(fulfillment)}</span><select class="admin-inline-field" data-inline-fulfillment><option value="pickup" ${order.fulfillmentType !== "delivery" ? "selected" : ""}>매장 픽업</option><option value="delivery" ${order.fulfillmentType === "delivery" ? "selected" : ""}>배송</option></select></dd></div><div><dt>수령 일정</dt><dd><span class="admin-inline-view">${escapeHtml(pickup)}</span><span class="admin-inline-field admin-inline-date-time"><input data-inline-pickup-date type="date" value="${escapeHtml(order.pickupDate || "")}" /><input data-inline-pickup-time type="time" value="${escapeHtml(order.pickupTime || "")}" /></span></dd></div><div><dt>배송지</dt><dd><span class="admin-inline-view">${escapeHtml(order.deliveryAddress || (order.fulfillmentType === "delivery" ? "배송지 미입력" : "매장 방문 수령"))}</span></dd></div></dl></section>
      ${isCancelled ? `<section class="is-wide admin-order-cancellation-section"><div class="admin-order-cancellation-summary"><div class="admin-order-cancellation-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 8v5m0 3h.01"/><circle cx="12" cy="12" r="9"/></svg></div><div><span>ORDER CANCELLED</span><h3>주문 취소 사유</h3><small data-order-cancellation-meta>취소 처리 이력을 확인하고 있습니다.</small></div></div><div class="admin-order-cancellation-reason"><span>취소 사유</span><p data-order-cancellation-reason>${escapeHtml(savedCancellationReason || "취소 사유를 불러오는 중입니다.")}</p></div></section>` : ""}
      ${piiAccessSection}
      ${piiUpdateSection}
      ${buildOrderFulfillmentJourney(order)}
      <section class="is-wide admin-order-product-payment-section"><h3>주문 상품 및 결제</h3><div class="admin-order-item-lines">${orderItems.map((item, index) => `<div><strong><span class="admin-inline-view">${escapeHtml(item.productName || "상품")}</span>${index === 0 ? `<input class="admin-inline-field" data-inline-product value="${escapeHtml(item.productName || order.product || "")}" />` : ""}</strong><span><span class="admin-inline-view">${formatWon(Number(item.unitPrice || 0))} × ${Number(item.quantity || 0)}개</span>${index === 0 ? `<span class="admin-inline-field admin-inline-product-values"><label>단가<input data-inline-unit-price type="number" min="0" value="${Number(item.unitPrice || order.unitPrice || 0)}" /></label><label>수량<input data-inline-quantity type="number" min="1" max="99" value="${Number(item.quantity || order.quantity || 1)}" /></label></span>` : ""}</span><b>${formatWon(Number(item.lineTotal || 0))}</b></div>`).join("")}</div><div class="admin-order-combined-payment"><h4>결제 요약</h4><div class="admin-order-payment-layout"><dl class="admin-order-payment-meta"><div><dt>결제 상태</dt><dd>${escapeHtml(paymentStatus)}</dd></div>${needsReconciliation ? `<div><dt>최근 오류</dt><dd>${escapeHtml(getAdminPaymentErrorMessage(order.paymentLastError))}</dd></div><div><dt>최근 갱신</dt><dd>${order.paymentUpdatedAt ? escapeHtml(new Date(order.paymentUpdatedAt).toLocaleString("ko-KR")) : "-"}</dd></div>` : ""}<div><dt>결제 수단</dt><dd>-</dd></div><div><dt>환불 금액</dt><dd>-</dd></div></dl><dl class="admin-order-price-lines"><div><dt>상품금액</dt><dd>${formatWon(subtotal)}</dd></div><div><dt>배송비</dt><dd>${formatWon(deliveryFee)}</dd></div><div><dt>할인</dt><dd>-${formatWon(discount)}</dd></div><div><dt>최종 결제금액</dt><dd><strong>${formatWon(revenue)}</strong></dd></div></dl></div></div></section>
      <section class="is-wide admin-order-request-section ${requestMemo ? "has-request" : "is-empty"}"><div class="admin-order-request-head"><h3>고객 요청사항</h3>${requestMemo ? `<span>확인 필요</span>` : ""}</div><div class="admin-order-request-note"><span class="admin-order-request-mark admin-inline-view" aria-hidden="true">“</span><p class="admin-order-detail-memo admin-inline-view">${escapeHtml(requestMemo || "별도로 전달된 요청사항이 없습니다.")}</p><textarea class="admin-inline-field" data-inline-memo rows="3">${escapeHtml(order.memo || "")}</textarea></div></section>
      <section class="is-wide"><h3>상태 변경 이력</h3><ol class="admin-order-history" data-order-history><li class="is-empty">이력을 불러오는 중입니다.</li></ol></section>
    </div>
    <footer class="admin-order-detail-actions" data-order-id="${escapeHtml(order.id)}">
      <div class="admin-detail-status-control"><input type="hidden" data-detail-status value="${escapeHtml(getUnifiedWorkflowStatus(order))}" /><details class="admin-detail-status-menu"><summary data-detail-status-label>${escapeHtml(getUnifiedWorkflowStatus(order))}</summary><div>${statusOptions.map((status) => `<button type="button" data-detail-status-option="${escapeHtml(status)}" ${status === getUnifiedWorkflowStatus(order) ? "aria-current=\"true\"" : ""}>${escapeHtml(status)}</button>`).join("")}</div></details><button type="button" data-detail-action="save">변경</button></div>
      <button type="button" data-detail-action="print">주문서 인쇄</button>
      <button type="button" data-detail-action="edit">주문 수정</button>
      <button type="button" data-detail-action="edit-cancel" hidden>수정 취소</button><button class="is-primary" type="button" data-detail-action="edit-save" hidden>수정 저장</button>
      ${needsReconciliation ? `<button class="admin-payment-reconcile-button" type="button" data-detail-action="reconcile-payment">결제 상태 확인</button>` : ""}
      ${canRefund ? `<label class="admin-refund-input">환불액<input type="number" min="1" max="${revenue}" data-detail-refund-amount placeholder="전체 환불" /></label><label class="admin-refund-input">환불 사유<input type="text" maxlength="200" data-detail-refund-reason placeholder="환불 사유" /></label><button class="is-danger" type="button" data-detail-action="cancel-payment">환불 처리</button>` : `<button type="button" data-detail-action="payment">결제 링크 만들기</button>`}
    </footer>`;

  if (hasAdminPermission("orders:pii:write")) {
    activeAdminOrderPiiUpdateTimer = setTimeout(() => {
      document.querySelector("[data-admin-order-pii-update-form]")?.reset();
      activeAdminOrderPiiUpdateTimer = null;
    }, ADMIN_ORDER_PII_TIMEOUT_MS);
  }

  if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
  else if (!dialog.open) dialog.setAttribute("open", "");
  requestAnimationFrame(() => {
    dialog.scrollTop = 0;
    content.scrollTop = 0;
  });
  apiFetch(`/orders/${encodeURIComponent(order.id)}/history`).then((history) => {
    const list = content.querySelector("[data-order-history]");
    if (!list) return;
    if (!Array.isArray(history) || !history.length) {
      list.innerHTML = '<li class="is-empty">저장된 상태 변경 이력이 없습니다.</li>';
      const reason = content.querySelector("[data-order-cancellation-reason]");
      const meta = content.querySelector("[data-order-cancellation-meta]");
      if (reason) reason.textContent = savedCancellationReason || "등록된 취소 사유가 없습니다.";
      if (meta) meta.textContent = "취소 처리 시점이 기록되지 않았습니다.";
      return;
    }
    list.innerHTML = history.map((entry) => {
      const actor = entry.changedBy === "system" ? "자동 처리" : entry.changedBy === "admin" ? "관리자" : (entry.changedBy || "자동 처리");
      return `<li><time>${new Date(entry.createdAt).toLocaleString("ko-KR")}</time><strong>${escapeHtml(entry.previousStatus || "최초 접수")} → ${escapeHtml(entry.nextStatus)}</strong><span>${escapeHtml(actor)}${entry.reason ? ` · ${escapeHtml(entry.reason)}` : ""}</span></li>`;
    }).join("");
    if (isCancelled) {
      const cancellation = history.find((entry) => ["취소", "주문취소", "결제취소", "환불완료"].includes(entry.nextStatus));
      const reason = content.querySelector("[data-order-cancellation-reason]");
      const meta = content.querySelector("[data-order-cancellation-meta]");
      if (reason) reason.textContent = cancellation?.reason || savedCancellationReason || "등록된 취소 사유가 없습니다.";
      if (meta) meta.textContent = cancellation
        ? `${new Date(cancellation.createdAt).toLocaleString("ko-KR")} · ${cancellation.changedBy === "admin" ? "관리자 처리" : cancellation.changedBy === "system" ? "자동 처리" : cancellation.changedBy || "처리자 미확인"}`
        : "취소 처리 시점이 기록되지 않았습니다.";
    }
  });
}

function closeAdminOrderDetail() {
  const dialog = document.querySelector("[data-admin-order-detail-dialog]");
  if (!dialog) return;
  const content = dialog.querySelector("[data-admin-order-detail]");
  clearActiveAdminOrderPii();
  dialog.scrollTop = 0;
  if (content) content.scrollTop = 0;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}
