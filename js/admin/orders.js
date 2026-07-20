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
      const paymentStatus = order.paymentStatus || (order.paymentKey ? "결제완료" : "결제대기");
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
          <td><div class="admin-combined-status"><span class="admin-order-status-pill ${statusClass}">${escapeHtml(getUnifiedWorkflowStatus(order))}</span></div></td>
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

function openAdminOrderDetail(orderId) {
  const dialog = document.querySelector("[data-admin-order-detail-dialog]");
  const content = document.querySelector("[data-admin-order-detail]");
  const order = readOrders().find((current) => current.id === orderId);
  if (!dialog || !content || !order) return;

  dialog.scrollTop = 0;
  content.scrollTop = 0;

  const created = order.createdAt ? new Date(order.createdAt).toLocaleString("ko-KR") : "-";
  const pickup = [order.pickupDate, order.pickupTime].filter(Boolean).join(" ") || "미정";
  const fulfillment = getFulfillmentLabel(order.fulfillmentType);
  const paymentStatus = order.paymentStatus || (order.paymentKey ? "결제완료" : "결제대기");
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
  content.innerHTML = `
    <header class="admin-order-detail-head">
      <div class="admin-order-detail-heading-row"><div class="admin-order-detail-heading"><h2 id="admin-order-detail-title">주문 상세</h2><span>ORDER DETAIL</span></div></div>
      <button type="button" data-admin-order-detail-close aria-label="주문 상세 닫기">×</button>
    </header>
    <div class="admin-order-detail-grid">
      <section class="admin-order-customer-section"><div class="admin-order-card-title"><h3>고객 정보</h3></div><dl><div><dt>고객명</dt><dd><span class="admin-inline-view">${escapeHtml(order.customer || "-")}</span><input class="admin-inline-field" data-inline-customer value="${escapeHtml(order.customer || "")}" /></dd></div><div><dt>연락처</dt><dd><span class="admin-inline-view">${escapeHtml(order.phone || "-")}</span><input class="admin-inline-field" data-inline-phone value="${escapeHtml(order.phone || "")}" /></dd></div><div><dt>주문 접수</dt><dd>${escapeHtml(created)}</dd></div></dl></section>
      <section><h3>배송 및 수령 정보</h3><dl><div><dt>진행 상태</dt><dd><span class="admin-order-status-pill ${statusClass}">${escapeHtml(getUnifiedWorkflowStatus(order))}</span></dd></div><div><dt>수령 방법</dt><dd><span class="admin-inline-view">${escapeHtml(fulfillment)}</span><select class="admin-inline-field" data-inline-fulfillment><option value="pickup" ${order.fulfillmentType !== "delivery" ? "selected" : ""}>매장 픽업</option><option value="delivery" ${order.fulfillmentType === "delivery" ? "selected" : ""}>배송</option></select></dd></div><div><dt>수령 일정</dt><dd><span class="admin-inline-view">${escapeHtml(pickup)}</span><span class="admin-inline-field admin-inline-date-time"><input data-inline-pickup-date type="date" value="${escapeHtml(order.pickupDate || "")}" /><input data-inline-pickup-time type="time" value="${escapeHtml(order.pickupTime || "")}" /></span></dd></div><div><dt>배송지</dt><dd><span class="admin-inline-view">${escapeHtml(order.deliveryAddress || (order.fulfillmentType === "delivery" ? "배송지 미입력" : "매장 방문 수령"))}</span><input class="admin-inline-field" data-inline-address value="${escapeHtml(order.deliveryAddress || "")}" /></dd></div></dl></section>
      ${isCancelled ? `<section class="is-wide admin-order-cancellation-section"><div class="admin-order-cancellation-summary"><div class="admin-order-cancellation-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 8v5m0 3h.01"/><circle cx="12" cy="12" r="9"/></svg></div><div><span>ORDER CANCELLED</span><h3>주문 취소 사유</h3><small data-order-cancellation-meta>취소 처리 이력을 확인하고 있습니다.</small></div></div><div class="admin-order-cancellation-reason"><span>취소 사유</span><p data-order-cancellation-reason>${escapeHtml(savedCancellationReason || "취소 사유를 불러오는 중입니다.")}</p></div></section>` : ""}
      ${buildOrderFulfillmentJourney(order)}
      <section class="is-wide admin-order-product-payment-section"><h3>주문 상품 및 결제</h3><div class="admin-order-item-lines">${orderItems.map((item, index) => `<div><strong><span class="admin-inline-view">${escapeHtml(item.productName || "상품")}</span>${index === 0 ? `<input class="admin-inline-field" data-inline-product value="${escapeHtml(item.productName || order.product || "")}" />` : ""}</strong><span><span class="admin-inline-view">${formatWon(Number(item.unitPrice || 0))} × ${Number(item.quantity || 0)}개</span>${index === 0 ? `<span class="admin-inline-field admin-inline-product-values"><label>단가<input data-inline-unit-price type="number" min="0" value="${Number(item.unitPrice || order.unitPrice || 0)}" /></label><label>수량<input data-inline-quantity type="number" min="1" max="99" value="${Number(item.quantity || order.quantity || 1)}" /></label></span>` : ""}</span><b>${formatWon(Number(item.lineTotal || 0))}</b></div>`).join("")}</div><div class="admin-order-combined-payment"><h4>결제 요약</h4><div class="admin-order-payment-layout"><dl class="admin-order-payment-meta"><div><dt>결제 상태</dt><dd>${escapeHtml(paymentStatus)}</dd></div><div><dt>결제 수단</dt><dd data-order-payment-method>-</dd></div><div><dt>환불 금액</dt><dd data-order-refund-total>0원</dd></div></dl><dl class="admin-order-price-lines"><div><dt>상품금액</dt><dd>${formatWon(subtotal)}</dd></div><div><dt>배송비</dt><dd>${formatWon(deliveryFee)}</dd></div><div><dt>할인</dt><dd>-${formatWon(discount)}</dd></div><div><dt>최종 결제금액</dt><dd><strong>${formatWon(revenue)}</strong></dd></div></dl></div></div></section>
      <section class="is-wide admin-order-request-section ${requestMemo ? "has-request" : "is-empty"}"><div class="admin-order-request-head"><h3>고객 요청사항</h3>${requestMemo ? `<span>확인 필요</span>` : ""}</div><div class="admin-order-request-note"><span class="admin-order-request-mark admin-inline-view" aria-hidden="true">“</span><p class="admin-order-detail-memo admin-inline-view">${escapeHtml(requestMemo || "별도로 전달된 요청사항이 없습니다.")}</p><textarea class="admin-inline-field" data-inline-memo rows="3">${escapeHtml(order.memo || "")}</textarea></div></section>
      <section class="is-wide"><h3>상태 변경 이력</h3><ol class="admin-order-history" data-order-history><li class="is-empty">이력을 불러오는 중입니다.</li></ol></section>
    </div>
    <footer class="admin-order-detail-actions" data-order-id="${escapeHtml(order.id)}">
      <div class="admin-detail-status-control"><input type="hidden" data-detail-status value="${escapeHtml(getUnifiedWorkflowStatus(order))}" /><details class="admin-detail-status-menu"><summary data-detail-status-label>${escapeHtml(getUnifiedWorkflowStatus(order))}</summary><div>${statusOptions.map((status) => `<button type="button" data-detail-status-option="${escapeHtml(status)}" ${status === getUnifiedWorkflowStatus(order) ? "aria-current=\"true\"" : ""}>${escapeHtml(status)}</button>`).join("")}</div></details><button type="button" data-detail-action="save">변경</button></div>
      <button type="button" data-detail-action="print">주문서 인쇄</button>
      <button type="button" data-detail-action="edit">주문 수정</button>
      <button type="button" data-detail-action="edit-cancel" hidden>수정 취소</button><button class="is-primary" type="button" data-detail-action="edit-save" hidden>수정 저장</button>
      ${canRefund ? `<label class="admin-refund-input">환불액<input type="number" min="1" max="${revenue}" data-detail-refund-amount placeholder="전체 환불" /></label><label class="admin-refund-input">환불 사유<input type="text" maxlength="200" data-detail-refund-reason placeholder="환불 사유" /></label><button class="is-danger" type="button" data-detail-action="cancel-payment">환불 처리</button>` : `<button type="button" data-detail-action="payment">결제 링크 만들기</button>`}
    </footer>`;

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
  apiFetch(`/payments/${encodeURIComponent(order.id)}`).then((payment) => {
    if (!payment || payment.status === "NONE") return;
    const method = content.querySelector("[data-order-payment-method]");
    const refund = content.querySelector("[data-order-refund-total]");
    if (method) method.textContent = payment.paymentMethod || "결제수단 미제공";
    if (refund) refund.textContent = formatWon(Number(payment.canceledAmount || 0));
    if (isCancelled && payment.cancelReason) {
      const reason = content.querySelector("[data-order-cancellation-reason]");
      if (reason && !savedCancellationReason) reason.textContent = payment.cancelReason;
    }
  });
}

function closeAdminOrderDetail() {
  const dialog = document.querySelector("[data-admin-order-detail-dialog]");
  if (!dialog) return;
  const content = dialog.querySelector("[data-admin-order-detail]");
  dialog.scrollTop = 0;
  if (content) content.scrollTop = 0;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}
