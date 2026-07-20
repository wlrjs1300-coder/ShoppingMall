document.querySelector(".admin-order-list")?.addEventListener("change", (event) => {
  const row = event.target.closest("tr[data-order-id]");
  if (!row) return;
  const id = row.dataset.orderId;
  if (event.target.matches("[data-admin-order-select]")) {
    event.target.checked ? selectedAdminOrderIds.add(id) : selectedAdminOrderIds.delete(id);
    updateAdminBulkBar();
    return;
  }
  if (event.target.classList.contains("admin-status")) {
    updateAdminOrder(id, { status: event.target.value });
  }
  if (event.target.classList.contains("admin-revenue")) {
    updateAdminOrder(id, { revenue: Number(event.target.value || 0) });
  }
  if (event.target.classList.contains("admin-cost")) {
    updateAdminOrder(id, { cost: Number(event.target.value || 0) });
  }
});

document.querySelector(".admin-order-list")?.addEventListener("click", async (event) => {
  if (event.target.closest("[data-admin-order-select]")) return;
  const detailButton = event.target.closest(".admin-order-detail-open");
  if (detailButton) {
    const row = detailButton.closest("tr[data-order-id]");
    if (row) openAdminOrderDetail(row.dataset.orderId);
    return;
  }

  const reorderButton = event.target.closest(".admin-reorder");
  if (reorderButton) {
    const row = reorderButton.closest("tr[data-order-id]");
    const order = readOrders().find((current) => current.id === row?.dataset.orderId);
    if (order) {
      openAdminOrderCreate({
        customer: order.customer,
        phone: order.phone,
        product: order.product,
        quantity: order.quantity,
        unitPrice: order.unitPrice,
        revenue: order.revenue,
        cost: order.cost,
        fulfillmentType: order.fulfillmentType,
      });
    }
    return;
  }

  const printButton = event.target.closest(".admin-print");
  if (printButton) {
    const row = printButton.closest("tr[data-order-id]");
    if (row) printOrderReceipt(row.dataset.orderId);
    return;
  }

  const editButton = event.target.closest(".admin-edit");
  if (editButton) {
    const row = editButton.closest("tr[data-order-id]");
    const order = readOrders().find((current) => current.id === row.dataset.orderId);
    if (order) openAdminOrderCreate(order);
    return;
  }

  const payButton = event.target.closest(".admin-pay");
  if (payButton) {
    const row = payButton.closest("tr[data-order-id]");
    const order = readOrders().find((o) => o.id === row.dataset.orderId);
    if (!order) return;
    createPaymentLink(order.id);
    return;
  }

  const cancelPaymentButton = event.target.closest(".admin-payment-cancel");
  if (cancelPaymentButton) {
    const row = cancelPaymentButton.closest("tr[data-order-id]");
    if (!row || !await AppUI.confirm("이 주문의 결제를 취소할까요? 실제 승인 결제라면 고객에게 환불됩니다.")) return;
    const reason = prompt("취소 사유를 입력해 주세요.", "고객 요청");
    if (reason === null) return;
    cancelAdminPayment(row.dataset.orderId, reason);
    return;
  }

  const deleteButton = event.target.closest(".admin-delete");
  if (!deleteButton) {
    const row = event.target.closest("tr[data-order-id]");
    if (row) openAdminOrderDetail(row.dataset.orderId);
    return;
  }
  const row = deleteButton.closest("tr[data-order-id]");
  const orders = readOrders();
  const target = orders.find((order) => order.id === row.dataset.orderId);
  if (!await AppUI.confirm(`${target?.customer || "고객"}님의 ${target?.product || "주문"}을 삭제할까요? 삭제 후 복구할 수 없습니다.`)) return;
  writeOrders(orders.filter((order) => order.id !== row.dataset.orderId));
  addActivityLog("주문", `${target?.product || "주문"}을 삭제했습니다.`, "orders");
  renderAdminDashboard();
  setAdminFeedback("주문 1건을 삭제했습니다.");
});

document.querySelector(".admin-order-list")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-order-id]");
  if (!row) return;
  event.preventDefault();
  openAdminOrderDetail(row.dataset.orderId);
});

document.querySelector("[data-admin-order-detail-dialog]")?.addEventListener("click", async (event) => {
  const dialog = event.currentTarget;
  if (event.target === dialog || event.target.closest("[data-admin-order-detail-close]")) {
    closeAdminOrderDetail();
    return;
  }

  const statusOption = event.target.closest("[data-detail-status-option]");
  if (statusOption) {
    const status = statusOption.dataset.detailStatusOption;
    const input = dialog.querySelector("[data-detail-status]");
    const label = dialog.querySelector("[data-detail-status-label]");
    if (input) input.value = status;
    if (label) label.textContent = status;
    dialog.querySelectorAll("[data-detail-status-option]").forEach((button) => button.toggleAttribute("aria-current", button === statusOption));
    statusOption.closest("details")?.removeAttribute("open");
    return;
  }

  const actionButton = event.target.closest("[data-detail-action]");
  if (!actionButton) return;
  const orderId = dialog.querySelector(".admin-order-detail-actions")?.dataset.orderId;
  const order = readOrders().find((current) => current.id === orderId);
  if (!order) return;

  const action = actionButton.dataset.detailAction;
  if (action === "customer-orders") {
    const search = document.querySelector(".admin-search-input");
    if (search) search.value = order.phone || order.customer || "";
    closeAdminOrderDetail(); renderAdminOrders();
    return;
  }
  if (action === "save") {
    const nextStatus = dialog.querySelector("[data-detail-status]")?.value || order.workflowStatus;
    let changeReason = dialog.querySelector("[data-detail-reason]")?.value.trim() || "";
    if (nextStatus === "취소" && nextStatus !== order.workflowStatus && !changeReason) {
      changeReason = await requestAdminBulkCancelReason();
      if (!changeReason) return;
    }
    updateAdminOrder(orderId, {
      workflowStatus: nextStatus,
      changeReason,
      ...(getUnifiedWorkflowStatus(order) === "결제대기" && !["결제대기", "취소"].includes(nextStatus) ? { paymentStatus: "결제완료" } : {}),
    });
    openAdminOrderDetail(orderId);
    return;
  }
  if (action === "print") {
    printOrderReceipt(orderId);
    return;
  }
  if (action === "payment") {
    await createPaymentLink(orderId);
    return;
  }
  if (action === "cancel-payment") {
    const reason = dialog.querySelector("[data-detail-refund-reason]")?.value.trim() || "";
    const rawAmount = dialog.querySelector("[data-detail-refund-amount]")?.value;
    if (!reason) return AppUI.alert("환불 사유를 입력해 주세요.");
    if (!await AppUI.confirm("입력한 금액을 실제로 환불할까요?")) return;
    await cancelAdminPayment(orderId, reason, rawAmount ? Number(rawAmount) : undefined);
    openAdminOrderDetail(orderId);
    return;
  }
  if (action === "edit") {
    dialog.querySelector(".admin-order-detail")?.classList.add("is-editing");
    actionButton.hidden = true;
    dialog.querySelector('[data-detail-action="edit-cancel"]')?.removeAttribute("hidden");
    dialog.querySelector('[data-detail-action="edit-save"]')?.removeAttribute("hidden");
    dialog.querySelector("[data-inline-customer]")?.focus();
    return;
  }
  if (action === "edit-cancel") {
    dialog.querySelector(".admin-order-detail")?.classList.remove("is-editing");
    const editButton = dialog.querySelector('[data-detail-action="edit"]');
    if (editButton) editButton.hidden = false;
    actionButton.hidden = true;
    dialog.querySelector('[data-detail-action="edit-save"]')?.setAttribute("hidden", "");
    return;
  }
  if (action === "edit-save") {
    const value = (selector) => dialog.querySelector(selector)?.value.trim() || "";
    const product = value("[data-inline-product]");
    const customer = value("[data-inline-customer]");
    const quantity = Math.max(1, Math.min(99, Number(value("[data-inline-quantity]")) || 1));
    const unitPrice = Math.max(0, Number(value("[data-inline-unit-price]")) || 0);
    if (!product || !customer) return AppUI.alert("고객명과 상품명을 입력해 주세요.");
    const items = Array.isArray(order.items) && order.items.length
      ? order.items.map((item, index) => index ? item : { ...item, productName: product, unitPrice, quantity, lineTotal: unitPrice * quantity })
      : order.items;
    updateAdminOrder(orderId, {
      customer,
      phone: value("[data-inline-phone]"),
      product,
      quantity,
      unitPrice,
      revenue: unitPrice * quantity,
      amountStatus: unitPrice > 0 ? "confirmed" : "pending",
      priceText: unitPrice ? formatWon(unitPrice) : "상담 후 안내",
      fulfillmentType: dialog.querySelector("[data-inline-fulfillment]")?.value || "pickup",
      pickupDate: value("[data-inline-pickup-date]"),
      pickupTime: value("[data-inline-pickup-time]"),
      deliveryAddress: value("[data-inline-address]"),
      memo: value("[data-inline-memo]"),
      ...(items ? { items } : {}),
    });
    openAdminOrderDetail(orderId);
    return;
  }
  if (action === "delete") {
    if (!await AppUI.confirm(`${order.customer || "고객"}님의 ${order.product || "주문"}을 삭제할까요? 삭제 후 복구할 수 없습니다.`)) return;
    writeOrders(readOrders().filter((current) => current.id !== orderId));
    addActivityLog("주문", `${order.product || "주문"}을 삭제했습니다.`, "orders");
    closeAdminOrderDetail();
    renderAdminDashboard();
    setAdminFeedback("주문 1건을 삭제했습니다.");
  }
});

document.querySelector("[data-admin-log-search]")?.addEventListener("input", renderAdminAuditLogs);
document.querySelector("[data-admin-log-reset]")?.addEventListener("click", () => {
  const input = document.querySelector("[data-admin-log-search]");
  if (input) input.value = "";
  renderAdminAuditLogs();
});

adminExportData?.addEventListener("click", exportAdminData);
adminDemoData?.addEventListener("click", createDemoOrders);
adminCsvData?.addEventListener("click", exportAdminOrdersCsv);
adminImportData?.addEventListener("click", () => adminImportInput?.click());
adminImportInput?.addEventListener("change", (event) => {
  importAdminData(event.target.files?.[0]);
});

adminProductionDateFilter?.addEventListener("change", () => {
  selectedAdminProductionOrderIds.clear();
  renderAdminProduction();
  setAdminFeedback(adminProductionDateFilter.value ? "선택한 픽업일 기준으로 생산 목록을 필터링했습니다." : "전체 생산 목록을 표시합니다.");
});
document.querySelector(".admin-production-search-input")?.addEventListener("input", () => {
  selectedAdminProductionOrderIds.clear();
  renderAdminProduction();
});

async function updateProductionWork(orderIds, nextStatus, { assignee, packaging, productName, skipCompletionConfirm = false } = {}) {
  if (!orderIds.length) return;
  const currentOrders = readOrders();
  const productionOrders = currentOrders.filter((order) => orderIds.includes(order.id) && !isTerminalStatus(order.status));
  if (!productionOrders.length) return;
  const product = productName || getProductionItemByOrderIds(orderIds)?.product || productionOrders[0]?.product || "";
  const quantity = productionOrders.reduce((sum, order) => sum + Number(order.quantity || 0), 0);
  const wasComplete = productionOrders.every((order) => order.productionStatus === "생산 완료" || order.status === "준비완료");
  if (wasComplete && nextStatus !== "생산 완료") {
    AppUI.alert("생산 완료된 항목은 재고가 이미 차감되어 이전 단계로 되돌릴 수 없습니다.");
    renderAdminProduction();
    return;
  }
  if (nextStatus === "생산 완료" && !wasComplete) {
    if (!skipCompletionConfirm && !await AppUI.confirm(`${product || "생산 항목"} ${quantity}개를 생산 완료 처리할까요? 관련 원재료 재고도 함께 차감됩니다.`)) {
      renderAdminProduction();
      return;
    }
    const result = await apiFetchResult("/orders/production/complete", {
      method: "POST",
      body: { orderIds: productionOrders.map((order) => order.id), productName: product },
    });
    if (!result.ok) {
      const details = result.data?.details;
      const detailText = [details?.missing?.length ? `누락: ${details.missing.join(", ")}` : "", details?.insufficient?.length ? `부족: ${details.insufficient.join(", ")}` : "", details?.unitMismatch?.length ? `단위 불일치: ${details.unitMismatch.join(", ")}` : ""].filter(Boolean).join(" · ");
      await AppUI.alert(`${result.error}${detailText ? `\n${detailText}` : ""}`);
      await loadFromApi();
      renderAdminDashboard();
      return;
    }
    if (Array.isArray(result.data?.orders)) {
      const updatedById = new Map(result.data.orders.map((order) => [order.id, order]));
      localStorage.setItem(orderStorageKey, JSON.stringify(currentOrders.map((order) => updatedById.get(order.id) || order)));
    }
    if (Array.isArray(result.data?.inventory)) {
      localStorage.setItem(inventoryStorageKey, JSON.stringify(result.data.inventory));
    }
    await loadFromApi();
    renderAdminDashboard();
    setAdminFeedback(result.data?.alreadyCompleted ? `${product} 생산 완료는 이미 처리되어 재고를 다시 차감하지 않았습니다.` : `${product} ${quantity}개 생산 완료와 원재료 차감을 함께 처리했습니다.`);
    return;
  }

  writeOrders(
    currentOrders.map((order) =>
      orderIds.includes(order.id) && !isTerminalStatus(order.status) ? {
        ...order,
        productionStatus: nextStatus,
        ...(nextStatus === "생산 완료" ? { status: "준비완료" } : {}),
        ...(assignee !== undefined ? { productionAssignee: assignee } : {}),
        ...(packaging !== undefined ? { packagingType: packaging } : {}),
      } : order,
    ),
  );
  addActivityLog("생산", `${product || "생산 항목"} ${quantity}개를 ${nextStatus}(으)로 변경했습니다.`, "production");
  renderAdminDashboard();
  setAdminFeedback(`${product || "생산 항목"}을 ${nextStatus}(으)로 변경했습니다.`);
}

document.querySelector(".admin-production-list")?.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".admin-production-select");
  if (checkbox) {
    const ids = (checkbox.closest("tr[data-production-order-ids]")?.dataset.productionOrderIds || "").split(",").filter(Boolean);
    ids.forEach((id) => checkbox.checked ? selectedAdminProductionOrderIds.add(id) : selectedAdminProductionOrderIds.delete(id));
    syncAdminProductionBulkUI();
    return;
  }
  const statusSelect = event.target.closest(".admin-production-status");
  if (!statusSelect) return;
  const row = statusSelect.closest("tr[data-production-order-ids]");
  updateProductionWork((row?.dataset.productionOrderIds || "").split(",").filter(Boolean), statusSelect.value, { productName: row?.dataset.productionProduct || "" });
});

document.querySelector(".admin-production-list")?.addEventListener("click", (event) => {
  const detailButton = event.target.closest(".admin-production-detail-open");
  if (!detailButton) return;
  const row = detailButton.closest("tr[data-production-order-ids]");
  openAdminProductionDetail((row?.dataset.productionOrderIds || "").split(",").filter(Boolean));
});

document.querySelector("[data-admin-production-detail-dialog]")?.addEventListener("click", async (event) => {
  if (event.target.closest("[data-production-detail-close]")) return closeAdminProductionDetail();
  const saveButton = event.target.closest("[data-production-detail-save]");
  if (!saveButton) return;
  const detail = event.currentTarget;
  const orderIds = (detail.querySelector("[data-production-detail-order-ids]")?.dataset.productionDetailOrderIds || "").split(",").filter(Boolean);
  await updateProductionWork(orderIds, detail.querySelector("[data-production-detail-status]")?.value || "생산 대기", {
    packaging: detail.querySelector("[data-production-packaging]")?.value || "기본 포장",
    productName: getProductionItemByOrderIds(orderIds)?.product || "",
  });
  closeAdminProductionDetail();
});

document.querySelector("[data-production-select-all]")?.addEventListener("change", (event) => {
  document.querySelectorAll(".admin-production-list tr[data-production-order-ids]").forEach((row) => {
    const ids = (row.dataset.productionOrderIds || "").split(",").filter(Boolean);
    ids.forEach((id) => event.target.checked ? selectedAdminProductionOrderIds.add(id) : selectedAdminProductionOrderIds.delete(id));
  });
  renderAdminProduction();
});

document.querySelector("[data-production-bulk-clear]")?.addEventListener("click", () => {
  selectedAdminProductionOrderIds.clear();
  renderAdminProduction();
});

document.querySelector("[data-production-bulk-apply]")?.addEventListener("click", async () => {
  const nextStatus = document.querySelector("[data-production-bulk-status]")?.value || "";
  const selectedItems = buildProductionItems(readOrders()).filter((item) => item.orderIds.some((id) => selectedAdminProductionOrderIds.has(id)));
  if (!nextStatus) return setAdminFeedback("일괄 변경할 생산 상태를 선택해 주세요.");
  if (!selectedItems.length) return;
  const completedItems = selectedItems.filter((item) => [...item.productionStatuses].every((status) => status === "생산 완료"));
  if (completedItems.length && nextStatus !== "생산 완료") {
    return AppUI.alert(`선택 항목 중 생산 완료된 항목이 ${completedItems.length}개 있습니다. 재고가 이미 차감된 항목은 이전 단계로 되돌릴 수 없습니다.`);
  }
  if (nextStatus === "생산 완료" && !await AppUI.confirm(`선택한 ${selectedItems.length}개 생산 항목을 완료 처리할까요? 항목별 원재료 재고가 함께 차감됩니다.`)) return;
  for (const item of selectedItems) {
    await updateProductionWork(item.orderIds, nextStatus, { productName: item.product, skipCompletionConfirm: true });
  }
  selectedAdminProductionOrderIds.clear();
  const select = document.querySelector("[data-production-bulk-status]");
  if (select) select.value = "";
  renderAdminProduction();
  setAdminFeedback(`${selectedItems.length}개 생산 항목을 ${nextStatus} 상태로 변경했습니다.`);
});

adminLogisticsDateFilter?.addEventListener("change", () => {
  renderAdminLogistics();
  setAdminFeedback(adminLogisticsDateFilter.value ? "선택한 수령일 기준으로 픽업/배송 목록을 필터링했습니다." : "전체 픽업/배송 목록을 표시합니다.");
});

adminLogisticsSearchInput?.addEventListener("input", () => {
  renderAdminLogistics();
});

adminLogisticsReset?.addEventListener("click", () => {
  if (adminLogisticsDateFilter) adminLogisticsDateFilter.value = "";
  if (adminLogisticsSearchInput) adminLogisticsSearchInput.value = "";
  renderAdminLogistics();
  setAdminFeedback("전체 픽업/배송 목록을 표시합니다.");
});

document.querySelector(".admin-logistics-list")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".admin-logistics-status-button");
  const row = event.target.closest("tr[data-order-id]");
  if (!row || !button || button.classList.contains("is-active")) return;
  const logisticsStatus = button.dataset.logisticsStatus;
  if (logisticsStatus === "완료" && !await AppUI.confirm("이 항목을 수령 완료 처리할까요? 완료된 항목은 현재 목록에서 제외됩니다.")) return;
  const patch = { logisticsStatus };
  if (logisticsStatus === "완료") {
    const order = readOrders().find((o) => o.id === row.dataset.orderId);
    patch.status = getTerminalStatus(order?.fulfillmentType);
  }
  updateAdminOrder(row.dataset.orderId, patch);
  setAdminFeedback("픽업/배송 상태를 변경했습니다.");
});

function updateAccountingFilter() {
  const start = adminAccountingStart?.value || "";
  const end = adminAccountingEnd?.value || "";
  if (start && end && start > end) {
    setAdminFeedback("시작일이 종료일보다 늦습니다. 날짜를 다시 확인해 주세요.");
    return;
  }
  renderAdminAccounting();
  setAdminFeedback("선택한 기간 기준으로 매출 데이터를 필터링했습니다.");
}

adminAccountingStart?.addEventListener("change", updateAccountingFilter);
adminAccountingEnd?.addEventListener("change", updateAccountingFilter);
adminAccountingCsv?.addEventListener("click", exportAccountingCsv);
adminAccountingReset?.addEventListener("click", () => {
  if (adminAccountingStart) adminAccountingStart.value = "";
  if (adminAccountingEnd) adminAccountingEnd.value = "";
  renderAdminAccounting();
  setAdminFeedback("전체 매출 데이터를 표시합니다.");
});

document.querySelector(".admin-search-input")?.addEventListener("input", renderAdminOrders);
function syncAdminStatusFilterUI() {
  const filter = document.querySelector(".admin-status-filter");
  const control = filter?.closest(".admin-status-filter-control");
  const caption = document.querySelector("[data-status-filter-caption]");
  if (!filter || !control) return;
  const status = filter.value;
  const tone = status === "취소"
    ? "cancelled"
    : ["배송완료", "픽업완료"].includes(status)
      ? "complete"
      : ["배송중", "픽업준비완료"].includes(status)
        ? "active"
        : status === "all" ? "all" : "waiting";
  control.dataset.statusTone = tone;
  if (caption) caption.textContent = status === "all" ? "전체 주문" : `${status}만 보기`;
}
document.querySelector(".admin-status-filter")?.addEventListener("change", () => {
  syncAdminStatusFilterUI();
  renderAdminOrders();
});
syncAdminStatusFilterUI();
document.querySelector(".admin-customer-search-input")?.addEventListener("input", renderAdminCustomers);
document.querySelector(".admin-customer-type-filter")?.addEventListener("change", renderAdminCustomers);
document.querySelector(".admin-inventory-search-input")?.addEventListener("input", renderAdminInventory);
document.querySelector("[data-admin-select-all]")?.addEventListener("change", (event) => {
  const visible = getFilteredAdminOrders();
  visible.forEach((order) => event.target.checked ? selectedAdminOrderIds.add(order.id) : selectedAdminOrderIds.delete(order.id));
  renderAdminOrders();
});
document.querySelector("[data-admin-bulk-clear]")?.addEventListener("click", () => { selectedAdminOrderIds.clear(); renderAdminOrders(); });
document.querySelector("[data-admin-bulk-print]")?.addEventListener("click", () => printProductionSheet([...selectedAdminOrderIds], document.querySelector("[data-admin-print-type]")?.value || "production"));

function requestAdminBulkCancelReason() {
  const dialog = document.querySelector("[data-admin-cancel-reason-dialog]");
  const form = document.querySelector("[data-admin-cancel-reason-form]");
  const input = document.querySelector("[data-admin-cancel-reason]");
  const closeButton = document.querySelector("[data-admin-cancel-reason-close]");
  if (!dialog || !form || !input) return Promise.resolve(null);

  form.reset();
  if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
  else if (!dialog.open) dialog.setAttribute("open", "");
  window.setTimeout(() => input.focus(), 0);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      form.removeEventListener("submit", onSubmit);
      closeButton?.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      resolve(value);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const reason = input.value.trim();
      if (!reason) {
        input.setCustomValidity("취소 사유를 입력해 주세요.");
        input.reportValidity();
        input.setCustomValidity("");
        return;
      }
      finish(reason);
    };
    const onCancel = (event) => { event?.preventDefault(); finish(null); };
    const onClose = () => finish(null);
    form.addEventListener("submit", onSubmit);
    closeButton?.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose);
  });
}

document.querySelector("[data-admin-bulk-apply]")?.addEventListener("click", async () => {
  const status = document.querySelector("[data-admin-bulk-status]")?.value;
  if (!status) return AppUI.alert("변경할 상태를 선택해 주세요.");
  const reason = status === "취소" ? await requestAdminBulkCancelReason() : "";
  if (status === "취소" && !reason) return;
  const orders = readOrders();
  let changed = 0;
  const next = orders.map((order) => {
    if (!selectedAdminOrderIds.has(order.id) || !getAllowedAdminOrderStatuses(order).includes(status) || order.workflowStatus === status) return order;
    changed += 1;
    return { ...order, workflowStatus: status, changeReason: reason };
  });
  if (!changed) return AppUI.alert("선택 주문 중 해당 상태로 변경할 수 있는 주문이 없습니다.");
  const statusLabel = status;
  if (!await AppUI.confirm(`${changed}건의 상태를 ${statusLabel}(으)로 변경할까요?`)) return;
  writeOrders(next); selectedAdminOrderIds.clear(); renderAdminDashboard(); setAdminFeedback(`${changed}건의 상태 변경을 요청했습니다.`);
});

document.querySelector(".admin-customer-list")?.addEventListener("input", (event) => {
  const note = event.target.closest(".admin-note");
  if (!note) return;
  const row = note.closest("tr[data-customer-id]");
  const notes = readCustomerNotes();
  notes[row.dataset.customerId] = note.value;
  writeCustomerNotes(notes);

  const savedCustomerId = row.dataset.savedCustomerId;
  if (savedCustomerId) {
    writeCustomers(
      readCustomers().map((customer) => (customer.id === savedCustomerId ? { ...customer, memo: note.value, updatedAt: new Date().toISOString() } : customer)),
    );
  }
});

adminCustomerForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAdminCustomer(new FormData(adminCustomerForm));
});

adminCustomerCancel?.addEventListener("click", () => {
  resetAdminCustomerForm();
  closeAdminFormDrawer("customer");
});

document.querySelector(".admin-customer-list")?.addEventListener("click", async (event) => {
  const row = event.target.closest("tr[data-customer-id]");
  if (!row) return;

  if (event.target.closest(".admin-customer-orders")) {
    const customers = buildAdminCustomers(readOrders());
    const customer = customers.find((c) => c.id === row.dataset.customerId);
    if (!customer) return;
    const query = customer.phone && customer.phone !== "-" ? customer.phone : customer.name;
    const searchInput = document.querySelector(".admin-search-input");
    if (searchInput) searchInput.value = query;
    setAdminTab("orders");
    renderAdminOrders();
    return;
  }

  if (event.target.closest(".admin-customer-edit")) {
    editAdminCustomer(row.dataset.savedCustomerId || row.dataset.customerId);
    return;
  }

  const suspendButton = event.target.closest(".admin-customer-suspend");
  if (suspendButton && !suspendButton.disabled) {
    const userId = suspendButton.dataset.userId;
    const willSuspend = suspendButton.dataset.suspended !== "true";
    if (!userId || !await AppUI.confirm(willSuspend ? "이 회원의 로그인을 정지할까요?" : "이 회원의 로그인 정지를 해제할까요?")) return;
    const result = await apiFetch(`/users/admin/${encodeURIComponent(userId)}/suspension`, { method: "POST", body: { suspended: willSuspend } });
    if (!result) return AppUI.alert("회원 정지 상태를 변경하지 못했습니다.");
    const member = adminMemberDirectory.find((item) => item.id === userId);
    if (member) member.suspended = result.suspended;
    suspendButton.dataset.suspended = String(result.suspended);
    suspendButton.textContent = result.suspended ? "정지 해제" : "정지";
    setAdminFeedback(result.suspended ? "회원 로그인을 정지했습니다." : "회원 로그인 정지를 해제했습니다.");
    return;
  }

  const withdrawButton = event.target.closest(".admin-customer-withdraw");
  if (withdrawButton && !withdrawButton.disabled) {
    const userId = withdrawButton.dataset.userId;
    if (!userId || !await AppUI.confirm("이 회원을 탈퇴 처리할까요? 개인정보와 소셜 연결 정보가 삭제되며 되돌릴 수 없습니다.")) return;
    const result = await apiFetch(`/users/admin/${encodeURIComponent(userId)}/withdraw`, { method: "POST" });
    if (!result) return AppUI.alert("진행 중인 주문이 있거나 탈퇴 처리할 수 없는 회원입니다.");
    const member = adminMemberDirectory.find((item) => item.id === userId);
    if (member) member.status = "withdrawn";
    row.querySelectorAll(".admin-customer-suspend, .admin-customer-withdraw").forEach((button) => { button.disabled = true; });
    withdrawButton.textContent = "탈퇴 완료";
    setAdminFeedback("회원을 탈퇴 처리했습니다.");
  }
});

// 결제 링크 생성 및 복사
async function createPaymentLink(orderId) {
  if (!getApiToken()) {
    AppUI.alert("로그인 후 사용할 수 있습니다.");
    return;
  }
  const order = readOrders().find((item) => item.id === orderId);
  if (!order || order.amountStatus === "pending" || Number(order.revenue || 0) <= 0) {
    const detail = document.querySelector(".admin-order-detail");
    detail?.classList.add("is-editing");
    detail?.querySelector('[data-detail-action="edit"]')?.setAttribute("hidden", "");
    detail?.querySelector('[data-detail-action="edit-cancel"]')?.removeAttribute("hidden");
    detail?.querySelector('[data-detail-action="edit-save"]')?.removeAttribute("hidden");
    detail?.querySelector("[data-inline-unit-price]")?.focus();
    AppUI.alert("결제 링크를 만들려면 주문 상품의 단가를 입력하고 수정 저장해 주세요.");
    return;
  }
  const result = await apiFetch("/payments", { method: "POST", body: { orderId } });
  if (!result || result.error) {
    AppUI.alert(result?.error || "결제 링크 생성에 실패했습니다.");
    return;
  }

  // pay.html의 위치 기준으로 URL 생성
  const payBase = location.href.replace(/\/[^/]*$/, "/pay.html");
  const payUrl = `${payBase}?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(result.linkToken)}`;

  const dialog = document.querySelector("[data-admin-payment-link-dialog]");
  if (!dialog) return;
  const urlInput = dialog.querySelector("[data-payment-link-url]");
  if (urlInput) urlInput.value = payUrl;
  const orderField = dialog.querySelector("[data-payment-link-order]");
  const amountField = dialog.querySelector("[data-payment-link-amount]");
  const expiryField = dialog.querySelector("[data-payment-link-expiry]");
  if (orderField) orderField.textContent = `${order.product || "주문"} · ${order.customer || "고객"}`;
  if (amountField) amountField.textContent = formatWon(result.amount);
  if (expiryField) expiryField.textContent = result.expiresAt ? new Date(result.expiresAt).toLocaleString("ko-KR") : "생성 후 30분";
  if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

document.querySelector("[data-payment-link-close]")?.addEventListener("click", () => document.querySelector("[data-admin-payment-link-dialog]")?.close());
document.querySelector("[data-payment-link-copy]")?.addEventListener("click", async () => {
  const url = document.querySelector("[data-payment-link-url]")?.value || "";
  const copied = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
  setAdminFeedback(copied ? "결제 요청 링크를 복사했습니다." : "링크를 선택해 직접 복사해 주세요.");
  if (!copied) document.querySelector("[data-payment-link-url]")?.select();
});
document.querySelector("[data-payment-link-open]")?.addEventListener("click", () => {
  const url = document.querySelector("[data-payment-link-url]")?.value || "";
  if (url) window.open(url, "_blank", "noopener");
});

async function cancelAdminPayment(orderId, cancelReason, cancelAmount) {
  const result = await apiFetch(`/payments/${encodeURIComponent(orderId)}/cancel`, { method: "POST", body: { cancelReason, ...(cancelAmount ? { cancelAmount } : {}) } });
  if (!result || result.error) {
    AppUI.alert(result?.error || "결제 취소에 실패했습니다.");
    return;
  }
  await loadFromApi();
  renderAdminDashboard();
  setAdminFeedback(result.alreadyCanceled ? "이미 취소된 결제입니다." : "결제 취소 및 주문 상태 변경이 완료되었습니다.");
}

adminInventoryForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAdminInventory(new FormData(adminInventoryForm));
});

adminInventoryCancel?.addEventListener("click", () => {
  resetAdminInventoryForm();
  closeAdminFormDrawer("inventory");
});
adminInventorySample?.addEventListener("click", createSampleInventory);
adminRecipeReset?.addEventListener("click", resetRecipes);

adminRecipeForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  addRecipe(new FormData(adminRecipeForm));
});

adminSupplierForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveSupplier(new FormData(adminSupplierForm));
});

adminSupplierCancel?.addEventListener("click", () => {
  resetSupplierForm();
  closeAdminFormDrawer("supplier");
});

document.querySelector(".admin-supplier-list")?.addEventListener("click", async (event) => {
  const row = event.target.closest("tr[data-supplier-id]");
  if (!row) return;
  if (event.target.closest(".admin-supplier-edit")) {
    editSupplier(row.dataset.supplierId);
    return;
  }
  if (event.target.closest(".admin-supplier-delete")) {
    if (!await AppUI.confirm("공급처를 삭제할까요? 기존 발주 기록은 유지됩니다.")) return;
    writeSuppliers(readSuppliers().filter((supplier) => supplier.id !== row.dataset.supplierId));
    resetSupplierForm();
    renderAdminDashboard();
    setAdminFeedback("공급처를 삭제했습니다.");
  }
});

document.querySelector(".admin-inventory-list")?.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-inventory-id]");
  if (!row) return;

  if (event.target.closest(".admin-inventory-edit")) {
    editAdminInventory(row.dataset.inventoryId);
    return;
  }

  if (event.target.closest(".admin-inventory-purchase-hold")) {
    if (row.dataset.purchaseOrderId) togglePurchaseOrderHold(row.dataset.purchaseOrderId);
    else togglePurchaseCandidateHold(row.dataset.inventoryId);
    return;
  }

  if (event.target.closest(".admin-purchase-request")) {
    openPurchaseRequestDialog(row.dataset.inventoryId, Number(row.dataset.purchaseAmount || 0));
    return;
  }

  if (event.target.closest(".admin-inventory-delete")) {
    deleteAdminInventory(row.dataset.inventoryId);
  }
});

document.querySelector(".admin-inventory-list")?.addEventListener("change", async (event) => {
  if (!event.target.classList.contains("admin-purchase-status")) return;
  const row = event.target.closest("tr[data-inventory-id]");
  if (!row?.dataset.purchaseOrderId) return;
  if (event.target.value === "입고완료" && !await AppUI.confirm("입고완료 처리하고 현재 재고에 수량을 반영할까요?")) {
    renderAdminInventory();
    return;
  }
  updatePurchaseOrderStatus(row.dataset.purchaseOrderId, event.target.value);
});

function openPurchaseRequestDialog(itemId, amount) {
  const item = readInventory().find((current) => current.id === itemId);
  const dialog = document.querySelector("[data-purchase-request-dialog]");
  const form = document.querySelector("[data-purchase-request-form]");
  if (!item || !dialog || !form) return;
  form.reset();
  form.elements.namedItem("itemId").value = item.id;
  form.elements.namedItem("amount").value = Number(amount || getRecommendedPurchaseQuantity(item) || 1);
  document.querySelector("[data-purchase-request-item-name]").textContent = item.name;
  document.querySelector("[data-purchase-request-stock]").textContent = `현재 ${formatMaterialAmount(item.stock)}${item.unit} · 안전 재고 ${formatMaterialAmount(item.safeStock)}${item.unit}`;
  document.querySelector("[data-purchase-request-unit]").textContent = item.unit;
  document.querySelector("[data-purchase-request-total]").textContent = "0원";
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

document.querySelector(".admin-purchase-list")?.addEventListener("click", async (event) => {
  const row = event.target.closest("tr[data-purchase-id]");
  if (!row) return;
  if (event.target.closest(".admin-purchase-candidate-edit")) {
    editAdminInventory(row.dataset.purchaseId);
    return;
  }
  if (event.target.closest(".admin-purchase-candidate-delete")) {
    deleteAdminInventory(row.dataset.purchaseId);
    return;
  }
  if (event.target.closest(".admin-purchase-candidate-hold")) {
    togglePurchaseCandidateHold(row.dataset.purchaseId);
    return;
  }
  const button = event.target.closest(".admin-purchase-request");
  if (!button) return;
  const amount = Number(row?.dataset.purchaseAmount || 0);
  if (!row || amount <= 0) return;
  openPurchaseRequestDialog(row.dataset.purchaseId, amount);
});

document.querySelectorAll("[data-purchase-request-close]").forEach((button) => button.addEventListener("click", () => document.querySelector("[data-purchase-request-dialog]")?.close()));
document.querySelector("[data-inventory-usage-open]")?.addEventListener("click", () => {
  const dialog = document.querySelector("[data-inventory-usage-dialog]");
  renderInventoryLogs();
  if (typeof dialog?.showModal === "function") dialog.showModal();
  else dialog?.setAttribute("open", "");
});
document.querySelector("[data-inventory-usage-close]")?.addEventListener("click", () => document.querySelector("[data-inventory-usage-dialog]")?.close());
document.querySelector("[data-inventory-usage-dialog]")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelector("[data-purchase-request-form]")?.addEventListener("input", (event) => {
  if (!event.target.matches('[name="amount"], [name="unitCost"]')) return;
  const form = event.currentTarget;
  const total = Number(form.elements.namedItem("amount").value || 0) * Number(form.elements.namedItem("unitCost").value || 0);
  document.querySelector("[data-purchase-request-total]").textContent = formatWon(total);
});
document.querySelector("[data-purchase-request-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  createPurchaseOrder(form.elements.namedItem("itemId").value, Number(form.elements.namedItem("amount").value || 0), {
    supplier: form.elements.namedItem("supplier").value,
    unitCost: Number(form.elements.namedItem("unitCost").value || 0),
  });
  document.querySelector("[data-purchase-request-dialog]")?.close();
});

document.querySelector(".admin-purchase-order-list")?.addEventListener("change", async (event) => {
  const row = event.target.closest("tr[data-purchase-order-id]");
  if (!row) return;

  if (event.target.classList.contains("admin-purchase-status")) {
    if (event.target.value === "입고완료" && !await AppUI.confirm("입고완료 처리하고 현재 재고에 수량을 반영할까요?")) {
      renderPurchaseOrders();
      return;
    }
    updatePurchaseOrderStatus(row.dataset.purchaseOrderId, event.target.value);
  }
});

document.querySelector(".admin-purchase-order-list")?.addEventListener("click", async (event) => {
  const holdButton = event.target.closest(".admin-purchase-hold");
  if (holdButton) {
    const row = holdButton.closest("tr[data-purchase-order-id]");
    if (row) togglePurchaseOrderHold(row.dataset.purchaseOrderId);
    return;
  }
  const repeatButton = event.target.closest(".admin-purchase-repeat");
  if (repeatButton) {
    openPurchaseRequestDialog(repeatButton.dataset.purchaseItemId, Number(repeatButton.dataset.purchaseAmount || 0));
    return;
  }
  const editButton = event.target.closest(".admin-purchase-edit");
  if (editButton) {
    const row = editButton.closest("tr[data-purchase-order-id]");
    if (!row) return;
    if (!row.classList.contains("is-editing")) {
      row.classList.add("is-editing");
      editButton.textContent = "저장";
      row.querySelector(".admin-purchase-supplier")?.focus();
      return;
    }
    updatePurchaseOrderDetails(row.dataset.purchaseOrderId, {
      supplier: row.querySelector(".admin-purchase-supplier")?.value.trim() || "",
      unitCost: Number(row.querySelector(".admin-purchase-unit-cost")?.value || 0),
    });
    return;
  }
  const button = event.target.closest(".admin-purchase-delete");
  if (!button) return;
  const row = button.closest("tr[data-purchase-order-id]");
  if (!row || !await AppUI.confirm("이 발주 기록을 삭제할까요?")) return;
  writePurchaseOrders(readPurchaseOrders().filter((order) => order.id !== row.dataset.purchaseOrderId));
  renderAdminDashboard();
  setAdminFeedback("발주 기록을 삭제했습니다.");
});

document.querySelector(".admin-recipe-list")?.addEventListener("click", async (event) => {
  const row = event.target.closest("tr[data-recipe-index]");
  if (!row) return;

  if (event.target.closest(".admin-recipe-save")) {
    saveRecipeRow(row);
    return;
  }

  if (event.target.closest(".admin-recipe-delete")) {
    if (!await AppUI.confirm("원재료 배합 기준을 삭제할까요?")) return;
    deleteRecipe(row.dataset.recipeIndex);
  }
});

document.querySelector(".admin-sidebar-nav")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-tab]");
  if (!button) return;
  setAdminTab(button.dataset.adminTab);
});

document.querySelector(".admin-sidebar-alerts")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-flow-tab]");
  if (!button) return;
  setAdminTab(button.dataset.adminFlowTab);
  if (button.dataset.alertType === "purchases") setAdminSubtab("inventory", "purchases");
  if (button.dataset.alertType === "inventory") setAdminSubtab("inventory", "stock");
});

document.querySelector(".admin-main")?.addEventListener("click", (event) => {
  const formOpen = event.target.closest("[data-admin-form-open]");
  if (formOpen) {
    resetAndOpenAdminFormDrawer(formOpen.dataset.adminFormOpen);
    return;
  }

  if (event.target.closest("[data-admin-form-close]")) {
    const drawer = event.target.closest("[data-admin-form-drawer]");
    if (drawer?.dataset.adminFormDrawer === "customer") resetAdminCustomerForm();
    if (drawer?.dataset.adminFormDrawer === "inventory") resetAdminInventoryForm();
    if (drawer?.dataset.adminFormDrawer === "supplier") resetSupplierForm();
    closeAdminFormDrawer(drawer?.dataset.adminFormDrawer || "");
    return;
  }

  const subtab = event.target.closest("button[data-admin-subtab][data-admin-subtab-group]");
  if (subtab) {
    setAdminSubtab(subtab.dataset.adminSubtabGroup, subtab.dataset.adminSubtab);
    return;
  }

  handleAdminTableSort(event.target.closest("th"));
});

adminFormDrawerBackdrop?.addEventListener("click", () => closeAdminFormDrawer());

document.querySelector(".admin-main")?.addEventListener("keydown", (event) => {
  const subtab = event.target.closest("button[data-admin-subtab][data-admin-subtab-group]");
  if (subtab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll(
      `[data-admin-subtab-group="${subtab.dataset.adminSubtabGroup}"][data-admin-subtab]`,
    )];
    const currentIndex = tabs.indexOf(subtab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    setAdminSubtab(nextTab.dataset.adminSubtabGroup, nextTab.dataset.adminSubtab, { focus: true });
    return;
  }

  const header = event.target.closest("th.admin-sortable-header");
  if (header && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    handleAdminTableSort(header);
  }
});

document.querySelector(".admin-overflow-menu")?.addEventListener("click", (event) => {
  const details = event.target.closest(".admin-overflow-menu");
  const clickedBtn = event.target.closest("button");
  if (details && clickedBtn && !clickedBtn.closest("summary")) {
    setTimeout(() => { details.open = false; }, 120);
  }
});

document.addEventListener("click", (event) => {
  document.querySelectorAll(".admin-overflow-menu[open]").forEach((details) => {
    if (!details.contains(event.target)) details.open = false;
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    document.querySelectorAll(".admin-overflow-menu[open]").forEach((details) => { details.open = false; });
    closeAdminFormDrawer();
    closeProductDetail();
    closeOrderRequest();
    closeAdminOrderCreate();
  }
});

updateMenuList();
renderAdminDashboard();
initAdminProductionCalendar();
initAdminSubtabs();
initAdminTableSorting();
setAdminTab("orders");

if (document.querySelector(".admin-sidebar-nav")) {
  // 이미 로그인된 상태라면 API에서 최신 데이터를 불러와 갱신
  if (hasAdminAccess() && getApiToken()) {
    loadFromApi().then(() => renderAdminDashboard());
  }

  requestNotificationPermission().then(() => {
    sendPickupAlerts();
    sendLowStockAlerts();
  });
  setInterval(() => {
    sendPickupAlerts();
    sendLowStockAlerts();
  }, 10 * 60 * 1000);
}

// 제출 버튼을 잠그고(중복 제출 방지) 비동기 작업을 실행한 뒤 복구하는 공통 헬퍼.
// action()이 true를 반환하면(성공 후 리다이렉트 대기 등) 버튼을 계속 비활성 상태로 둔다.
