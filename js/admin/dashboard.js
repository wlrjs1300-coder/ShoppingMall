const adminOrderCreateOpen = document.querySelector(".admin-order-create-open");
const adminOrderCreatePanel = document.querySelector(".admin-order-create-panel");
const adminOrderCreateBackdrop = document.querySelector(".admin-order-create-backdrop");
const adminOrderCreateClose = document.querySelector(".admin-order-create-close");
const adminOrderCreateForm = document.querySelector(".admin-order-create-form");
const adminOrderCreateStatus = document.querySelector(".admin-order-create-status");
const adminOrderCreateTitle = document.querySelector(".admin-order-create-panel h2");
const adminOrderCreateLead = document.querySelector(".admin-order-create-panel .order-request-lead");
const adminOrderCreateSubmit = document.querySelector(".admin-order-create-form .primary-button");
const adminDemoData = document.querySelector(".admin-demo-data");
const adminCsvData = document.querySelector(".admin-csv-data");
const adminExportData = document.querySelector(".admin-export-data");
const adminImportData = document.querySelector(".admin-import-data");
const adminImportInput = document.querySelector(".admin-import-input");
const adminFeedback = document.querySelector(".admin-feedback");
const adminLock = document.querySelector("[data-admin-lock]");
const adminLockForm = document.querySelector("[data-admin-lock-form]");
const adminLockMessage = document.querySelector(".admin-lock-message");
const adminLockout = document.querySelector(".admin-lockout");
const adminCustomerForm = document.querySelector(".admin-customer-form");
const adminCustomerSubmit = document.querySelector(".admin-customer-submit");
const adminCustomerCancel = document.querySelector(".admin-customer-cancel");
const adminProductionDateFilter = document.querySelector(".admin-production-date-filter");
const selectedAdminProductionOrderIds = new Set();
const adminInventoryForm = document.querySelector(".admin-inventory-form");
const adminInventorySubmit = document.querySelector(".admin-inventory-submit");
const adminInventoryCancel = document.querySelector(".admin-inventory-cancel");
const adminInventorySample = document.querySelector(".admin-inventory-sample");
const adminRecipeForm = document.querySelector(".admin-recipe-form");
const adminRecipeReset = document.querySelector(".admin-recipe-reset");
const adminSupplierForm = document.querySelector(".admin-supplier-form");
const adminSupplierSubmit = document.querySelector(".admin-supplier-submit");
const adminSupplierCancel = document.querySelector(".admin-supplier-cancel");
const adminLogisticsDateFilter = document.querySelector(".admin-logistics-date-filter");
const adminLogisticsSearchInput = document.querySelector(".admin-logistics-search-input");
const adminLogisticsReset = document.querySelector(".admin-logistics-reset");
const adminAccountingStart = document.querySelector(".admin-accounting-start");
const adminAccountingEnd = document.querySelector(".admin-accounting-end");
const adminAccountingReset = document.querySelector(".admin-accounting-reset");
const adminAccountingCsv = document.querySelector(".admin-accounting-csv");
const adminFormDrawerBackdrop = document.querySelector(".admin-form-drawer-backdrop");
const adminAccessCode = "";
const adminAccessStorageKey = "tteokAdminAccess";
let editingAdminOrderId = "";
let adminFeedbackTimer = 0;
let activeDetailItem = null;
let activeOrderItem = null;

const adminFormDrawerLabels = {
  customer: "고객",
  inventory: "재고",
  supplier: "공급처",
};

function closeAdminFormDrawer(drawerName = "") {
  document.querySelectorAll("[data-admin-form-drawer]").forEach((drawer) => {
    if (drawerName && drawer.dataset.adminFormDrawer !== drawerName) return;
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
  });
  if (!document.querySelector("[data-admin-form-drawer].is-open")) {
    if (adminFormDrawerBackdrop) adminFormDrawerBackdrop.hidden = true;
    document.body.classList.remove("is-admin-drawer-open");
  }
}

function openAdminFormDrawer(drawerName, { editing = false } = {}) {
  const drawer = document.querySelector(`[data-admin-form-drawer="${drawerName}"]`);
  if (!drawer) return;
  closeAdminFormDrawer();
  const title = drawer.querySelector("[data-admin-form-title]");
  if (title) title.textContent = `${adminFormDrawerLabels[drawerName] || "항목"} ${editing ? "수정" : "등록"}`;
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  if (adminFormDrawerBackdrop) adminFormDrawerBackdrop.hidden = false;
  document.body.classList.add("is-admin-drawer-open");
  requestAnimationFrame(() => drawer.querySelector("input:not([type='hidden']), select, textarea")?.focus());
}

function resetAndOpenAdminFormDrawer(drawerName) {
  if (drawerName === "customer") resetAdminCustomerForm();
  if (drawerName === "inventory") resetAdminInventoryForm();
  if (drawerName === "supplier") resetSupplierForm();
  openAdminFormDrawer(drawerName);
}

const defaultInventoryRecipeRules = [
  { keywords: ["송편", "꿀떡", "쑥절편", "흰절편", "가래떡"], materials: [{ name: "멥쌀가루", unit: "kg", amount: 0.08 }] },
  { keywords: ["백일", "수수팥"], materials: [{ name: "멥쌀가루", unit: "kg", amount: 0.08 }, { name: "팥앙금", unit: "kg", amount: 0.04 }] },
  { keywords: ["답례", "단체"], materials: [{ name: "멥쌀가루", unit: "kg", amount: 0.06 }, { name: "개별 포장지", unit: "장", amount: 1 }] },
  { keywords: ["찰떡", "인절미"], materials: [{ name: "찹쌀가루", unit: "kg", amount: 0.08 }] },
  { keywords: ["모듬", "선물"], materials: [{ name: "멥쌀가루", unit: "kg", amount: 0.05 }, { name: "찹쌀가루", unit: "kg", amount: 0.05 }, { name: "개별 포장지", unit: "장", amount: 1 }] },
];

if (adminDemoData) {
  const isDevMode = new URLSearchParams(window.location.search).get("dev") === "1";
  adminDemoData.hidden = !isDevMode;
}

function getProductInfo(card) {
  const button = card.querySelector(".add-interest");
  const image = card.querySelector(".food-card-image");
  const backgroundImage = image ? getComputedStyle(image).backgroundImage : "";
  const imageUrl = image?.querySelector("img")?.getAttribute("src") || backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || "";
  const unitPrice = Number(card.dataset.price || 0);
  const purchaseType = card.dataset.purchaseType || (unitPrice > 0 ? "direct" : "consultation");
  return {
    id: card.dataset.productId || button?.dataset.name || "",
    name: button?.dataset.name || card.dataset.name || card.querySelector("h3")?.textContent.trim() || "",
    price: card.querySelector("strong")?.textContent.trim() || "상담 후 안내",
    unitPrice,
    purchaseType,
    category: card.querySelector(".food-badge")?.textContent.trim() || "MENU DETAIL",
    desc: card.querySelector("p")?.textContent.trim() || "필요한 일정과 수량에 맞춰 상담해 드립니다.",
    imageUrl,
  };
}

function openProductDetail(item) {
  activeDetailItem = item;
  if (productDetailCategory) productDetailCategory.textContent = item.category;
  if (productDetailName) productDetailName.textContent = item.name;
  if (productDetailDesc) productDetailDesc.textContent = item.desc;
  if (productDetailPrice) productDetailPrice.textContent = item.price;
  if (productDetailAdd) productDetailAdd.textContent = parseWon(item.price) > 0 ? "장바구니 담기" : "문의하기";
  productDetailPanel?.classList.add("is-open");
  productDetailPanel?.setAttribute("aria-hidden", "false");
  if (productDetailBackdrop) productDetailBackdrop.hidden = false;
}

function closeProductDetail() {
  productDetailPanel?.classList.remove("is-open");
  productDetailPanel?.setAttribute("aria-hidden", "true");
  if (productDetailBackdrop) productDetailBackdrop.hidden = true;
}

function openOrderRequest(item) {
  activeOrderItem = item;
  if (orderRequestForm) {
    orderRequestForm.productId.value = item.id || "";
    orderRequestForm.displayProduct.value = item.price ? `${item.name} / ${item.price}` : item.name || "";
    orderRequestForm.quantity.value = "1";
    if (orderFulfillmentSelect) orderFulfillmentSelect.value = "pickup";
    updateOrderFulfillmentFields();
    if (orderRequestStatus) orderRequestStatus.textContent = "";
    const submitButton = orderRequestForm.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = false;
  }
  orderRequestPanel?.classList.add("is-open");
  orderRequestPanel?.setAttribute("aria-hidden", "false");
  if (orderRequestBackdrop) orderRequestBackdrop.hidden = false;
}

function closeOrderRequest() {
  orderRequestPanel?.classList.remove("is-open");
  orderRequestPanel?.setAttribute("aria-hidden", "true");
  if (orderRequestBackdrop) orderRequestBackdrop.hidden = true;
}

function updateOrderFulfillmentFields() {
  const isDelivery = orderFulfillmentSelect?.value === "delivery";
  orderDeliveryAddressField?.classList.toggle("is-required", Boolean(isDelivery));
  if (orderDeliveryAddressInput) {
    orderDeliveryAddressInput.required = Boolean(isDelivery);
    orderDeliveryAddressInput.placeholder = isDelivery ? "배송 받을 주소를 입력해 주세요" : "배송 필요 시 입력";
    if (!isDelivery) orderDeliveryAddressInput.value = "";
  }
}

function openAdminOrderCreate(order = null) {
  editingAdminOrderId = order?.id || "";
  if (adminOrderCreateForm) {
    adminOrderCreateForm.reset();
    adminOrderCreateForm.product.value = order?.product || "";
    adminOrderCreateForm.quantity.value = String(order?.quantity || 1);
    adminOrderCreateForm.unitPrice.value = Number(order?.unitPrice) > 0
      ? order.unitPrice
      : (order?.revenue && order?.quantity ? Math.round(Number(order.revenue) / Number(order.quantity || 1)) : "");
    adminOrderCreateForm.cost.value = order?.cost || "";
    adminOrderCreateForm.pickupDate.value = order?.pickupDate || "";
    adminOrderCreateForm.pickupTime.value = order?.pickupTime || "";
    adminOrderCreateForm.fulfillmentType.value = order?.fulfillmentType || "pickup";
    adminOrderCreateForm.logisticsStatus.value = order?.logisticsStatus || getDefaultLogisticsStatus(order?.fulfillmentType || "pickup");
    adminOrderCreateForm.deliveryAddress.value = order?.deliveryAddress || "";
    adminOrderCreateForm.customer.value = order?.customer || "";
    adminOrderCreateForm.phone.value = order?.phone || "";
    adminOrderCreateForm.memo.value = order?.memo || "";
    if (adminOrderCreateStatus) adminOrderCreateStatus.textContent = "";
  }
  if (adminOrderCreateTitle) adminOrderCreateTitle.textContent = editingAdminOrderId ? "주문 수정" : "주문 직접 등록";
  if (adminOrderCreateLead) {
    adminOrderCreateLead.textContent = editingAdminOrderId
      ? "접수된 주문 내용을 수정합니다."
      : "전화나 매장에서 받은 주문을 바로 등록합니다.";
  }
  if (adminOrderCreateSubmit) adminOrderCreateSubmit.textContent = editingAdminOrderId ? "수정 저장" : "주문 저장";
  adminOrderCreatePanel?.classList.add("is-open");
  adminOrderCreatePanel?.setAttribute("aria-hidden", "false");
  if (adminOrderCreateBackdrop) adminOrderCreateBackdrop.hidden = false;
}

function closeAdminOrderCreate() {
  editingAdminOrderId = "";
  adminOrderCreatePanel?.classList.remove("is-open");
  adminOrderCreatePanel?.setAttribute("aria-hidden", "true");
  if (adminOrderCreateBackdrop) adminOrderCreateBackdrop.hidden = true;
}

function printOrderReceipt(orderId) {
  const order = readOrders().find((o) => o.id === orderId);
  if (!order) return;

  const pickup = [order.pickupDate, order.pickupTime].filter(Boolean).join(" ");
  const fulfillment = getFulfillmentLabel(order.fulfillmentType);
  const created = new Date(order.createdAt).toLocaleDateString("ko-KR");
  const issued = new Date().toLocaleDateString("ko-KR");
  const priceDisplay = order.priceText || formatWon(Number(order.revenue || 0));

  const rows = [
    ["주문번호", escapeHtml(order.id)],
    ["접수일", created],
    ["고객명", escapeHtml(order.customer || "-")],
    ["연락처", escapeHtml(order.phone || "-")],
    ["상품", escapeHtml(order.product || "-")],
    ["수량", `${Number(order.quantity || 1)}개`],
    ["수령방법", `${fulfillment}${pickup ? " — " + escapeHtml(pickup) : ""}`],
    order.deliveryAddress ? ["배송지", escapeHtml(order.deliveryAddress)] : null,
    order.memo ? ["메모", escapeHtml(order.memo)] : null,
    ["상태", escapeHtml(order.status || "접수대기")],
  ]
    .filter(Boolean)
    .map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>주문확인서</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Malgun Gothic', sans-serif; font-size: 14px; padding: 32px; max-width: 420px; margin: 0 auto; color: #111; }
  h1 { font-size: 20px; text-align: center; letter-spacing: 2px; margin-bottom: 4px; }
  .issued { text-align: center; font-size: 12px; color: #777; margin-bottom: 20px; }
  hr { border: none; border-top: 1px dashed #bbb; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; width: 80px; padding: 5px 0; color: #555; font-weight: normal; vertical-align: top; }
  td { padding: 5px 0; line-height: 1.5; }
  .price-row th { font-size: 15px; font-weight: bold; color: #111; padding-top: 2px; }
  .price-row td { font-size: 18px; font-weight: bold; }
  .footer { text-align: center; margin-top: 24px; font-size: 12px; color: #aaa; }
  @media print { body { padding: 16px; } }
</style>
</head>
<body>
<h1>주문 확인서</h1>
<p class="issued">발행일: ${issued}</p>
<hr>
<table>${rows}</table>
<hr>
<table><tr class="price-row"><th>금액</th><td>${escapeHtml(priceDisplay)}</td></tr></table>
<hr>
<p class="footer">감사합니다.</p>
</body>
</html>`;

  const win = window.open("", "_blank", "width=500,height=640");
  if (!win) {
    setAdminFeedback("팝업이 차단되어 있습니다. 브라우저에서 팝업을 허용한 후 다시 시도해 주세요.");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

function printProductionSheet(orderIds, type = "production") {
  const source = readOrders().filter((order) => orderIds.includes(order.id));
  const orders = type === "pickup" ? source.filter((order) => order.fulfillmentType !== "delivery") : type === "delivery" ? source.filter((order) => order.fulfillmentType === "delivery") : source;
  if (!orders.length) return AppUI.alert("출력할 주문을 선택해 주세요.");
  const title = type === "pickup" ? "픽업 확인서" : type === "delivery" ? "배송 목록" : "떡 제작지시서";
  const rows = orders.map((order) => `<tr><td>${escapeHtml(getAdminOrderNumber(order))}</td><td>${escapeHtml(order.pickupDate || "-")} ${escapeHtml(order.pickupTime || "")}</td><td>${escapeHtml(order.product || "-")}</td><td>${Number(order.quantity || 0)}개</td><td>${escapeHtml(order.customer || "-")}</td><td>${escapeHtml(order.memo || "-")}</td></tr>`).join("");
  const popup = window.open("", "_blank", "width=1000,height=720");
  if (!popup) return AppUI.alert("팝업 차단을 해제한 뒤 다시 시도해 주세요.");
  popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:'Malgun Gothic',sans-serif;padding:28px}h1{font-size:24px}p{color:#666}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #bbb;padding:10px;text-align:left}th{background:#f7f2f3}@media print{button{display:none}}</style></head><body><h1>${title}</h1><p>출력 ${new Date().toLocaleString("ko-KR")} · 총 ${orders.length}건</p><table><thead><tr><th>주문번호</th><th>수령일</th><th>상품</th><th>수량</th><th>고객</th><th>요청사항</th></tr></thead><tbody>${rows}</tbody></table><button onclick="window.print()">인쇄</button></body></html>`);
  popup.document.close();
}

function setAdminFeedback(message) {
  if (!adminFeedback || !message) return;
  window.clearTimeout(adminFeedbackTimer);
  const needsAttention = /(없습니다|필수|확인|다시|늦습니다|부족|차단|실패|선택해)/.test(message);
  const title = adminFeedback.querySelector(".admin-feedback-copy strong");
  const messageNode = adminFeedback.querySelector("[data-admin-feedback-message]");
  adminFeedback.classList.remove("is-visible");
  adminFeedback.dataset.tone = needsAttention ? "notice" : "success";
  if (title) title.textContent = needsAttention ? "확인해 주세요" : "처리 완료";
  if (messageNode) messageNode.textContent = message;
  requestAnimationFrame(() => adminFeedback.classList.add("is-visible"));
  adminFeedbackTimer = window.setTimeout(() => {
    adminFeedback.classList.remove("is-visible");
  }, 2400);
}

function unlockAdmin() {
  adminLock?.classList.remove("is-checking");
  adminLock?.classList.add("is-unlocked");
  adminLock?.setAttribute("aria-hidden", "true");
  adminLock?.setAttribute("aria-busy", "false");
}

function showAdminLoginRequired() {
  adminLock?.classList.remove("is-checking");
  adminLock?.setAttribute("aria-busy", "false");
}

function lockAdmin() {
  try {
    sessionStorage.removeItem(adminAccessStorageKey);
    setApiToken(null);
  } catch {
    // Session storage can be unavailable in some browser privacy modes.
  }
  if (adminLockMessage) adminLockMessage.textContent = "관리자 화면을 잠갔습니다.";
  adminLockForm?.reset();
  adminLock?.classList.remove("is-unlocked");
  adminLock?.classList.remove("is-checking");
  adminLock?.setAttribute("aria-hidden", "false");
  adminLock?.setAttribute("aria-busy", "false");
  adminLockForm?.querySelector("input")?.focus();
}

function hasAdminAccess() {
  try {
    return sessionStorage.getItem(adminAccessStorageKey) === "granted";
  } catch {
    return false;
  }
}

function grantAdminAccess() {
  try {
    sessionStorage.setItem(adminAccessStorageKey, "granted");
  } catch {
    // Session storage can be unavailable in some browser privacy modes.
  }
}

async function bootstrapMemberAdminAccess() {
  try {
    const response = await fetch("/api/users/admin-session", { method: "POST", credentials: "same-origin" });
    if (!response.ok) {
      if (hasAdminAccess() && getApiToken()) unlockAdmin();
      else {
        showAdminLoginRequired();
        if (adminLockMessage) adminLockMessage.textContent = response.status === 403
          ? "현재 계정에는 관리자 권한이 없습니다."
          : "관리자 계정으로 로그인해 주세요.";
      }
      return;
    }
    const result = await response.json();
    if (!result.token) {
      showAdminLoginRequired();
      return;
    }
    setApiToken(result.token);
    grantAdminAccess();
    unlockAdmin();
    await loadFromApi();
    renderAdminDashboard();
  } catch {
    if (hasAdminAccess() && getApiToken()) unlockAdmin();
    else {
      showAdminLoginRequired();
      if (adminLockMessage) adminLockMessage.textContent = "관리자 로그인 정보를 확인하지 못했습니다.";
    }
  }
}

if (adminLock) bootstrapMemberAdminAccess();

adminLockForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = String(new FormData(adminLockForm).get("code") || "").trim();
  if (!code) return;

  // 서버가 살아있으면 API로 검증, 오프라인이면 로컬 코드로 폴백
  const result = await apiFetch("/auth/login", { method: "POST", body: { code } });
  if (result === null) {
    // 서버 오프라인 — 로컬 코드로 폴백
    if (code !== adminAccessCode) {
      if (adminLockMessage) adminLockMessage.textContent = "확인 코드가 맞지 않습니다.";
      return;
    }
  } else if (!result.token) {
    if (adminLockMessage) adminLockMessage.textContent = "확인 코드가 맞지 않습니다.";
    return;
  } else {
    setApiToken(result.token);
    await loadFromApi();
  }

  grantAdminAccess();
  unlockAdmin();
  renderAdminDashboard();
  setAdminFeedback("관리자 화면을 열었습니다.");
});

adminLockout?.addEventListener("click", () => {
  lockAdmin();
  fetch("/api/users/logout", { method: "POST", credentials: "same-origin" }).finally(() => {
    setAdminFeedback("로그아웃되었습니다. 메인 화면으로 이동합니다.");
    window.setTimeout(() => { window.location.replace("index.html"); }, 900);
  });
});

function getFilteredAdminOrders(orders = readOrders()) {
  const searchInput = document.querySelector(".admin-search-input");
  const statusFilter = document.querySelector(".admin-status-filter");
  const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const selectedStatus = statusFilter ? statusFilter.value : "all";

  return orders.filter((order) => {
    const searchable = [
      order.customer,
      order.phone,
      order.product,
      order.memo,
      order.pickupDate,
      order.deliveryAddress,
      getFulfillmentLabel(order.fulfillmentType),
      order.logisticsStatus,
      order.status,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesQuery = !query || searchable.includes(query);
    const matchesStatus = selectedStatus === "all" || getUnifiedWorkflowStatus(order) === selectedStatus;
    return matchesQuery && matchesStatus;
  });
}

function handleProductCardClick(event) {
  const card = event.target.closest(".food-card");
  if (!card) return;
  const item = getProductInfo(card);
  const action = event.target.closest(".add-interest");
  if (action) {
    event.stopPropagation();
    if (item.purchaseType === "direct" && item.unitPrice > 0) {
      addToCart({ id: item.id, name: item.name, price: item.unitPrice, category: item.category, imageUrl: item.imageUrl });
    } else {
      openOrderRequest(item);
    }
    return;
  }
  if (!event.target.closest("button, a")) openProductDetail(item);
}

menuGrid?.addEventListener("click", handleProductCardClick);
featuredGrid?.addEventListener("click", handleProductCardClick);

productDetailAdd?.addEventListener("click", () => {
  if (!activeDetailItem?.name) return;
  if (activeDetailItem.purchaseType === "direct" && activeDetailItem.unitPrice > 0) {
    addToCart({
      id: activeDetailItem.id,
      name: activeDetailItem.name,
      price: activeDetailItem.unitPrice,
      category: activeDetailItem.category,
      imageUrl: activeDetailItem.imageUrl,
    });
    closeProductDetail();
    return;
  }
  closeProductDetail();
  openOrderRequest(activeDetailItem);
});

productDetailClose?.addEventListener("click", closeProductDetail);
productDetailBackdrop?.addEventListener("click", closeProductDetail);
orderRequestClose?.addEventListener("click", closeOrderRequest);
orderRequestBackdrop?.addEventListener("click", closeOrderRequest);
orderFulfillmentSelect?.addEventListener("change", updateOrderFulfillmentFields);
adminOrderCreateOpen?.addEventListener("click", () => openAdminOrderCreate());
adminOrderCreateClose?.addEventListener("click", closeAdminOrderCreate);
adminOrderCreateBackdrop?.addEventListener("click", closeAdminOrderCreate);

adminOrderCreateForm?.querySelector('[name="fulfillmentType"]')?.addEventListener("change", (event) => {
  const logisticsField = adminOrderCreateForm.querySelector('[name="logisticsStatus"]');
  if (logisticsField) logisticsField.value = getDefaultLogisticsStatus(event.target.value);
});

orderRequestForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(orderRequestForm);
  const quantity = Math.max(1, Math.floor(Number(formData.get("quantity") || 1)));
  const fulfillmentType = String(formData.get("fulfillmentType") || "pickup");
  const deliveryAddress = String(formData.get("deliveryAddress") || "").trim();

  if (fulfillmentType === "delivery" && !deliveryAddress) {
    if (orderRequestStatus) orderRequestStatus.textContent = "배송 상담을 선택하신 경우 배송 주소를 입력해 주세요.";
    return;
  }

  const submitButton = orderRequestForm.querySelector('[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  if (orderRequestStatus) orderRequestStatus.textContent = "주문 요청을 접수하고 있습니다.";

  const order = await apiFetch("/orders", {
    method: "POST",
    extraHeaders: { "Idempotency-Key": crypto.randomUUID ? crypto.randomUUID() : `order-request-${Date.now()}` },
    body: {
      productId: String(formData.get("productId") || activeOrderItem?.id || ""),
      quantity,
      pickupDate: String(formData.get("pickupDate") || ""),
      pickupTime: String(formData.get("pickupTime") || ""),
      fulfillmentType,
      deliveryAddress,
      customer: String(formData.get("customer") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      memo: String(formData.get("memo") || "").trim(),
    },
  });

  if (!order) {
    if (orderRequestStatus) orderRequestStatus.textContent = "주문 접수에 실패했습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요.";
    if (submitButton) submitButton.disabled = false;
    return;
  }

  localStorage.setItem(orderStorageKey, JSON.stringify([order, ...readOrders().filter((item) => item.id !== order.id)]));
  addActivityLog("주문", `${order.customer || "고객"}님의 ${order.product} 상담 요청이 접수되었습니다.`, "orders");
  orderRequestForm.reset();
  if (orderRequestStatus) orderRequestStatus.textContent = "문의가 접수되었습니다. 확인 후 연락드리겠습니다.";
  setTimeout(closeOrderRequest, 800);
  /*
  const legacyClientOrderShape = {
    // 가격·원가·상태·주문 ID를 브라우저에서 만들던 기존 방식은 보안상 사용하지 않습니다.
    quantity,
    productId: activeOrderItem?.id,
  };
  */
});

adminOrderCreateForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(adminOrderCreateForm);
  const product = String(formData.get("product") || "").trim();
  if (!product) {
    if (adminOrderCreateStatus) adminOrderCreateStatus.textContent = "상품명을 입력해 주세요.";
    return;
  }
  const quantity = Math.max(1, Math.floor(Number(formData.get("quantity") || 1)));
  const unitPrice = Number(formData.get("unitPrice") || 0);
  const revenue = unitPrice * quantity;
  const previousOrder = editingAdminOrderId ? readOrders().find((order) => order.id === editingAdminOrderId) : null;
  const fulfillmentType = String(formData.get("fulfillmentType") || "pickup");
  const order = {
    ...(previousOrder || {}),
    id: previousOrder?.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    createdAt: previousOrder?.createdAt || new Date().toISOString(),
    product,
    priceText: unitPrice ? formatWon(unitPrice) : "상담 후 안내",
    quantity,
    pickupDate: String(formData.get("pickupDate") || ""),
    pickupTime: String(formData.get("pickupTime") || ""),
    fulfillmentType,
    deliveryAddress: String(formData.get("deliveryAddress") || "").trim(),
    logisticsStatus: String(formData.get("logisticsStatus") || previousOrder?.logisticsStatus || getDefaultLogisticsStatus(fulfillmentType)),
    customer: String(formData.get("customer") || "").trim(),
    phone: String(formData.get("phone") || "").trim(),
    memo: String(formData.get("memo") || "").trim(),
    status: previousOrder?.status || "접수대기",
    unitPrice,
    revenue,
    cost: Number(formData.get("cost") || 0),
  };

  const nextOrders = previousOrder
    ? readOrders().map((current) => (current.id === previousOrder.id ? order : current))
    : [order, ...readOrders()];
  writeOrders(nextOrders);
  addActivityLog("주문", `${order.product} 주문을 ${previousOrder ? "수정" : "등록"}했습니다.`, "orders");
  renderAdminDashboard();
  setAdminTab("orders");
  if (adminOrderCreateStatus) adminOrderCreateStatus.textContent = previousOrder ? "주문이 수정되었습니다." : "주문이 등록되었습니다.";
  setAdminFeedback(previousOrder ? "주문 정보가 수정되었습니다." : "새 주문이 등록되었습니다.");
  setTimeout(closeAdminOrderCreate, 700);
});
