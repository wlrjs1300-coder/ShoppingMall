// 포트폴리오 시연용 예시 정보이며 실제 매장 상세 주소가 아닙니다.
const siteInfo = {
  phone: "031-000-0000",
  hours: "영업 중 · 19:00에 영업 종료",
  address: "경기도 화성시 소재",
  parking: "건물 내 주차 공간 이용 가능",
  storeUrl: "https://smartstore.naver.com/",
};

const phoneHref = `tel:${siteInfo.phone.replaceAll("-", "")}`;
const mapUrl = `https://map.naver.com/p/search/${encodeURIComponent(siteInfo.address)}`;
const orderStorageKey = "tteokOrders";
const customerNoteStorageKey = "tteokCustomerNotes";
const customerStorageKey = "tteokCustomers";
const inventoryStorageKey = "tteokInventory";
const recipeStorageKey = "tteokRecipes";
const inventoryLogStorageKey = "tteokInventoryLogs";
const purchaseOrderStorageKey = "tteokPurchaseOrders";
const supplierStorageKey = "tteokSuppliers";
const activityStorageKey = "tteokActivityLogs";
const notifiedOrdersStorageKey = "tteokNotifiedOrders";
const notifiedLowStockKey = "tteokNotifiedLowStock";
const apiTokenKey = "tteokApiToken";
const API_BASE = window.location.protocol === "file:"
  ? "http://localhost:3001/api"
  : `${window.location.origin}/api`;

function getApiToken() {
  try { return sessionStorage.getItem(apiTokenKey); } catch { return null; }
}

function setApiToken(token) {
  try {
    if (token) sessionStorage.setItem(apiTokenKey, token);
    else sessionStorage.removeItem(apiTokenKey);
  } catch {}
}

function showSessionExpiredToast() {
  if (document.getElementById("session-expired-toast")) return;
  const toast = document.createElement("div");
  toast.id = "session-expired-toast";
  toast.style.cssText =
    "position:fixed;top:20px;left:50%;transform:translateX(-50%);" +
    "background:#fff0f3;color:#c0445e;border:1px solid rgba(218,135,155,.5);" +
    "padding:12px 24px;border-radius:10px;font-size:0.9rem;font-weight:600;" +
    "z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.12);white-space:nowrap;";
  toast.textContent = "로그인 세션이 만료됐습니다. 다시 로그인해 주세요.";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const token = getApiToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      setApiToken(null);
      showSessionExpiredToast();
      return null;
    }
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function showApiErrorToast() {
  if (document.getElementById("api-error-toast")) return;
  const toast = document.createElement("div");
  toast.id = "api-error-toast";
  toast.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
    "background:#fff0f3;color:#c0445e;border:1px solid rgba(218,135,155,.5);" +
    "padding:10px 20px;border-radius:10px;font-size:0.84rem;z-index:99999;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.12);white-space:nowrap;";
  toast.textContent = "서버 연결 실패 — 변경 사항이 로컬에만 저장됩니다";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

async function syncArrayToApi(path, oldItems, newItems) {
  if (!getApiToken()) return;
  const oldMap = new Map(oldItems.map((item) => [item.id, item]));
  const newMap = new Map(newItems.map((item) => [item.id, item]));
  const promises = [];
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) promises.push(apiFetch(`${path}/${id}`, { method: "DELETE" }));
  }
  for (const [id, newItem] of newMap) {
    if (!oldMap.has(id)) {
      promises.push(apiFetch(path, { method: "POST", body: newItem }));
    } else if (JSON.stringify(oldMap.get(id)) !== JSON.stringify(newItem)) {
      promises.push(apiFetch(`${path}/${id}`, { method: "PUT", body: newItem }));
    }
  }
  if (promises.length === 0) return;
  const results = await Promise.all(promises);
  if (results.some((r) => r === null)) showApiErrorToast();
}

async function loadFromApi() {
  if (!getApiToken()) return;
  const [orders, customers, notes, inventory, recipes, purchaseOrders, suppliers, activityLogs, inventoryLogs] = await Promise.all([
    apiFetch("/orders"),
    apiFetch("/customers"),
    apiFetch("/customers/notes"),
    apiFetch("/inventory"),
    apiFetch("/recipes"),
    apiFetch("/purchase-orders"),
    apiFetch("/suppliers"),
    apiFetch("/activity-logs?limit=100"),
    apiFetch("/inventory/logs"),
  ]);
  if (Array.isArray(orders)) localStorage.setItem(orderStorageKey, JSON.stringify(orders));
  if (Array.isArray(customers)) localStorage.setItem(customerStorageKey, JSON.stringify(customers));
  if (notes && typeof notes === "object") localStorage.setItem(customerNoteStorageKey, JSON.stringify(notes));
  if (Array.isArray(inventory)) localStorage.setItem(inventoryStorageKey, JSON.stringify(inventory));
  if (Array.isArray(recipes) && recipes.length) {
    // 서버에서 받은 평탄 구조 {product, ingredient, amount, unit}를
    // 클라이언트 키워드 그룹 구조 {keywords, materials}로 변환
    if ("product" in (recipes[0] || {})) {
      const grouped = {};
      for (const row of recipes) {
        if (!grouped[row.product]) grouped[row.product] = [];
        grouped[row.product].push({ name: row.ingredient, amount: row.amount, unit: row.unit });
      }
      const converted = Object.entries(grouped).map(([kw, mats]) => ({ keywords: [kw], materials: mats }));
      localStorage.setItem(recipeStorageKey, JSON.stringify(converted));
    } else {
      localStorage.setItem(recipeStorageKey, JSON.stringify(recipes));
    }
  }
  if (Array.isArray(purchaseOrders)) localStorage.setItem(purchaseOrderStorageKey, JSON.stringify(purchaseOrders));
  if (Array.isArray(suppliers)) localStorage.setItem(supplierStorageKey, JSON.stringify(suppliers));
  if (Array.isArray(activityLogs)) localStorage.setItem(activityStorageKey, JSON.stringify(activityLogs));
  if (Array.isArray(inventoryLogs)) localStorage.setItem(inventoryLogStorageKey, JSON.stringify(inventoryLogs));
}

function readOrders() {
  try {
    return JSON.parse(localStorage.getItem(orderStorageKey) || "[]");
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  const old = readOrders();
  localStorage.setItem(orderStorageKey, JSON.stringify(orders));
  syncArrayToApi("/orders", old, orders);
}

function readCustomerNotes() {
  try {
    return JSON.parse(localStorage.getItem(customerNoteStorageKey) || "{}");
  } catch {
    return {};
  }
}

function writeCustomerNotes(notes) {
  const old = readCustomerNotes();
  localStorage.setItem(customerNoteStorageKey, JSON.stringify(notes));
  if (getApiToken()) {
    // 삭제된 메모 API에서도 제거
    Object.keys(old).forEach((key) => {
      if (!(key in notes)) {
        apiFetch(`/customers/notes/${encodeURIComponent(key)}`, { method: "DELETE" });
      }
    });
    // 변경된 메모 저장
    Object.entries(notes).forEach(([key, note]) => {
      if (old[key] !== note) {
        apiFetch(`/customers/notes/${encodeURIComponent(key)}`, { method: "PUT", body: { note } });
      }
    });
  }
}

function readCustomers() {
  try {
    return JSON.parse(localStorage.getItem(customerStorageKey) || "[]");
  } catch {
    return [];
  }
}

function writeCustomers(customers) {
  const old = readCustomers();
  localStorage.setItem(customerStorageKey, JSON.stringify(customers));
  syncArrayToApi("/customers", old, customers);
}

function readInventory() {
  try {
    return JSON.parse(localStorage.getItem(inventoryStorageKey) || "[]");
  } catch {
    return [];
  }
}

function writeInventory(items) {
  const old = readInventory();
  localStorage.setItem(inventoryStorageKey, JSON.stringify(items));
  syncArrayToApi("/inventory", old, items);
}

function readRecipes() {
  try {
    const saved = JSON.parse(localStorage.getItem(recipeStorageKey) || "null");
    return Array.isArray(saved) && saved.length ? saved : defaultInventoryRecipeRules;
  } catch {
    return defaultInventoryRecipeRules;
  }
}

function writeRecipes(recipes) {
  localStorage.setItem(recipeStorageKey, JSON.stringify(recipes));
  // 서버는 {product, ingredient, amount, unit} 평탄 구조를 사용
  // 클라이언트의 {keywords, materials} 그룹 구조를 평탄화해서 전송
  const flat = [];
  for (const rule of recipes) {
    for (const keyword of (rule.keywords || [])) {
      for (const mat of (rule.materials || [])) {
        flat.push({ product: keyword, ingredient: mat.name, amount: mat.amount, unit: mat.unit });
      }
    }
  }
  if (flat.length) apiFetch("/recipes", { method: "PUT", body: flat });
}

function readInventoryLogs() {
  try {
    return JSON.parse(localStorage.getItem(inventoryLogStorageKey) || "[]");
  } catch {
    return [];
  }
}

function writeInventoryLogs(logs) {
  const old = readInventoryLogs();
  localStorage.setItem(inventoryLogStorageKey, JSON.stringify(logs));
  if (getApiToken()) {
    if (!logs.length) {
      apiFetch("/inventory/logs", { method: "DELETE" });
    } else {
      const oldIds = new Set(old.map((l) => l.id));
      logs.filter((l) => !oldIds.has(l.id)).forEach((l) => apiFetch("/inventory/logs", { method: "POST", body: l }));
    }
  }
}

function readPurchaseOrders() {
  try {
    return JSON.parse(localStorage.getItem(purchaseOrderStorageKey) || "[]");
  } catch {
    return [];
  }
}

function writePurchaseOrders(orders) {
  const old = readPurchaseOrders();
  localStorage.setItem(purchaseOrderStorageKey, JSON.stringify(orders));
  syncArrayToApi("/purchase-orders", old, orders);
}

function readSuppliers() {
  try {
    return JSON.parse(localStorage.getItem(supplierStorageKey) || "[]");
  } catch {
    return [];
  }
}

function writeSuppliers(suppliers) {
  const old = readSuppliers();
  localStorage.setItem(supplierStorageKey, JSON.stringify(suppliers));
  syncArrayToApi("/suppliers", old, suppliers);
}

function readActivityLogs() {
  try {
    return JSON.parse(localStorage.getItem(activityStorageKey) || "[]");
  } catch {
    return [];
  }
}

function writeActivityLogs(logs) {
  const old = readActivityLogs();
  localStorage.setItem(activityStorageKey, JSON.stringify(logs));
  if (getApiToken()) {
    if (!logs.length) {
      apiFetch("/activity-logs", { method: "DELETE" });
    } else {
      const oldIds = new Set(old.map((l) => l.id));
      logs.filter((l) => !oldIds.has(l.id)).forEach((l) => apiFetch("/activity-logs", { method: "POST", body: l }));
    }
  }
}

function readNotifiedOrders() {
  try {
    return new Set(JSON.parse(localStorage.getItem(notifiedOrdersStorageKey) || "[]"));
  } catch {
    return new Set();
  }
}

function writeNotifiedOrders(notified, allOrders) {
  const existingIds = new Set(allOrders.map((o) => o.id));
  const cleaned = [...notified].filter((id) => existingIds.has(id));
  localStorage.setItem(notifiedOrdersStorageKey, JSON.stringify(cleaned));
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function sendPickupAlerts() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const orders = readOrders();
  const notified = readNotifiedOrders();
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const pending = orders.filter((order) => {
    if (!order.pickupDate) return false;
    if (notified.has(order.id)) return false;
    if (isTerminalStatus(order.status)) return false;
    return order.pickupDate === today || order.pickupDate === tomorrow;
  });

  pending.forEach((order) => {
    const isToday = order.pickupDate === today;
    const label = getFulfillmentLabel(order.fulfillmentType);
    const time = order.pickupTime ? ` ${order.pickupTime}` : "";
    const title = isToday ? `오늘 ${label} 주문` : `내일 ${label} 주문`;
    const body = `${order.customer || "고객"}님 · ${order.product || "상품 미입력"}${time}`;
    new Notification(title, { body });
    notified.add(order.id);
  });

  if (pending.length) writeNotifiedOrders(notified, orders);
}

function readNotifiedLowStock() {
  try {
    return new Set(JSON.parse(localStorage.getItem(notifiedLowStockKey) || "[]"));
  } catch {
    return new Set();
  }
}

function writeNotifiedLowStock(notified) {
  localStorage.setItem(notifiedLowStockKey, JSON.stringify([...notified]));
}

function clearLowStockNotified(itemId) {
  const notified = readNotifiedLowStock();
  notified.delete(itemId);
  writeNotifiedLowStock(notified);
}

function sendLowStockAlerts() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const inventory = readInventory();
  const notified = readNotifiedLowStock();

  const lowItems = inventory.filter((item) => {
    if (notified.has(item.id)) return false;
    const safe = Number(item.safeStock || 0);
    if (safe <= 0) return false;
    return Number(item.stock || 0) < safe;
  });

  lowItems.forEach((item) => {
    const body = `현재 ${formatMaterialAmount(Number(item.stock || 0))}${item.unit} — 기준 ${formatMaterialAmount(Number(item.safeStock || 0))}${item.unit}`;
    new Notification(`재고 부족: ${item.name}`, { body });
    notified.add(item.id);
  });

  if (lowItems.length) writeNotifiedLowStock(notified);
}

function addActivityLog(category, message, tab = "orders") {
  writeActivityLogs(
    [
      {
        id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        category,
        message,
        tab,
        createdAt: new Date().toISOString(),
      },
      ...readActivityLogs(),
    ].slice(0, 100),
  );
}

function parseWon(value) {
  const number = String(value || "").replace(/[^\d]/g, "");
  return Number(number || 0);
}

function formatWon(value) {
  return `${Number(value || 0).toLocaleString("ko-KR")}원`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getFulfillmentLabel(type) {
  return type === "delivery" ? "배송 상담" : "매장 픽업";
}

function getDefaultLogisticsStatus(type) {
  return type === "delivery" ? "배송대기" : "픽업대기";
}

function getTerminalStatus(fulfillmentType) {
  return fulfillmentType === "delivery" ? "배송완료" : "픽업완료";
}

function isTerminalStatus(status) {
  return status === "픽업완료" || status === "배송완료";
}

document.querySelectorAll(".js-phone-text").forEach((element) => {
  element.textContent = siteInfo.phone;
});

document.querySelectorAll(".js-phone-link").forEach((link) => {
  link.setAttribute("href", phoneHref);
});

document.querySelectorAll(".js-hours-text").forEach((element) => {
  element.textContent = siteInfo.hours;
});

document.querySelectorAll(".js-address-text").forEach((element) => {
  element.textContent = siteInfo.address;
});

document.querySelectorAll(".js-parking-text").forEach((element) => {
  element.textContent = siteInfo.parking;
});

document.querySelectorAll(".js-map-link").forEach((link) => {
  link.setAttribute("href", mapUrl);
});

document.querySelectorAll(".js-store-link").forEach((link) => {
  link.setAttribute("href", siteInfo.storeUrl);
});

const copyAddressButton = document.querySelector(".copy-address");
const addressCopyStatus = document.querySelector(".address-copy-status");

copyAddressButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(siteInfo.address);
    if (addressCopyStatus) addressCopyStatus.textContent = "주소를 복사했습니다.";
  } catch {
    if (addressCopyStatus) addressCopyStatus.textContent = siteInfo.address;
  }
});

const menuSearch = document.querySelector("#menuSearch");
const menuItems = [...document.querySelectorAll(".menu-item")];
const menuButtons = [...document.querySelectorAll(".menu-filters button, .menu-category-bar button")];
const menuEmpty = document.querySelector(".menu-empty");
const menuPagination = document.querySelector(".menu-pagination");
let activeMenuFilter = "all";
let activeMenuPage = 1;
const menuPageSize = 12;

function updateMenuList() {
  const query = (menuSearch?.value || "").trim().toLowerCase();
  const matchedItems = [];

  menuItems.forEach((item) => {
    const name = (item.dataset.name || "").toLowerCase();
    const category = item.dataset.category || "";
    const matchesQuery = !query || name.includes(query);
    const matchesFilter = activeMenuFilter === "all" || category === activeMenuFilter;
    const isVisible = matchesQuery && matchesFilter;

    if (isVisible) matchedItems.push(item);
    item.hidden = true;
  });

  const pageCount = Math.max(1, Math.ceil(matchedItems.length / menuPageSize));
  activeMenuPage = Math.min(activeMenuPage, pageCount);
  const startIndex = (activeMenuPage - 1) * menuPageSize;
  matchedItems.slice(startIndex, startIndex + menuPageSize).forEach((item) => {
    item.hidden = false;
  });

  menuItems.forEach((item) => {
    item.style.display = item.hidden ? "none" : "";
  });

  if (menuPagination) {
    menuPagination.innerHTML =
      matchedItems.length > menuPageSize
        ? Array.from({ length: pageCount }, (_, index) => {
            const page = index + 1;
            return `<button type="button" class="${page === activeMenuPage ? "is-active" : ""}" data-page="${page}" aria-label="${page}페이지">${page}</button>`;
          }).join("")
        : "";
  }

  if (menuEmpty) menuEmpty.hidden = matchedItems.length > 0;
}

menuSearch?.addEventListener("input", () => {
  activeMenuPage = 1;
  updateMenuList();
});

menuButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeMenuFilter = button.dataset.filter || "all";
    activeMenuPage = 1;
    menuButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    updateMenuList();
  });
});

menuPagination?.addEventListener("click", (event) => {
  const pageButton = event.target.closest("button[data-page]");
  if (!pageButton) return;
  activeMenuPage = Number(pageButton.dataset.page) || 1;
  updateMenuList();
});

const productDetailPanel = document.querySelector(".product-detail-panel");
const productDetailBackdrop = document.querySelector(".product-detail-backdrop");
const productDetailClose = document.querySelector(".product-detail-close");
const productDetailCategory = document.querySelector(".product-detail-category");
const productDetailName = document.querySelector(".product-detail-name");
const productDetailDesc = document.querySelector(".product-detail-desc");
const productDetailPrice = document.querySelector(".product-detail-price");
const productDetailAdd = document.querySelector(".product-detail-add");
const orderRequestPanel = document.querySelector(".order-request-panel:not(.admin-order-create-panel)");
const orderRequestBackdrop = document.querySelector(".order-request-backdrop:not(.admin-order-create-backdrop)");
const orderRequestClose = document.querySelector(".order-request-close");
const orderRequestForm = document.querySelector(".order-request-form:not(.admin-order-create-form)");
const orderRequestStatus = document.querySelector(".order-request-status:not(.admin-order-create-status)");
const orderFulfillmentSelect = orderRequestForm?.querySelector('select[name="fulfillmentType"]');
const orderDeliveryAddressField = orderRequestForm?.querySelector(".delivery-address-field");
const orderDeliveryAddressInput = orderRequestForm?.querySelector('input[name="deliveryAddress"]');
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
const adminProductionReset = document.querySelector(".admin-production-reset");
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
const adminLogisticsReset = document.querySelector(".admin-logistics-reset");
const adminAccountingStart = document.querySelector(".admin-accounting-start");
const adminAccountingEnd = document.querySelector(".admin-accounting-end");
const adminAccountingReset = document.querySelector(".admin-accounting-reset");
const adminAccountingCsv = document.querySelector(".admin-accounting-csv");
const adminAccessCode = "";
const adminAccessStorageKey = "tteokAdminAccess";
let editingAdminOrderId = "";
let adminFeedbackTimer = 0;
let activeDetailItem = null;
let activeOrderItem = null;

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
  return {
    name: button?.dataset.name || card.dataset.name || card.querySelector("h3")?.textContent.trim() || "",
    price: button?.dataset.price || card.dataset.price || card.querySelector("strong")?.textContent.trim() || "상담 후 안내",
    category: card.querySelector(".food-badge")?.textContent.trim() || "MENU DETAIL",
    desc: card.querySelector("p")?.textContent.trim() || "필요한 일정과 수량에 맞춰 상담해 드립니다.",
  };
}

function openProductDetail(item) {
  activeDetailItem = item;
  if (productDetailCategory) productDetailCategory.textContent = item.category;
  if (productDetailName) productDetailName.textContent = item.name;
  if (productDetailDesc) productDetailDesc.textContent = item.desc;
  if (productDetailPrice) productDetailPrice.textContent = item.price;
  if (productDetailAdd) productDetailAdd.textContent = "문의 남기기";
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
    orderRequestForm.product.value = item.name || "";
    orderRequestForm.price.value = item.price || "";
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

function setAdminFeedback(message) {
  if (!adminFeedback || !message) return;
  window.clearTimeout(adminFeedbackTimer);
  adminFeedback.textContent = message;
  adminFeedback.classList.add("is-visible");
  adminFeedbackTimer = window.setTimeout(() => {
    adminFeedback.classList.remove("is-visible");
  }, 3200);
}

function unlockAdmin() {
  adminLock?.classList.add("is-unlocked");
  adminLock?.setAttribute("aria-hidden", "true");
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
  adminLock?.setAttribute("aria-hidden", "false");
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

if (adminLock && hasAdminAccess()) {
  unlockAdmin();
}

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

adminLockout?.addEventListener("click", lockAdmin);

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
    const matchesStatus = selectedStatus === "all" || order.status === selectedStatus;
    return matchesQuery && matchesStatus;
  });
}

document.querySelectorAll(".add-interest").forEach((button) => {
  button.textContent = button.classList.contains("menu-add") ? "문의" : "문의 남기기";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openOrderRequest({
      name: button.dataset.name,
      price: button.dataset.price,
    });
  });
});

document.querySelectorAll(".food-card").forEach((card) => {
  card.addEventListener("click", (event) => {
    if (event.target.closest("button, a")) return;
    openProductDetail(getProductInfo(card));
  });
});

productDetailAdd?.addEventListener("click", () => {
  if (!activeDetailItem?.name) return;
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

orderRequestForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(orderRequestForm);
  const product = String(formData.get("product") || activeOrderItem?.name || "").trim();
  const priceText = String(formData.get("price") || activeOrderItem?.price || "").trim();
  const quantity = Math.max(1, Math.floor(Number(formData.get("quantity") || 1)));
  const unitPrice = parseWon(priceText);
  const fulfillmentType = String(formData.get("fulfillmentType") || "pickup");
  const deliveryAddress = String(formData.get("deliveryAddress") || "").trim();

  if (fulfillmentType === "delivery" && !deliveryAddress) {
    if (orderRequestStatus) orderRequestStatus.textContent = "배송 상담을 선택하신 경우 배송 주소를 입력해 주세요.";
    return;
  }

  const order = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    createdAt: new Date().toISOString(),
    product,
    priceText,
    quantity,
    pickupDate: String(formData.get("pickupDate") || ""),
    pickupTime: String(formData.get("pickupTime") || ""),
    fulfillmentType,
    deliveryAddress,
    logisticsStatus: getDefaultLogisticsStatus(fulfillmentType),
    customer: String(formData.get("customer") || "").trim(),
    phone: String(formData.get("phone") || "").trim(),
    memo: String(formData.get("memo") || "").trim(),
    status: "접수대기",
    unitPrice,
    revenue: unitPrice ? unitPrice * quantity : 0,
    cost: 0,
  };

  writeOrders([order, ...readOrders()]);
  addActivityLog("주문", `${order.customer || "고객"}님의 ${order.product} 상담 요청이 접수되었습니다.`, "orders");
  orderRequestForm.reset();
  if (orderRequestStatus) orderRequestStatus.textContent = "문의가 접수되었습니다. 확인 후 연락드리겠습니다.";
  const submitButton = orderRequestForm.querySelector('[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  setTimeout(closeOrderRequest, 800);
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

function renderAdminOrders() {
  const orderList = document.querySelector(".admin-order-list");
  if (!orderList) return;

  const orders = readOrders();
  const empty = document.querySelector(".admin-empty");
  const totalInfo = document.querySelector("[data-admin-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="orders"]');
  const stats = {
    orders: document.querySelector('[data-admin-stat="orders"]'),
    quantity: document.querySelector('[data-admin-stat="quantity"]'),
    revenue: document.querySelector('[data-admin-stat="revenue"]'),
    profit: document.querySelector('[data-admin-stat="profit"]'),
  };

  const totalQuantity = orders.reduce((sum, order) => sum + Number(order.quantity || 0), 0);
  const totalRevenue = orders.reduce((sum, order) => sum + Number(order.revenue || 0), 0);
  const totalCost = orders.reduce((sum, order) => sum + Number(order.cost || 0), 0);

  if (stats.orders) stats.orders.textContent = String(orders.length);
  if (stats.quantity) stats.quantity.textContent = String(totalQuantity);
  if (stats.revenue) stats.revenue.textContent = formatWon(totalRevenue);
  if (stats.profit) stats.profit.textContent = formatWon(totalRevenue - totalCost);

  const filteredOrders = getFilteredAdminOrders(orders);

  if (totalInfo) totalInfo.textContent = String(filteredOrders.length);
  if (tabCount) tabCount.textContent = String(orders.length);
  if (empty) {
    empty.textContent = orders.length
      ? "검색 조건에 맞는 주문이 없습니다."
      : "접수된 주문이 없습니다. 메뉴 페이지에서 주문 요청을 먼저 등록해 주세요.";
    empty.hidden = filteredOrders.length > 0;
  }

  orderList.innerHTML = filteredOrders
    .map((order) => {
      const created = new Date(order.createdAt).toLocaleDateString("ko-KR");
      const pickup = [order.pickupDate, order.pickupTime].filter(Boolean).join(" ");
      const fulfillment = getFulfillmentLabel(order.fulfillmentType);
      const profit = Number(order.revenue || 0) - Number(order.cost || 0);
      return `
        <tr data-order-id="${escapeHtml(order.id)}" data-status="${escapeHtml(order.status || "접수대기")}">
          <td>${created}</td>
          <td><strong>${escapeHtml(order.customer || "-")}</strong><span>${escapeHtml(order.phone || "")}</span></td>
          <td><strong>${escapeHtml(order.product || "-")}</strong><span>${escapeHtml(order.priceText || "상담 후 안내")}</span></td>
          <td>${order.quantity || 1}</td>
          <td><strong>${escapeHtml(pickup || "-")}</strong><span>${fulfillment}</span></td>
          <td>
            <select class="admin-status">
              ${(() => { const opts = ["접수대기", "준비중", "준비완료", getTerminalStatus(order.fulfillmentType)]; if (order.status && !opts.includes(order.status)) opts.push(order.status); return opts; })().map((status) => `<option value="${status}" ${order.status === status ? "selected" : ""}>${status}</option>`).join("")}
            </select>
          </td>
          <td><span class="admin-memo">${escapeHtml(order.memo || "-")}</span></td>
          <td><input class="admin-money admin-revenue" type="number" min="0" value="${Number(order.revenue || 0)}" /></td>
          <td><input class="admin-money admin-cost" type="number" min="0" value="${Number(order.cost || 0)}" /></td>
          <td><strong class="${profit < 0 ? "is-negative" : ""}">${formatWon(profit)}</strong></td>
          <td class="admin-row-actions">
            <button class="admin-reorder" type="button">재주문</button>
            <button class="admin-print" type="button">인쇄</button>
            <button class="admin-pay" type="button">결제링크</button>
            <button class="admin-edit" type="button">수정</button>
            <button class="admin-delete" type="button">삭제</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function buildAdminCustomers(orders) {
  const notes = readCustomerNotes();
  const savedCustomers = readCustomers();
  const customers = new Map();

  savedCustomers.forEach((customer) => {
    const key = customer.phone || customer.id || customer.name;
    if (!key) return;
    customers.set(key, {
      id: key,
      savedId: customer.id || key,
      isSaved: true,
      name: customer.name || "-",
      phone: customer.phone || "-",
      type: customer.type || "일반",
      orderCount: 0,
      quantity: 0,
      revenue: 0,
      lastDate: "",
      lastProduct: "",
      note: customer.memo || notes[key] || "",
    });
  });

  orders.forEach((order) => {
    const key = order.phone || order.id;
    const saved = customers.get(key) || {
      id: key,
      savedId: "",
      isSaved: false,
      name: order.customer || "-",
      phone: order.phone || "-",
      type: "주문고객",
      orderCount: 0,
      quantity: 0,
      revenue: 0,
      lastDate: "",
      lastProduct: "",
      note: notes[key] || "",
    };

    const createdAt = order.createdAt || "";
    saved.orderCount += 1;
    saved.quantity += Number(order.quantity || 0);
    saved.revenue += Number(order.revenue || 0);

    if (!saved.lastDate || new Date(createdAt) > new Date(saved.lastDate)) {
      saved.lastDate = createdAt;
      saved.lastProduct = order.product || "-";
      saved.name = order.customer || saved.name;
      saved.phone = order.phone || saved.phone;
    }

    customers.set(key, saved);
  });

  return [...customers.values()].sort((a, b) => {
    const dateDiff = new Date(b.lastDate || 0) - new Date(a.lastDate || 0);
    if (dateDiff) return dateDiff;
    return String(a.name).localeCompare(String(b.name), "ko-KR");
  });
}

function renderAdminCustomers() {
  const customerList = document.querySelector(".admin-customer-list");
  if (!customerList) return;

  const customers = buildAdminCustomers(readOrders());
  const empty = document.querySelector(".admin-customer-empty");
  const total = document.querySelector("[data-admin-customer-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="customers"]');

  if (total) total.textContent = String(customers.length);
  if (tabCount) tabCount.textContent = String(customers.length);
  if (empty) empty.hidden = customers.length > 0;

  customerList.innerHTML = customers
    .map((customer) => {
      const lastDate = customer.lastDate ? new Date(customer.lastDate).toLocaleDateString("ko-KR") : "-";
      return `
        <tr data-customer-id="${escapeHtml(customer.id)}" data-saved-customer-id="${escapeHtml(customer.savedId || "")}">
          <td><strong>${escapeHtml(customer.name)}</strong><span>${customer.isSaved ? "직접 등록" : "주문 자동"}</span></td>
          <td>${escapeHtml(customer.phone)}</td>
          <td>${escapeHtml(customer.type || "-")}</td>
          <td>${customer.orderCount}</td>
          <td>${customer.quantity}</td>
          <td><strong>${formatWon(customer.revenue)}</strong></td>
          <td>${lastDate}</td>
          <td><textarea class="admin-note" rows="1" placeholder="고객 메모">${escapeHtml(customer.note || "")}</textarea></td>
          <td class="admin-row-actions">
            <button class="admin-customer-orders" type="button">주문 보기</button>
            <button class="admin-customer-edit" type="button">수정</button>
            <button class="admin-customer-delete" type="button" ${customer.isSaved ? "" : "disabled"}>삭제</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function resetAdminCustomerForm() {
  if (!adminCustomerForm) return;
  adminCustomerForm.reset();
  adminCustomerForm.elements.namedItem("id").value = "";
  if (adminCustomerSubmit) adminCustomerSubmit.textContent = "고객 저장";
  if (adminCustomerCancel) adminCustomerCancel.hidden = true;
}

function saveAdminCustomer(formData) {
  const id = String(formData.get("id") || "").trim();
  const phone = String(formData.get("phone") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const customers = readCustomers();
  const existingCustomer = id
    ? customers.find((customer) => customer.id === id)
    : phone
      ? customers.find((customer) => customer.phone === phone)
      : customers.find((customer) => customer.name === name);
  const nextCustomer = {
    id: id || existingCustomer?.id || phone || `customer-${Date.now()}`,
    name,
    phone,
    type: String(formData.get("type") || "일반").trim(),
    memo: String(formData.get("memo") || "").trim(),
    updatedAt: new Date().toISOString(),
  };

  if (!nextCustomer.name) {
    setAdminFeedback("고객명은 필수입니다.");
    return;
  }

  const exists = Boolean(existingCustomer);
  const nextCustomers = exists
    ? customers.map((customer) => (customer.id === nextCustomer.id ? { ...customer, ...nextCustomer } : customer))
    : [{ ...nextCustomer, createdAt: new Date().toISOString() }, ...customers];

  writeCustomers(nextCustomers);
  resetAdminCustomerForm();
  renderAdminDashboard();
  setAdminFeedback(exists ? "고객 정보를 수정했습니다." : "고객을 등록했습니다.");
}

function editAdminCustomer(customerId) {
  if (!adminCustomerForm || !customerId) return;
  const customer = buildAdminCustomers(readOrders()).find((item) => item.id === customerId || item.savedId === customerId);
  if (!customer) return;

  adminCustomerForm.elements.namedItem("id").value = customer.savedId || customer.id;
  adminCustomerForm.elements.namedItem("name").value = customer.name === "-" ? "" : customer.name;
  adminCustomerForm.elements.namedItem("phone").value = customer.phone === "-" ? "" : customer.phone;
  adminCustomerForm.elements.namedItem("type").value = customer.type || "일반";
  adminCustomerForm.elements.namedItem("memo").value = customer.note || "";
  if (adminCustomerSubmit) adminCustomerSubmit.textContent = "수정 저장";
  if (adminCustomerCancel) adminCustomerCancel.hidden = false;
  adminCustomerForm.querySelector('input[name="name"]')?.focus();
}

function deleteAdminCustomer(customerId) {
  if (!customerId) return;
  const customers = readCustomers();
  const target = customers.find((customer) => customer.id === customerId);
  writeCustomers(customers.filter((customer) => customer.id !== customerId));

  const noteKey = target?.phone || target?.id || target?.name;
  if (noteKey) {
    const notes = readCustomerNotes();
    delete notes[noteKey];
    writeCustomerNotes(notes);
  }

  resetAdminCustomerForm();
  renderAdminDashboard();
  setAdminFeedback("직접 등록한 고객을 삭제했습니다.");
}

function buildProductionItems(orders) {
  const selectedDate = adminProductionDateFilter?.value || "";
  const activeOrders = orders.filter((order) => {
    const isActive = !isTerminalStatus(order.status);
    const matchesDate = !selectedDate || order.pickupDate === selectedDate;
    return isActive && matchesDate;
  });
  const grouped = new Map();

  activeOrders.forEach((order) => {
    const pickupDate = order.pickupDate || "날짜 미정";
    const product = order.product || "상품 미정";
    const key = `${pickupDate}__${product}`;
    const saved = grouped.get(key) || {
      id: key,
      pickupDate,
      product,
      quantity: 0,
      orderCount: 0,
      orderIds: [],
      times: new Set(),
      statuses: new Set(),
    };

    saved.quantity += Number(order.quantity || 0);
    saved.orderCount += 1;
    saved.orderIds.push(order.id);
    if (order.pickupTime) saved.times.add(order.pickupTime);
    if (order.status) saved.statuses.add(order.status);
    grouped.set(key, saved);
  });

  return [...grouped.values()].sort((a, b) => {
    if (a.pickupDate === "날짜 미정") return 1;
    if (b.pickupDate === "날짜 미정") return -1;
    return new Date(a.pickupDate) - new Date(b.pickupDate);
  });
}

function getProductionMaterials(product, quantity) {
  const normalizedProduct = String(product || "");
  const recipes = readRecipes();
  const rule =
    recipes.find((item) => item.keywords.some((keyword) => normalizedProduct.includes(keyword))) || {
      materials: [{ name: "멥쌀가루", unit: "kg", amount: 0.06 }],
    };

  return rule.materials.map((material) => ({
    ...material,
    amount: Number((material.amount * Number(quantity || 0)).toFixed(material.unit === "장" ? 0 : 2)),
  }));
}

function formatMaterialAmount(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function formatProductionMaterials(product, quantity) {
  return getProductionMaterials(product, quantity)
    .map((material) => `${material.name} ${formatMaterialAmount(material.amount)}${material.unit}`)
    .join(" · ");
}

function formatRecipeMaterials(materials) {
  return materials.map((material) => `${material.name} ${formatMaterialAmount(material.amount)}${material.unit}`).join(" · ");
}

function serializeRecipeMaterials(materials) {
  return materials.map((material) => `${material.name}:${formatMaterialAmount(material.amount)}:${material.unit}`).join(", ");
}

function parseRecipeKeywords(value) {
  return String(value || "")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function parseRecipeMaterials(value) {
  return String(value || "")
    .split(",")
    .map((item) => {
      const [name, amount, unit] = item.split(":").map((part) => part.trim());
      return { name, amount: Number(amount || 0), unit };
    })
    .filter((item) => item.name && item.amount > 0 && item.unit);
}

function renderInventoryRecipes() {
  const recipeList = document.querySelector(".admin-recipe-list");
  if (!recipeList) return;

  recipeList.innerHTML = readRecipes()
    .map(
      (rule, index) => `
        <tr data-recipe-index="${index}">
          <td>
            <input class="admin-recipe-keywords" type="text" value="${escapeHtml(rule.keywords.join(", "))}" aria-label="상품 키워드" />
          </td>
          <td>
            <input class="admin-recipe-materials" type="text" value="${escapeHtml(serializeRecipeMaterials(rule.materials))}" aria-label="원재료 기준" />
            <span>${escapeHtml(formatRecipeMaterials(rule.materials))}</span>
          </td>
          <td class="admin-row-actions">
            <button class="admin-recipe-save" type="button">저장</button>
            <button class="admin-recipe-delete" type="button">삭제</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function saveRecipeRow(row) {
  const index = Number(row?.dataset.recipeIndex);
  const keywords = parseRecipeKeywords(row?.querySelector(".admin-recipe-keywords")?.value);
  const materials = parseRecipeMaterials(row?.querySelector(".admin-recipe-materials")?.value);
  if (!keywords.length || !materials.length) {
    setAdminFeedback("상품 키워드와 원재료 기준을 확인해 주세요.");
    return;
  }

  const recipes = readRecipes();
  recipes[index] = { keywords, materials };
  writeRecipes(recipes);
  renderAdminDashboard();
  setAdminFeedback("원재료 배합 기준을 저장했습니다.");
}

function addRecipe(formData) {
  const keywords = parseRecipeKeywords(formData.get("keywords"));
  const materials = parseRecipeMaterials(formData.get("materials"));
  if (!keywords.length || !materials.length) {
    setAdminFeedback("상품 키워드와 원재료 기준을 확인해 주세요.");
    return;
  }
  writeRecipes([...readRecipes(), { keywords, materials }]);
  document.querySelector(".admin-recipe-form")?.reset();
  renderAdminDashboard();
  setAdminFeedback("원재료 배합 기준을 추가했습니다.");
}

function deleteRecipe(index) {
  const recipes = readRecipes().filter((_, currentIndex) => currentIndex !== Number(index));
  writeRecipes(recipes.length ? recipes : defaultInventoryRecipeRules);
  renderAdminDashboard();
  setAdminFeedback("원재료 배합 기준을 삭제했습니다.");
}

function resetRecipes() {
  if (!confirm("원재료 배합 기준을 기본값으로 되돌릴까요?")) return;
  writeRecipes(defaultInventoryRecipeRules);
  renderAdminDashboard();
  setAdminFeedback("원재료 배합 기준을 기본값으로 복원했습니다.");
}

function renderAdminProduction() {
  const productionList = document.querySelector(".admin-production-list");
  if (!productionList) return;

  const items = buildProductionItems(readOrders());
  const empty = document.querySelector(".admin-production-empty");
  const total = document.querySelector("[data-admin-production-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="production"]');
  const quantityStat = document.querySelector('[data-production-stat="quantity"]');
  const nextStat = document.querySelector('[data-production-stat="next"]');
  const activeStat = document.querySelector('[data-production-stat="active"]');
  const todayStat = document.querySelector('[data-production-stat="today"]');
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const activeOrderCount = items.reduce((sum, item) => sum + item.orderCount, 0);
  const nextItem = items.find((item) => item.pickupDate !== "날짜 미정");
  const today = new Date().toISOString().slice(0, 10);
  const todayQuantity = items.filter((item) => item.pickupDate === today).reduce((sum, item) => sum + item.quantity, 0);

  if (total) total.textContent = String(items.length);
  if (tabCount) tabCount.textContent = String(items.length);
  if (quantityStat) quantityStat.textContent = String(totalQuantity);
  if (nextStat) nextStat.textContent = nextItem ? nextItem.pickupDate : "-";
  if (activeStat) activeStat.textContent = String(activeOrderCount);
  if (todayStat) todayStat.textContent = String(todayQuantity);
  if (empty) empty.hidden = items.length > 0;

  productionList.innerHTML = items
    .map((item) => {
      const times = [...item.times].sort().join(", ") || "-";
      const statuses = [...item.statuses].join(" · ") || "-";
      const isReady = [...item.statuses].every((status) => status === "준비완료" || isTerminalStatus(status));
      return `
        <tr data-production-order-ids="${item.orderIds.join(",")}">
          <td><strong>${escapeHtml(item.pickupDate)}</strong></td>
          <td>${escapeHtml(item.product)}</td>
          <td><strong>${item.quantity}</strong></td>
          <td><span class="admin-memo">${escapeHtml(formatProductionMaterials(item.product, item.quantity))}</span></td>
          <td>${item.orderCount}</td>
          <td>${escapeHtml(times)}</td>
          <td><span class="admin-status-pill">${escapeHtml(statuses)}</span></td>
          <td>
            <button class="admin-production-complete" type="button" ${isReady ? "disabled" : ""}>준비완료</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function getInventoryStatus(item) {
  const stock = Number(item.stock || 0);
  const safeStock = Number(item.safeStock || 0);
  if (stock < safeStock) return "부족";
  if (safeStock > 0 && stock <= safeStock * 1.5) return "주의";
  return "정상";
}

function getRecommendedPurchaseQuantity(item) {
  const targetStock = Number(item.safeStock || 0) * 2;
  return Number(Math.max(0, targetStock - Number(item.stock || 0)).toFixed(2));
}

function resetAdminInventoryForm() {
  if (!adminInventoryForm) return;
  adminInventoryForm.reset();
  adminInventoryForm.elements.namedItem("id").value = "";
  if (adminInventorySubmit) adminInventorySubmit.textContent = "재고 저장";
  if (adminInventoryCancel) adminInventoryCancel.hidden = true;
}

function saveAdminInventory(formData) {
  const id = String(formData.get("id") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const stock = Number(formData.get("stock") || 0);
  const safeStock = Number(formData.get("safeStock") || 0);
  const items = readInventory();
  const existingItem = id
    ? items.find((item) => item.id === id)
    : items.find((item) => item.name === name);
  const conflictItem = items.find((item) => item.name === name && item.id !== (id || existingItem?.id));
  if (conflictItem) {
    setAdminFeedback(`"${name}" 이름의 재고 품목이 이미 존재합니다.`);
    return;
  }
  const nextItem = {
    id: id || existingItem?.id || `inventory-${Date.now()}`,
    name,
    stock,
    unit: String(formData.get("unit") || "").trim(),
    safeStock,
    memo: String(formData.get("memo") || "").trim(),
    updatedAt: new Date().toISOString(),
  };

  if (!nextItem.name || !nextItem.unit) {
    setAdminFeedback("품목명과 단위는 필수입니다.");
    return;
  }

  const nextItems = existingItem
    ? items.map((item) => (item.id === nextItem.id ? { ...item, ...nextItem } : item))
    : [{ ...nextItem, createdAt: new Date().toISOString() }, ...items];

  writeInventory(nextItems);
  if (nextItem.safeStock > 0 && nextItem.stock >= nextItem.safeStock) clearLowStockNotified(nextItem.id);
  addActivityLog("재고", `${nextItem.name} 재고를 ${existingItem ? "수정" : "등록"}했습니다.`, "inventory");
  resetAdminInventoryForm();
  renderAdminDashboard();
  setAdminFeedback(existingItem ? "재고 품목을 수정했습니다." : "재고 품목을 등록했습니다.");
}

function editAdminInventory(itemId) {
  if (!adminInventoryForm || !itemId) return;
  const item = readInventory().find((current) => current.id === itemId);
  if (!item) return;

  adminInventoryForm.elements.namedItem("id").value = item.id;
  adminInventoryForm.elements.namedItem("name").value = item.name || "";
  adminInventoryForm.elements.namedItem("stock").value = item.stock || 0;
  adminInventoryForm.elements.namedItem("unit").value = item.unit || "";
  adminInventoryForm.elements.namedItem("safeStock").value = item.safeStock || 0;
  adminInventoryForm.elements.namedItem("memo").value = item.memo || "";
  if (adminInventorySubmit) adminInventorySubmit.textContent = "수정 저장";
  if (adminInventoryCancel) adminInventoryCancel.hidden = false;
  adminInventoryForm.querySelector('input[name="name"]')?.focus();
}

function deleteAdminInventory(itemId) {
  if (!itemId) return;
  const items = readInventory();
  const target = items.find((item) => item.id === itemId);
  const activePurchases = readPurchaseOrders().filter(
    (order) => order.inventoryId === itemId && order.status !== "입고완료",
  );

  if (activePurchases.length) {
    if (!confirm(`${target?.name || "이 품목"}에 진행 중인 발주 ${activePurchases.length}건이 있습니다. 발주까지 함께 삭제할까요?`)) return;
    writePurchaseOrders(readPurchaseOrders().filter((order) => !(order.inventoryId === itemId && order.status !== "입고완료")));
  } else {
    if (!confirm(`${target?.name || "재고 품목"}을 삭제할까요?`)) return;
  }

  writeInventory(items.filter((item) => item.id !== itemId));
  addActivityLog("재고", `${target?.name || "재고 품목"}을 삭제했습니다.`, "inventory");
  resetAdminInventoryForm();
  renderAdminDashboard();
  setAdminFeedback(`재고 품목을 삭제했습니다.${activePurchases.length ? ` 연관 발주 ${activePurchases.length}건도 함께 삭제했습니다.` : ""}`);
}

function createSampleInventory() {
  const now = new Date().toISOString();
  const existing = readInventory();
  const existingNames = new Set(existing.map((item) => item.name));
  const samples = [
    { name: "멥쌀가루", stock: 18, unit: "kg", safeStock: 8, memo: "기본 떡류 공통" },
    { name: "찹쌀가루", stock: 7, unit: "kg", safeStock: 6, memo: "찰떡, 인절미용" },
    { name: "팥앙금", stock: 4, unit: "kg", safeStock: 5, memo: "백일떡, 수수팥떡 확인" },
    { name: "개별 포장지", stock: 120, unit: "장", safeStock: 80, memo: "답례떡 포장" },
  ]
    .filter((item) => !existingNames.has(item.name))
    .map((item, index) => ({
      id: `inventory-sample-${Date.now()}-${index}`,
      ...item,
      createdAt: now,
      updatedAt: now,
    }));

  if (!samples.length) {
    setAdminFeedback("기본 재고 품목이 이미 모두 등록되어 있습니다.");
    return;
  }
  if (existing.length && !confirm(`기본 재고 품목 ${samples.length}개를 추가할까요? 기존 재고는 유지됩니다.`)) return;

  writeInventory([...samples, ...existing]);
  addActivityLog("재고", `기본 원재료 재고 ${samples.length}개를 추가했습니다.`, "inventory");
  renderAdminDashboard();
  setAdminFeedback(`기본 재고 품목 ${samples.length}개를 추가했습니다.`);
}

function renderAdminInventory() {
  const inventoryList = document.querySelector(".admin-inventory-list");
  if (!inventoryList) return;

  const items = readInventory().sort((a, b) => {
    const statusOrder = { 부족: 0, 주의: 1, 정상: 2 };
    const statusDiff = statusOrder[getInventoryStatus(a)] - statusOrder[getInventoryStatus(b)];
    if (statusDiff) return statusDiff;
    return String(a.name).localeCompare(String(b.name), "ko-KR");
  });
  const empty = document.querySelector(".admin-inventory-empty");
  const total = document.querySelector("[data-admin-inventory-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="inventory"]');
  const totalStat = document.querySelector('[data-inventory-stat="total"]');
  const warningStat = document.querySelector('[data-inventory-stat="warning"]');
  const dangerStat = document.querySelector('[data-inventory-stat="danger"]');
  const purchaseStat = document.querySelector('[data-inventory-stat="purchase"]');
  const warningCount = items.filter((item) => getInventoryStatus(item) === "주의").length;
  const dangerCount = items.filter((item) => getInventoryStatus(item) === "부족").length;
  const purchaseCount = warningCount + dangerCount;

  if (total) total.textContent = String(items.length);
  if (tabCount) tabCount.textContent = String(dangerCount + warningCount);
  if (totalStat) totalStat.textContent = String(items.length);
  if (warningStat) warningStat.textContent = String(warningCount);
  if (dangerStat) dangerStat.textContent = String(dangerCount);
  if (purchaseStat) purchaseStat.textContent = String(purchaseCount);
  if (empty) empty.hidden = items.length > 0;

  inventoryList.innerHTML = items
    .map((item) => {
      const status = getInventoryStatus(item);
      return `
        <tr data-inventory-id="${item.id}" data-inventory-status="${status}">
          <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.memo || "-")}</span></td>
          <td><strong>${item.stock}</strong> ${escapeHtml(item.unit)}</td>
          <td>${item.safeStock} ${escapeHtml(item.unit)}</td>
          <td><span class="admin-status-pill">${status}</span></td>
          <td><span class="admin-memo">${escapeHtml(item.memo || "-")}</span></td>
          <td class="admin-row-actions">
            <button class="admin-inventory-edit" type="button">수정</button>
            <button class="admin-inventory-delete" type="button">삭제</button>
          </td>
        </tr>
      `;
    })
    .join("");

  renderPurchaseCandidates(items);
}

function renderPurchaseCandidates(items = readInventory()) {
  const purchaseList = document.querySelector(".admin-purchase-list");
  if (!purchaseList) return;

  const candidates = items.filter((item) => getInventoryStatus(item) !== "정상" && getRecommendedPurchaseQuantity(item) > 0);
  const activePurchaseIds = new Set(readPurchaseOrders().filter((order) => order.status !== "입고완료").map((order) => order.inventoryId));
  const empty = document.querySelector(".admin-purchase-empty");
  if (empty) empty.hidden = candidates.length > 0;

  purchaseList.innerHTML = candidates
    .map((item) => {
      const status = getInventoryStatus(item);
      const recommended = getRecommendedPurchaseQuantity(item);
      const isOrdering = activePurchaseIds.has(item.id);
      return `
        <tr data-purchase-id="${escapeHtml(item.id)}" data-purchase-amount="${recommended}">
          <td><strong>${escapeHtml(item.name)}</strong> <span class="admin-status-pill">${status}</span></td>
          <td>${formatMaterialAmount(item.stock)}${escapeHtml(item.unit)}</td>
          <td><strong>${formatMaterialAmount(recommended)}${escapeHtml(item.unit)}</strong></td>
          <td><button class="admin-purchase-request" type="button" ${isOrdering ? "disabled" : ""}>${isOrdering ? "발주 진행중" : "발주 요청"}</button></td>
        </tr>
      `;
    })
    .join("");
}

function resetSupplierForm() {
  if (!adminSupplierForm) return;
  adminSupplierForm.reset();
  adminSupplierForm.elements.namedItem("id").value = "";
  if (adminSupplierSubmit) adminSupplierSubmit.textContent = "공급처 저장";
  if (adminSupplierCancel) adminSupplierCancel.hidden = true;
}

function saveSupplier(formData) {
  const id = String(formData.get("id") || "").trim();
  const name = String(formData.get("name") || "").trim();
  if (!name) {
    setAdminFeedback("공급처명은 필수입니다.");
    return;
  }
  const suppliers = readSuppliers();
  const existing = id ? suppliers.find((supplier) => supplier.id === id) : null;
  const supplier = {
    id: id || `supplier-${Date.now()}`,
    name,
    phone: String(formData.get("phone") || "").trim(),
    items: String(formData.get("items") || "").trim(),
    memo: String(formData.get("memo") || "").trim(),
    updatedAt: new Date().toISOString(),
  };
  const nextSuppliers = existing
    ? suppliers.map((current) => (current.id === id ? { ...current, ...supplier } : current))
    : [{ ...supplier, createdAt: new Date().toISOString() }, ...suppliers];
  writeSuppliers(nextSuppliers);

  if (existing && existing.name !== name) {
    writePurchaseOrders(readPurchaseOrders().map((order) => (order.supplier === existing.name ? { ...order, supplier: name } : order)));
  }
  resetSupplierForm();
  renderAdminDashboard();
  setAdminFeedback(existing ? "공급처 정보를 수정했습니다." : "공급처를 등록했습니다.");
}

function editSupplier(supplierId) {
  if (!adminSupplierForm) return;
  const supplier = readSuppliers().find((current) => current.id === supplierId);
  if (!supplier) return;
  ["id", "name", "phone", "items", "memo"].forEach((field) => {
    adminSupplierForm.elements.namedItem(field).value = supplier[field] || "";
  });
  if (adminSupplierSubmit) adminSupplierSubmit.textContent = "수정 저장";
  if (adminSupplierCancel) adminSupplierCancel.hidden = false;
  adminSupplierForm.elements.namedItem("name")?.focus();
}

function renderSuppliers() {
  const supplierList = document.querySelector(".admin-supplier-list");
  if (!supplierList) return;
  const suppliers = readSuppliers().sort((a, b) => String(a.name).localeCompare(String(b.name), "ko-KR"));
  const empty = document.querySelector(".admin-supplier-empty");
  const total = document.querySelector("[data-admin-supplier-total]");
  const options = document.querySelector("#adminSupplierOptions");
  if (empty) empty.hidden = suppliers.length > 0;
  if (total) total.textContent = String(suppliers.length);
  if (options) options.innerHTML = suppliers.map((supplier) => `<option value="${escapeHtml(supplier.name)}"></option>`).join("");

  supplierList.innerHTML = suppliers
    .map(
      (supplier) => `
        <tr data-supplier-id="${escapeHtml(supplier.id)}">
          <td><strong>${escapeHtml(supplier.name)}</strong></td>
          <td>${escapeHtml(supplier.phone || "-")}</td>
          <td>${escapeHtml(supplier.items || "-")}</td>
          <td>${escapeHtml(supplier.memo || "-")}</td>
          <td class="admin-row-actions">
            <button class="admin-supplier-edit" type="button">수정</button>
            <button class="admin-supplier-delete" type="button">삭제</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function createPurchaseOrder(itemId, amount) {
  const items = readInventory();
  const item = items.find((current) => current.id === itemId);
  if (!item || Number(amount || 0) <= 0) return;

  const orders = readPurchaseOrders();
  const activeOrder = orders.find((order) => order.inventoryId === itemId && order.status !== "입고완료");
  if (activeOrder) {
    setAdminFeedback(`${item.name}은 이미 진행 중인 발주가 있습니다.`);
    return;
  }

  writePurchaseOrders([
    {
      id: `purchase-${Date.now()}`,
      inventoryId: item.id,
      name: item.name,
      amount: Number(amount),
      unit: item.unit,
      supplier: "",
      unitCost: 0,
      status: "발주요청",
      createdAt: new Date().toISOString(),
    },
    ...orders,
  ]);
  addActivityLog("발주", `${item.name} ${formatMaterialAmount(amount)}${item.unit} 발주를 요청했습니다.`, "inventory");
  renderAdminDashboard();
  setAdminFeedback(`${item.name} ${formatMaterialAmount(amount)}${item.unit} 발주를 요청했습니다.`);
}

function completePurchaseOrder(orderId) {
  const purchaseOrders = readPurchaseOrders();
  const order = purchaseOrders.find((current) => current.id === orderId);
  if (!order || order.receivedAt) return;
  const inventory = readInventory();
  const inventoryItem = inventory.find((current) => current.id === order.inventoryId);
  if (!inventoryItem) {
    setAdminFeedback(`${order.name}에 연결된 재고 품목이 삭제되었습니다. 발주를 삭제하고 재등록해 주세요.`);
    renderPurchaseOrders();
    return;
  }

  const newStock = Number((Number(inventoryItem.stock || 0) + Number(order.amount || 0)).toFixed(2));
  writeInventory(
    inventory.map((current) =>
      current.id === order.inventoryId
        ? { ...current, stock: newStock, updatedAt: new Date().toISOString() }
        : current,
    ),
  );
  if (Number(inventoryItem.safeStock || 0) > 0 && newStock >= Number(inventoryItem.safeStock || 0)) {
    clearLowStockNotified(inventoryItem.id);
  }
  writePurchaseOrders(
    purchaseOrders.map((current) =>
      current.id === orderId ? { ...current, status: "입고완료", receivedAt: new Date().toISOString() } : current,
    ),
  );
  addActivityLog("입고", `${order.name} ${formatMaterialAmount(order.amount)}${order.unit} 입고를 완료했습니다.`, "inventory");
  renderAdminDashboard();
  setAdminFeedback(`${order.name} ${formatMaterialAmount(order.amount)}${order.unit} 입고를 반영했습니다.`);
}

function updatePurchaseOrderStatus(orderId, status) {
  if (status === "입고완료") {
    completePurchaseOrder(orderId);
    return;
  }
  writePurchaseOrders(readPurchaseOrders().map((order) => (order.id === orderId ? { ...order, status } : order)));
  const order = readPurchaseOrders().find((current) => current.id === orderId);
  addActivityLog("발주", `${order?.name || "발주"} 상태를 ${status}(으)로 변경했습니다.`, "inventory");
  renderPurchaseOrders();
  setAdminFeedback(`발주 상태를 ${status}(으)로 변경했습니다.`);
}

function updatePurchaseOrderDetails(orderId, patch) {
  writePurchaseOrders(
    readPurchaseOrders().map((order) => (order.id === orderId ? { ...order, ...patch, updatedAt: new Date().toISOString() } : order)),
  );
  renderPurchaseOrders();
  setAdminFeedback("발주 정보를 저장했습니다.");
}

function renderPurchaseOrders() {
  const orderList = document.querySelector(".admin-purchase-order-list");
  if (!orderList) return;
  const orders = readPurchaseOrders();
  const empty = document.querySelector(".admin-purchase-order-empty");
  const costTotal = document.querySelector("[data-purchase-cost-total]");
  const activeCost = orders
    .filter((order) => order.status !== "입고완료")
    .reduce((sum, order) => sum + Number(order.amount || 0) * Number(order.unitCost || 0), 0);
  if (empty) empty.hidden = orders.length > 0;
  if (costTotal) costTotal.textContent = formatWon(activeCost);

  orderList.innerHTML = orders
    .map(
      (order) => `
        <tr data-purchase-order-id="${escapeHtml(order.id)}">
          <td>${new Date(order.createdAt).toLocaleDateString("ko-KR")}</td>
          <td><strong>${escapeHtml(order.name)}</strong></td>
          <td>${formatMaterialAmount(order.amount)}${escapeHtml(order.unit)}</td>
          <td><input class="admin-purchase-supplier" type="text" list="adminSupplierOptions" value="${escapeHtml(order.supplier || "")}" placeholder="공급처 선택" /></td>
          <td><input class="admin-purchase-unit-cost" type="number" min="0" step="1" value="${Number(order.unitCost || 0)}" aria-label="발주 단가" /></td>
          <td><strong>${formatWon(Number(order.amount || 0) * Number(order.unitCost || 0))}</strong></td>
          <td>
            <select class="admin-purchase-status" ${order.status === "입고완료" ? "disabled" : ""}>
              ${["발주요청", "발주중", "입고완료"].map((status) => `<option value="${status}" ${order.status === status ? "selected" : ""}>${status}</option>`).join("")}
            </select>
          </td>
          <td><button class="admin-purchase-delete" type="button">삭제</button></td>
        </tr>
      `,
    )
    .join("");
}

function renderInventoryLogs() {
  const logList = document.querySelector(".admin-inventory-log-list");
  if (!logList) return;

  const logs = readInventoryLogs();
  const empty = document.querySelector(".admin-inventory-log-empty");
  if (empty) empty.hidden = logs.length > 0;

  logList.innerHTML = logs
    .map(
      (log) => `
        <tr>
          <td><strong>${new Date(log.createdAt).toLocaleString("ko-KR")}</strong></td>
          <td>${escapeHtml(log.product || "-")} <span>${Number(log.quantity || 0)}개</span></td>
          <td>${escapeHtml((log.materials || []).join(", ") || "-")}</td>
        </tr>
      `,
    )
    .join("");
}

function addInventoryLog(entry) {
  const nextLogs = [
    {
      id: `usage-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...entry,
    },
    ...readInventoryLogs(),
  ].slice(0, 80);
  writeInventoryLogs(nextLogs);
}

function deductInventoryForProduction(product, quantity) {
  const materials = getProductionMaterials(product, quantity);
  const inventory = readInventory();
  const applied = [];
  const insufficient = [];
  const missing = [];
  const usedMaterialNames = new Set();

  if (!inventory.length) return { applied, insufficient, missing: materials.map((material) => material.name) };

  const nextInventory = inventory.map((item) => {
    const material = materials.find((current) => current.name === item.name && !usedMaterialNames.has(current.name));
    if (!material) return item;

    usedMaterialNames.add(material.name);
    const currentStock = Number(item.stock || 0);
    const needed = Number(material.amount || 0);
    const actualDeduction = Math.min(currentStock, needed);
    const nextStock = currentStock - actualDeduction;
    if (actualDeduction > 0) {
      applied.push(`${material.name} ${formatMaterialAmount(actualDeduction)}${material.unit}`);
    }
    if (actualDeduction < needed) {
      insufficient.push(`${material.name} (필요 ${formatMaterialAmount(needed)}${material.unit}, 재고 ${formatMaterialAmount(currentStock)}${material.unit})`);
    }
    return {
      ...item,
      stock: Number(nextStock.toFixed(2)),
      updatedAt: new Date().toISOString(),
    };
  });

  materials.forEach((material) => {
    if (!usedMaterialNames.has(material.name)) missing.push(material.name);
  });

  writeInventory(nextInventory);
  return { applied, insufficient, missing };
}

function getFilteredLogisticsOrders(orders) {
  const selectedDate = adminLogisticsDateFilter?.value || "";
  return orders
    .filter((order) => {
      const isComplete = order.logisticsStatus === "완료" || isTerminalStatus(order.status);
      const matchesDate = !selectedDate || order.pickupDate === selectedDate;
      return matchesDate && !isComplete;
    })
    .sort((a, b) => {
      const dateA = a.pickupDate || "9999-12-31";
      const dateB = b.pickupDate || "9999-12-31";
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return String(a.pickupTime || "").localeCompare(String(b.pickupTime || ""));
    });
}

function renderAdminLogistics() {
  const logisticsList = document.querySelector(".admin-logistics-list");
  if (!logisticsList) return;

  const orders = getFilteredLogisticsOrders(readOrders());
  const empty = document.querySelector(".admin-logistics-empty");
  const total = document.querySelector("[data-admin-logistics-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="logistics"]');
  const pickupStat = document.querySelector('[data-logistics-stat="pickup"]');
  const deliveryStat = document.querySelector('[data-logistics-stat="delivery"]');
  const activeStat = document.querySelector('[data-logistics-stat="active"]');
  const pickupCount = orders.filter((order) => (order.fulfillmentType || "pickup") !== "delivery").length;
  const deliveryCount = orders.filter((order) => order.fulfillmentType === "delivery").length;

  if (total) total.textContent = String(orders.length);
  if (tabCount) tabCount.textContent = String(orders.length);
  if (pickupStat) pickupStat.textContent = String(pickupCount);
  if (deliveryStat) deliveryStat.textContent = String(deliveryCount);
  if (activeStat) activeStat.textContent = String(orders.length);
  if (empty) empty.hidden = orders.length > 0;

  logisticsList.innerHTML = orders
    .map((order) => {
      const date = [order.pickupDate || "날짜 미정", order.pickupTime || ""].filter(Boolean).join(" ");
      const type = order.fulfillmentType || "pickup";
      const address = order.deliveryAddress || order.memo || "-";
      const currentStatus = order.logisticsStatus || getDefaultLogisticsStatus(type);
      const statusOptions = type === "delivery" ? ["배송대기", "이동중", "완료"] : ["픽업대기", "이동중", "완료"];
      const mapLink = type === "delivery" && order.deliveryAddress
        ? ` <a class="admin-map-link" href="https://map.naver.com/p/search/${encodeURIComponent(order.deliveryAddress)}" target="_blank" rel="noopener noreferrer">지도</a>`
        : "";
      return `
        <tr data-order-id="${escapeHtml(order.id)}">
          <td><strong>${escapeHtml(date)}</strong></td>
          <td><strong>${escapeHtml(order.customer || "-")}</strong><span>${escapeHtml(order.phone || "")}</span></td>
          <td><strong>${escapeHtml(order.product || "-")}</strong><span>${order.quantity || 1}개</span></td>
          <td><span class="admin-status-pill">${getFulfillmentLabel(type)}</span></td>
          <td><span class="admin-memo">${escapeHtml(address)}</span>${mapLink}</td>
          <td>
            <select class="admin-logistics-status">
              ${statusOptions.map((status) => `<option value="${status}" ${currentStatus === status ? "selected" : ""}>${status}</option>`).join("")}
            </select>
          </td>
        </tr>
      `;
    })
    .join("");
}

function buildAccountingItems(orders) {
  const grouped = new Map();

  orders.forEach((order) => {
    const product = order.product || "상품 미정";
    const saved = grouped.get(product) || {
      product,
      quantity: 0,
      orderCount: 0,
      revenue: 0,
      cost: 0,
    };

    saved.quantity += Number(order.quantity || 0);
    saved.orderCount += 1;
    saved.revenue += Number(order.revenue || 0);
    saved.cost += Number(order.cost || 0);
    grouped.set(product, saved);
  });

  return [...grouped.values()].sort((a, b) => b.revenue - a.revenue);
}

function getAccountingFilteredOrders(orders = readOrders()) {
  const start = adminAccountingStart?.value || "";
  const end = adminAccountingEnd?.value || "";
  return orders.filter((order) => {
    const createdDate = String(order.createdAt || "").slice(0, 10);
    const afterStart = !start || createdDate >= start;
    const beforeEnd = !end || createdDate <= end;
    return afterStart && beforeEnd;
  });
}

function buildAccountingDailyItems(orders) {
  const grouped = new Map();

  orders.forEach((order) => {
    const date = String(order.createdAt || "").slice(0, 10) || "날짜 미정";
    const saved = grouped.get(date) || {
      date,
      orderCount: 0,
      quantity: 0,
      revenue: 0,
      cost: 0,
    };

    saved.orderCount += 1;
    saved.quantity += Number(order.quantity || 0);
    saved.revenue += Number(order.revenue || 0);
    saved.cost += Number(order.cost || 0);
    grouped.set(date, saved);
  });

  return [...grouped.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function getAccountingPurchaseOrders() {
  const start = adminAccountingStart?.value || "";
  const end = adminAccountingEnd?.value || "";
  return readPurchaseOrders().filter((order) => {
    if (order.status !== "입고완료" || !order.receivedAt) return false;
    const receivedDate = String(order.receivedAt).slice(0, 10);
    const afterStart = !start || receivedDate >= start;
    const beforeEnd = !end || receivedDate <= end;
    return afterStart && beforeEnd;
  });
}

function buildPurchaseCostItems(orders) {
  const grouped = new Map();
  orders.forEach((order) => {
    const supplier = String(order.supplier || "공급처 미입력");
    const saved = grouped.get(supplier) || { supplier, orderCount: 0, cost: 0 };
    saved.orderCount += 1;
    saved.cost += Number(order.amount || 0) * Number(order.unitCost || 0);
    grouped.set(supplier, saved);
  });
  return [...grouped.values()].sort((a, b) => b.cost - a.cost);
}

function buildAccountingMonthlyItems(orders, purchaseOrders) {
  const grouped = new Map();

  orders.forEach((order) => {
    const month = String(order.createdAt || "").slice(0, 7) || "날짜 미정";
    const saved = grouped.get(month) || { month, revenue: 0, cost: 0, purchaseCost: 0 };
    saved.revenue += Number(order.revenue || 0);
    saved.cost += Number(order.cost || 0);
    grouped.set(month, saved);
  });

  purchaseOrders.forEach((order) => {
    const month = String(order.receivedAt || "").slice(0, 7) || "날짜 미정";
    const saved = grouped.get(month) || { month, revenue: 0, cost: 0, purchaseCost: 0 };
    saved.purchaseCost += Number(order.amount || 0) * Number(order.unitCost || 0);
    grouped.set(month, saved);
  });

  return [...grouped.values()].sort((a, b) => String(b.month).localeCompare(String(a.month))).slice(0, 12);
}

let accountingChartInstance = null;

function renderAccountingChart(monthlyItems) {
  const canvas = document.querySelector(".admin-revenue-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const sorted = [...monthlyItems].sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const labels = sorted.map((item) => item.month);
  const revenues = sorted.map((item) => item.revenue);
  const profits = sorted.map((item) => item.revenue - item.cost);

  if (accountingChartInstance) {
    accountingChartInstance.destroy();
    accountingChartInstance = null;
  }

  if (!sorted.length) {
    canvas.hidden = true;
    return;
  }
  canvas.hidden = false;

  accountingChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "매출",
          data: revenues,
          backgroundColor: "rgba(99, 102, 241, 0.25)",
          borderColor: "rgba(99, 102, 241, 0.9)",
          borderWidth: 1.5,
          borderRadius: 4,
          order: 2,
        },
        {
          label: "이윤",
          data: profits,
          type: "line",
          borderColor: "rgba(16, 185, 129, 0.9)",
          backgroundColor: "rgba(16, 185, 129, 0.1)",
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: "rgba(16, 185, 129, 0.9)",
          tension: 0.3,
          fill: true,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "top" },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString("ko-KR")}원`,
          },
        },
      },
      scales: {
        y: {
          ticks: {
            callback: (value) => `${Number(value).toLocaleString("ko-KR")}원`,
          },
        },
      },
    },
  });
}

function renderAdminAccounting() {
  const accountingList = document.querySelector(".admin-accounting-list");
  if (!accountingList) return;

  const filteredOrders = getAccountingFilteredOrders();
  const items = buildAccountingItems(filteredOrders);
  const dailyItems = buildAccountingDailyItems(filteredOrders);
  const purchaseOrders = getAccountingPurchaseOrders();
  const purchaseItems = buildPurchaseCostItems(purchaseOrders);
  const monthlyItems = buildAccountingMonthlyItems(filteredOrders, purchaseOrders);
  const empty = document.querySelector(".admin-accounting-empty");
  const dailyList = document.querySelector(".admin-accounting-daily-list");
  const dailyEmpty = document.querySelector(".admin-accounting-daily-empty");
  const total = document.querySelector("[data-admin-accounting-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="accounting"]');
  const revenueStat = document.querySelector('[data-accounting-stat="revenue"]');
  const costStat = document.querySelector('[data-accounting-stat="cost"]');
  const profitStat = document.querySelector('[data-accounting-stat="profit"]');
  const marginStat = document.querySelector('[data-accounting-stat="margin"]');
  const purchaseCostStat = document.querySelector('[data-accounting-stat="purchaseCost"]');
  const cashFlowStat = document.querySelector('[data-accounting-stat="cashFlow"]');
  const purchaseList = document.querySelector(".admin-accounting-purchase-list");
  const purchaseEmpty = document.querySelector(".admin-accounting-purchase-empty");
  const monthlyList = document.querySelector(".admin-accounting-monthly-list");
  const monthlyEmpty = document.querySelector(".admin-accounting-monthly-empty");
  const topRevenueInsight = document.querySelector('[data-accounting-insight="topRevenue"]');
  const topProfitInsight = document.querySelector('[data-accounting-insight="topProfit"]');
  const missingCostInsight = document.querySelector('[data-accounting-insight="missingCost"]');
  const totalRevenue = items.reduce((sum, item) => sum + item.revenue, 0);
  const totalCost = items.reduce((sum, item) => sum + item.cost, 0);
  const totalProfit = totalRevenue - totalCost;
  const totalPurchaseCost = purchaseItems.reduce((sum, item) => sum + item.cost, 0);
  const cashFlow = totalRevenue - totalPurchaseCost;
  const totalMargin = totalRevenue ? Math.round((totalProfit / totalRevenue) * 100) : 0;
  const topRevenueItem = [...items].sort((a, b) => b.revenue - a.revenue)[0];
  const getProfit = (item) => item.revenue - item.cost;
  const topProfitItem = [...items].sort((a, b) => getProfit(b) - getProfit(a))[0];
  const missingCostCount = filteredOrders.filter((order) => Number(order.revenue || 0) > 0 && Number(order.cost || 0) === 0).length;

  if (total) total.textContent = String(items.length);
  if (tabCount) tabCount.textContent = String(filteredOrders.length);
  if (revenueStat) revenueStat.textContent = formatWon(totalRevenue);
  if (costStat) costStat.textContent = formatWon(totalCost);
  if (profitStat) profitStat.textContent = formatWon(totalProfit);
  if (marginStat) marginStat.textContent = `${totalMargin}%`;
  if (purchaseCostStat) purchaseCostStat.textContent = formatWon(totalPurchaseCost);
  if (cashFlowStat) {
    cashFlowStat.textContent = formatWon(cashFlow);
    cashFlowStat.classList.toggle("is-negative", cashFlow < 0);
  }
  if (empty) empty.hidden = items.length > 0;
  if (dailyEmpty) dailyEmpty.hidden = dailyItems.length > 0;
  if (topRevenueInsight) topRevenueInsight.textContent = topRevenueItem ? `${topRevenueItem.product} · ${formatWon(topRevenueItem.revenue)}` : "-";
  if (topProfitInsight) topProfitInsight.textContent = topProfitItem ? `${topProfitItem.product} · ${formatWon(getProfit(topProfitItem))}` : "-";
  if (missingCostInsight) missingCostInsight.textContent = `${missingCostCount}건`;
  if (purchaseEmpty) purchaseEmpty.hidden = purchaseItems.length > 0;
  if (monthlyEmpty) monthlyEmpty.hidden = monthlyItems.length > 0;

  if (monthlyList) {
    const maxRevenue = Math.max(...monthlyItems.map((item) => item.revenue), 1);
    monthlyList.innerHTML = monthlyItems
      .map((item) => {
        const profit = item.revenue - item.cost;
        const monthlyCashFlow = item.revenue - item.purchaseCost;
        const barWidth = Math.max(4, Math.round((item.revenue / maxRevenue) * 100));
        return `
          <tr>
            <td><strong>${escapeHtml(item.month)}</strong></td>
            <td><div class="admin-monthly-bar"><i style="width: ${barWidth}%"></i></div></td>
            <td>${formatWon(item.revenue)}</td>
            <td><strong class="${profit < 0 ? "is-negative" : ""}">${formatWon(profit)}</strong></td>
            <td>${formatWon(item.purchaseCost)}</td>
            <td><strong class="${monthlyCashFlow < 0 ? "is-negative" : ""}">${formatWon(monthlyCashFlow)}</strong></td>
          </tr>
        `;
      })
      .join("");
  }

  if (purchaseList) {
    purchaseList.innerHTML = purchaseItems
      .map(
        (item) => `
          <tr>
            <td><strong>${escapeHtml(item.supplier)}</strong></td>
            <td>${item.orderCount}</td>
            <td><strong>${formatWon(item.cost)}</strong></td>
          </tr>
        `,
      )
      .join("");
  }

  if (dailyList) {
    dailyList.innerHTML = dailyItems
      .map((item) => {
        const profit = item.revenue - item.cost;
        return `
          <tr>
            <td><strong>${item.date}</strong></td>
            <td>${item.orderCount}건</td>
            <td>${formatWon(item.revenue)}</td>
            <td><strong class="${profit < 0 ? "is-negative" : ""}">${formatWon(profit)}</strong></td>
          </tr>
        `;
      })
      .join("");
  }

  accountingList.innerHTML = items
    .map((item) => {
      const profit = item.revenue - item.cost;
      const margin = item.revenue ? Math.round((profit / item.revenue) * 100) : 0;
      return `
        <tr>
          <td><strong>${escapeHtml(item.product)}</strong></td>
          <td>${item.quantity}</td>
          <td>${item.orderCount}</td>
          <td><strong>${formatWon(item.revenue)}</strong></td>
          <td>${formatWon(item.cost)}</td>
          <td><strong>${formatWon(profit)}</strong></td>
          <td><span class="admin-status-pill">${margin}%</span></td>
        </tr>
      `;
    })
    .join("");

  renderAccountingChart(monthlyItems);
}

function renderActivityLogs() {
  const list = document.querySelector(".admin-activity-list");
  if (!list) return;
  const logs = readActivityLogs().slice(0, 6);
  const empty = document.querySelector(".admin-activity-empty");
  const clearButton = document.querySelector(".admin-activity-clear");
  if (empty) empty.hidden = logs.length > 0;
  if (clearButton) clearButton.hidden = logs.length === 0;
  list.innerHTML = logs
    .map(
      (log) => `
        <li>
          <button type="button" data-admin-activity-tab="${escapeHtml(log.tab || "orders")}">
            <span>${escapeHtml(log.category || "관리")}</span>
            <strong>${escapeHtml(log.message || "-")}</strong>
            <time datetime="${escapeHtml(log.createdAt)}">${new Date(log.createdAt).toLocaleString("ko-KR")}</time>
          </button>
        </li>
      `,
    )
    .join("");
}

function setAdminAlert(type, count, detail) {
  const countElement = document.querySelector(`[data-admin-alert-count="${type}"]`);
  const detailElement = document.querySelector(`[data-admin-alert-detail="${type}"]`);
  const button = document.querySelector(`.admin-alert-center [data-alert-type="${type}"]`);
  if (countElement) countElement.textContent = String(count);
  if (detailElement) detailElement.textContent = detail;
  button?.classList.toggle("is-clear", count === 0);
}

function renderOperationalAlerts() {
  const orders = readOrders();
  const pendingOrders = orders.filter((order) => order.status === "접수대기");
  const lowInventory = readInventory().filter((item) => getInventoryStatus(item) === "부족");
  const activePurchases = readPurchaseOrders().filter((order) => order.status !== "입고완료");
  const pendingLogistics = orders.filter((order) => order.status === "준비완료" && order.logisticsStatus !== "완료");

  setAdminAlert(
    "orders",
    pendingOrders.length,
    pendingOrders.length ? `${pendingOrders[0].customer || "고객 미정"} · ${pendingOrders[0].product || "상품 미정"}` : "대기 주문이 없습니다.",
  );
  setAdminAlert(
    "inventory",
    lowInventory.length,
    lowInventory.length ? lowInventory.slice(0, 2).map((item) => item.name).join(" · ") : "부족 품목이 없습니다.",
  );
  setAdminAlert(
    "purchases",
    activePurchases.length,
    activePurchases.length ? `${activePurchases[0].name} · ${activePurchases[0].status}` : "진행 중 발주가 없습니다.",
  );
  setAdminAlert(
    "logistics",
    pendingLogistics.length,
    pendingLogistics.length ? `${pendingLogistics[0].customer || "고객 미정"} · ${getFulfillmentLabel(pendingLogistics[0].fulfillmentType)}` : "대기 항목이 없습니다.",
  );
}

function renderAdminDashboard() {
  renderAdminOrders();
  renderAdminCustomers();
  renderAdminProduction();
  renderInventoryRecipes();
  renderAdminInventory();
  renderSuppliers();
  renderPurchaseOrders();
  renderInventoryLogs();
  renderAdminLogistics();
  renderAdminAccounting();
  renderOperationalAlerts();
  renderActivityLogs();
}

function setAdminTab(tabName) {
  const panels = {
    orders: document.querySelector(".admin-order-panel"),
    customers: document.querySelector(".admin-customer-panel"),
    production: document.querySelector(".admin-production-panel"),
    inventory: document.querySelector(".admin-inventory-panel"),
    logistics: document.querySelector(".admin-logistics-panel"),
    accounting: document.querySelector(".admin-accounting-panel"),
  };

  if (!panels[tabName]) return;

  document.querySelectorAll(".admin-tabs button").forEach((tab) => {
    const isActive = tab.dataset.adminTab === tabName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  Object.entries(panels).forEach(([name, panel]) => {
    if (panel) panel.hidden = name !== tabName;
  });
}

function updateAdminOrder(id, patch) {
  const orders = readOrders();
  const target = orders.find((order) => order.id === id);
  writeOrders(orders.map((order) => (order.id === id ? { ...order, ...patch } : order)));
  if (patch.status) {
    addActivityLog("주문", `${target?.product || "주문"} 상태를 ${patch.status}(으)로 변경했습니다.`, "orders");
  }
  renderAdminDashboard();
  setAdminFeedback("주문 정보가 저장되었습니다.");
}

// 아래 고객명·연락처·주문 내역은 포트폴리오 시연용 가상 데이터이며 실제 고객 정보가 아닙니다.
function createDemoOrders() {
  if (!confirm("테스트용 주문 6건을 추가할까요? 기존 주문은 유지됩니다.")) return;

  const today = new Date();
  const dateAfter = (days) => {
    const next = new Date(today);
    next.setDate(today.getDate() + days);
    return next.toISOString().slice(0, 10);
  };
  const idPrefix = `demo-${Date.now()}`;
  const demoOrders = [
    {
      product: "송편 예약",
      priceText: "4,000원",
      quantity: 12,
      pickupDate: dateAfter(1),
      pickupTime: "10:30",
      customer: "김민지",
      phone: "010-1234-1001",
      memo: "선물 포장 2세트",
      status: "접수대기",
      revenue: 48000,
      cost: 28000,
    },
    {
      product: "백일떡",
      priceText: "상담 후 안내",
      quantity: 30,
      pickupDate: dateAfter(2),
      pickupTime: "13:00",
      customer: "박서준",
      phone: "010-1234-1002",
      memo: "백일 스티커 필요",
      status: "준비중",
      revenue: 150000,
      cost: 90000,
    },
    {
      product: "답례떡",
      priceText: "상담 후 안내",
      quantity: 80,
      pickupDate: dateAfter(3),
      pickupTime: "09:00",
      customer: "동탄맘 모임",
      phone: "010-1234-1003",
      memo: "개별 포장",
      status: "준비중",
      revenue: 320000,
      cost: 210000,
    },
    {
      product: "수수팥떡",
      priceText: "상담 후 안내",
      quantity: 20,
      pickupDate: dateAfter(2),
      pickupTime: "16:30",
      customer: "이하늘",
      phone: "010-1234-1004",
      memo: "당일 픽업",
      status: "준비완료",
      revenue: 90000,
      cost: 52000,
    },
    {
      product: "꿀떡",
      priceText: "3,500원",
      quantity: 10,
      pickupDate: dateAfter(-1),
      pickupTime: "12:00",
      customer: "정우진",
      phone: "010-1234-1005",
      memo: "",
      status: "픽업완료",
      revenue: 35000,
      cost: 19000,
    },
    {
      product: "단체주문",
      priceText: "상담 후 안내",
      quantity: 120,
      pickupDate: dateAfter(5),
      pickupTime: "08:30",
      customer: "인근 사무실",
      phone: "010-1234-1006",
      memo: "회사 행사, 오전 배송 문의",
      status: "접수대기",
      revenue: 480000,
      cost: 310000,
    },
  ].map((order, index) => ({
    id: `${idPrefix}-${index + 1}`,
    createdAt: new Date(today.getTime() - index * 3600000).toISOString(),
    ...order,
    fulfillmentType: order.fulfillmentType || (index === 5 ? "delivery" : "pickup"),
    deliveryAddress: order.deliveryAddress || (index === 5 ? "매장 인근 배송 상담" : ""),
    logisticsStatus: order.logisticsStatus || (index === 5 ? "배송대기" : getDefaultLogisticsStatus(order.fulfillmentType)),
  }));

  writeOrders([...demoOrders, ...readOrders()]);
  renderAdminDashboard();
  setAdminTab("orders");
  setAdminFeedback("테스트용 주문 6건을 추가했습니다.");
}

function exportAdminData() {
  const backup = {
    app: "warm-rice-cake-shop",
    version: 1,
    exportedAt: new Date().toISOString(),
    orders: readOrders(),
    customerNotes: readCustomerNotes(),
    customers: readCustomers(),
    inventory: readInventory(),
    recipes: readRecipes(),
    inventoryLogs: readInventoryLogs(),
    purchaseOrders: readPurchaseOrders(),
    suppliers: readSuppliers(),
    activityLogs: readActivityLogs(),
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `tteok-shop-backup-${date}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setAdminFeedback(`주문 ${backup.orders.length}건을 백업 파일로 저장했습니다.`);
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function exportAdminOrdersCsv() {
  const orders = readOrders();
  if (!orders.length) {
    setAdminFeedback("CSV로 저장할 주문이 없습니다.");
    return;
  }

  const headers = ["접수일", "고객명", "연락처", "상품", "수량", "수령방식", "픽업일", "픽업시간", "배송주소", "물류상태", "주문상태", "요청메모", "판매가", "원가", "이윤"];
  const rows = orders.map((order) => {
    const profit = Number(order.revenue || 0) - Number(order.cost || 0);
    return [
      order.createdAt ? new Date(order.createdAt).toLocaleDateString("ko-KR") : "",
      order.customer || "",
      order.phone || "",
      order.product || "",
      order.quantity || 0,
      getFulfillmentLabel(order.fulfillmentType),
      order.pickupDate || "",
      order.pickupTime || "",
      order.deliveryAddress || "",
      order.logisticsStatus || getDefaultLogisticsStatus(order.fulfillmentType),
      order.status || "",
      order.memo || "",
      Number(order.revenue || 0),
      Number(order.cost || 0),
      profit,
    ];
  });
  const csv = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `tteok-shop-orders-${date}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  setAdminFeedback(`현재 주문 목록 ${orders.length}건을 CSV로 저장했습니다.`);
}

function exportAccountingCsv() {
  const filteredOrders = getAccountingFilteredOrders();
  const purchaseOrders = getAccountingPurchaseOrders();
  const monthlyItems = buildAccountingMonthlyItems(filteredOrders, purchaseOrders);

  if (!monthlyItems.length) {
    setAdminFeedback("CSV로 저장할 회계 데이터가 없습니다.");
    return;
  }

  const headers = ["월", "매출", "주문원가", "예상이윤", "입고발주비", "순현금흐름"];
  const rows = monthlyItems.map((item) => {
    const profit = Number(item.revenue || 0) - Number(item.cost || 0);
    const cashFlow = Number(item.revenue || 0) - Number(item.purchaseCost || 0);
    return [item.month, item.revenue, item.cost, profit, item.purchaseCost, cashFlow];
  });
  const csv = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const start = adminAccountingStart?.value || "all";
  const end = adminAccountingEnd?.value || new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `tteok-shop-accounting-${start}-${end}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  setAdminFeedback(`월별 회계 보고서 ${monthlyItems.length}개월분을 CSV로 저장했습니다.`);
}

function importAdminData(file) {
  if (!file) return;
  const reader = new FileReader();

  reader.addEventListener("load", () => {
    try {
      const data = JSON.parse(String(reader.result || "{}"));
      const orders = Array.isArray(data.orders) ? data.orders : Array.isArray(data) ? data : null;
      const customerNotes = data.customerNotes && typeof data.customerNotes === "object" ? data.customerNotes : {};
      const customers = Array.isArray(data.customers) ? data.customers : [];
      const inventory = Array.isArray(data.inventory) ? data.inventory : [];
      const recipes = Array.isArray(data.recipes) ? data.recipes : defaultInventoryRecipeRules;
      const inventoryLogs = Array.isArray(data.inventoryLogs) ? data.inventoryLogs : [];
      const purchaseOrders = Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [];
      const suppliers = Array.isArray(data.suppliers) ? data.suppliers : [];
      const activityLogs = Array.isArray(data.activityLogs) ? data.activityLogs : [];

      if (!orders) {
        alert("불러올 수 있는 주문 백업 파일이 아닙니다.");
        return;
      }

      if (!confirm(`주문 ${orders.length}건을 불러오고 현재 데이터를 교체할까요?`)) return;
      writeOrders(orders);
      writeCustomerNotes(customerNotes);
      writeCustomers(customers);
      writeInventory(inventory);
      writeRecipes(recipes);
      writeInventoryLogs(inventoryLogs);
      writePurchaseOrders(purchaseOrders);
      writeSuppliers(suppliers);
      writeActivityLogs(activityLogs);
      renderAdminDashboard();
      setAdminTab("orders");
      setAdminFeedback(`백업 파일에서 주문 ${orders.length}건을 불러왔습니다.`);
    } catch {
      alert("백업 파일을 읽지 못했습니다. JSON 파일인지 확인해 주세요.");
    } finally {
      if (adminImportInput) adminImportInput.value = "";
    }
  });

  reader.readAsText(file);
}

document.querySelector(".admin-order-list")?.addEventListener("change", (event) => {
  const row = event.target.closest("tr[data-order-id]");
  if (!row) return;
  const id = row.dataset.orderId;
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

document.querySelector(".admin-order-list")?.addEventListener("click", (event) => {
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
    const amount = Number(order.revenue || 0);
    if (!amount) {
      const input = prompt(`${order.customer || "고객"}님 결제 금액을 입력하세요 (원):`, "0");
      if (!input) return;
      const entered = Number(String(input).replace(/,/g, ""));
      if (!entered || isNaN(entered)) { alert("올바른 금액을 입력해 주세요."); return; }
      createPaymentLink(order.id, entered);
    } else {
      createPaymentLink(order.id, amount);
    }
    return;
  }

  const deleteButton = event.target.closest(".admin-delete");
  if (!deleteButton) return;
  const row = deleteButton.closest("tr[data-order-id]");
  const orders = readOrders();
  const target = orders.find((order) => order.id === row.dataset.orderId);
  if (!confirm(`${target?.customer || "고객"}님의 ${target?.product || "주문"}을 삭제할까요? 삭제 후 복구할 수 없습니다.`)) return;
  writeOrders(orders.filter((order) => order.id !== row.dataset.orderId));
  addActivityLog("주문", `${target?.product || "주문"}을 삭제했습니다.`, "orders");
  renderAdminDashboard();
  setAdminFeedback("주문 1건을 삭제했습니다.");
});

document.querySelector(".admin-clear-orders")?.addEventListener("click", () => {
  if (!confirm("주문, 고객, 재고, 재고 이력, 발주, 공급처, 활동 로그 데이터를 모두 초기화할까요?")) return;
  writeOrders([]);
  writeCustomerNotes({});
  writeCustomers([]);
  writeInventory([]);
  writeRecipes(defaultInventoryRecipeRules);
  writeInventoryLogs([]);
  writePurchaseOrders([]);
  writeSuppliers([]);
  writeActivityLogs([]);
  resetAdminCustomerForm();
  resetAdminInventoryForm();
  resetSupplierForm();
  renderAdminDashboard();
  setAdminFeedback("운영 데이터를 초기화했습니다.");
});

adminExportData?.addEventListener("click", exportAdminData);
adminDemoData?.addEventListener("click", createDemoOrders);
adminCsvData?.addEventListener("click", exportAdminOrdersCsv);
adminImportData?.addEventListener("click", () => adminImportInput?.click());
adminImportInput?.addEventListener("change", (event) => {
  importAdminData(event.target.files?.[0]);
});

adminProductionDateFilter?.addEventListener("change", () => {
  renderAdminProduction();
  setAdminFeedback(adminProductionDateFilter.value ? "선택한 픽업일 기준으로 생산 목록을 필터링했습니다." : "전체 생산 목록을 표시합니다.");
});

adminProductionReset?.addEventListener("click", () => {
  if (adminProductionDateFilter) adminProductionDateFilter.value = "";
  renderAdminProduction();
  setAdminFeedback("전체 생산 목록을 표시합니다.");
});

document.querySelector(".admin-production-list")?.addEventListener("click", (event) => {
  const completeButton = event.target.closest(".admin-production-complete");
  if (!completeButton) return;
  const row = completeButton.closest("tr[data-production-order-ids]");
  const orderIds = (row?.dataset.productionOrderIds || "").split(",").filter(Boolean);
  if (!orderIds.length) return;
  const currentOrders = readOrders();
  const productionOrders = currentOrders.filter((order) => orderIds.includes(order.id) && !isTerminalStatus(order.status));
  const product = productionOrders[0]?.product || "";
  const quantity = productionOrders.reduce((sum, order) => sum + Number(order.quantity || 0), 0);
  const deduction = deductInventoryForProduction(product, quantity);

  writeOrders(
    currentOrders.map((order) =>
      orderIds.includes(order.id) && !isTerminalStatus(order.status) ? { ...order, status: "준비완료" } : order,
    ),
  );
  if (deduction.applied.length) {
    addInventoryLog({
      product,
      quantity,
      orderCount: productionOrders.length,
      orderIds,
      materials: deduction.applied,
    });
  }
  addActivityLog(
    "생산",
    `${product || "생산 항목"} ${quantity}개를 준비완료 처리했습니다.${deduction.applied.length ? ` 원재료 ${deduction.applied.join(", ")} 차감.` : ""}${deduction.insufficient.length ? ` 재고 부족 주의.` : ""}`,
    "production",
  );
  renderAdminDashboard();
  const deductionText = deduction.applied.length ? ` 재고 차감: ${deduction.applied.join(", ")}.` : " 등록된 재고가 없어 차감은 생략했습니다.";
  const insufficientText = deduction.insufficient.length ? ` 재고 부족: ${deduction.insufficient.join(", ")}.` : "";
  const missingText = deduction.missing.length ? ` 미등록 원재료: ${deduction.missing.join(", ")}.` : "";
  setAdminFeedback(`생산 항목 ${orderIds.length}건을 준비완료로 변경했습니다.${deductionText}${insufficientText}${missingText}`);
});

adminLogisticsDateFilter?.addEventListener("change", () => {
  renderAdminLogistics();
  setAdminFeedback(adminLogisticsDateFilter.value ? "선택한 수령일 기준으로 픽업/배송 목록을 필터링했습니다." : "전체 픽업/배송 목록을 표시합니다.");
});

adminLogisticsReset?.addEventListener("click", () => {
  if (adminLogisticsDateFilter) adminLogisticsDateFilter.value = "";
  renderAdminLogistics();
  setAdminFeedback("전체 픽업/배송 목록을 표시합니다.");
});

document.querySelector(".admin-logistics-list")?.addEventListener("change", (event) => {
  const row = event.target.closest("tr[data-order-id]");
  if (!row || !event.target.classList.contains("admin-logistics-status")) return;
  const logisticsStatus = event.target.value;
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
document.querySelector(".admin-status-filter")?.addEventListener("change", renderAdminOrders);

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

adminCustomerCancel?.addEventListener("click", resetAdminCustomerForm);

document.querySelector(".admin-customer-list")?.addEventListener("click", (event) => {
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
    document.querySelector(".admin-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  if (event.target.closest(".admin-customer-edit")) {
    editAdminCustomer(row.dataset.savedCustomerId || row.dataset.customerId);
    return;
  }

  if (event.target.closest(".admin-customer-delete")) {
    const savedCustomerId = row.dataset.savedCustomerId;
    if (!savedCustomerId) return;
    if (!confirm("직접 등록한 고객을 삭제할까요? 주문 내역은 삭제되지 않습니다.")) return;
    deleteAdminCustomer(savedCustomerId);
  }
});

// 결제 링크 생성 및 복사
async function createPaymentLink(orderId, amount) {
  if (!getApiToken()) {
    alert("로그인 후 사용할 수 있습니다.");
    return;
  }
  const result = await apiFetch("/payments", { method: "POST", body: { orderId, amount } });
  if (!result || result.error) {
    alert(result?.error || "결제 링크 생성에 실패했습니다.");
    return;
  }

  // pay.html의 위치 기준으로 URL 생성
  const payBase = location.href.replace(/\/[^/]*$/, "/pay.html");
  const payUrl = `${payBase}?orderId=${encodeURIComponent(orderId)}`;

  const copied = await navigator.clipboard.writeText(payUrl).then(() => true).catch(() => false);
  if (copied) {
    setAdminFeedback(`결제 링크가 클립보드에 복사되었습니다 — ${formatWon(amount)}`);
  } else {
    prompt("아래 링크를 고객에게 전달하세요:", payUrl);
  }
}

adminInventoryForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAdminInventory(new FormData(adminInventoryForm));
});

adminInventoryCancel?.addEventListener("click", resetAdminInventoryForm);
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

adminSupplierCancel?.addEventListener("click", resetSupplierForm);

document.querySelector(".admin-supplier-list")?.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-supplier-id]");
  if (!row) return;
  if (event.target.closest(".admin-supplier-edit")) {
    editSupplier(row.dataset.supplierId);
    return;
  }
  if (event.target.closest(".admin-supplier-delete")) {
    if (!confirm("공급처를 삭제할까요? 기존 발주 기록은 유지됩니다.")) return;
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

  if (event.target.closest(".admin-inventory-delete")) {
    deleteAdminInventory(row.dataset.inventoryId);
  }
});

document.querySelector(".admin-purchase-list")?.addEventListener("click", (event) => {
  const button = event.target.closest(".admin-purchase-request");
  if (!button) return;
  const row = button.closest("tr[data-purchase-id]");
  const amount = Number(row?.dataset.purchaseAmount || 0);
  if (!row || amount <= 0) return;
  if (!confirm(`권장 수량 ${formatMaterialAmount(amount)}을 발주 요청으로 등록할까요?`)) return;
  createPurchaseOrder(row.dataset.purchaseId, amount);
});

document.querySelector(".admin-purchase-order-list")?.addEventListener("change", (event) => {
  const row = event.target.closest("tr[data-purchase-order-id]");
  if (!row) return;

  if (event.target.classList.contains("admin-purchase-supplier")) {
    updatePurchaseOrderDetails(row.dataset.purchaseOrderId, { supplier: event.target.value.trim() });
    return;
  }

  if (event.target.classList.contains("admin-purchase-unit-cost")) {
    updatePurchaseOrderDetails(row.dataset.purchaseOrderId, { unitCost: Number(event.target.value || 0) });
    return;
  }

  if (event.target.classList.contains("admin-purchase-status")) {
    if (event.target.value === "입고완료" && !confirm("입고완료 처리하고 현재 재고에 수량을 반영할까요?")) {
      renderPurchaseOrders();
      return;
    }
    updatePurchaseOrderStatus(row.dataset.purchaseOrderId, event.target.value);
  }
});

document.querySelector(".admin-purchase-order-list")?.addEventListener("click", (event) => {
  const button = event.target.closest(".admin-purchase-delete");
  if (!button) return;
  const row = button.closest("tr[data-purchase-order-id]");
  if (!row || !confirm("이 발주 기록을 삭제할까요?")) return;
  writePurchaseOrders(readPurchaseOrders().filter((order) => order.id !== row.dataset.purchaseOrderId));
  renderAdminDashboard();
  setAdminFeedback("발주 기록을 삭제했습니다.");
});

document.querySelector(".admin-recipe-list")?.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-recipe-index]");
  if (!row) return;

  if (event.target.closest(".admin-recipe-save")) {
    saveRecipeRow(row);
    return;
  }

  if (event.target.closest(".admin-recipe-delete")) {
    if (!confirm("원재료 배합 기준을 삭제할까요?")) return;
    deleteRecipe(row.dataset.recipeIndex);
  }
});

document.querySelector(".admin-tabs")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-tab]");
  if (!button) return;
  setAdminTab(button.dataset.adminTab);
});

document.querySelector(".admin-flow")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-flow-tab]");
  if (!button) return;
  setAdminTab(button.dataset.adminFlowTab);
  document.querySelector(".admin-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelector(".admin-erp-map")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-flow-tab]");
  if (!button) return;
  setAdminTab(button.dataset.adminFlowTab);
  document.querySelector(".admin-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelector(".admin-alert-center")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-flow-tab]");
  if (!button) return;
  setAdminTab(button.dataset.adminFlowTab);
  document.querySelector(".admin-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelector(".admin-activity-list")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-activity-tab]");
  if (!button) return;
  setAdminTab(button.dataset.adminActivityTab);
  document.querySelector(".admin-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelector(".admin-activity-clear")?.addEventListener("click", () => {
  if (!confirm("최근 활동 기록을 모두 비울까요?")) return;
  writeActivityLogs([]);
  renderActivityLogs();
  setAdminFeedback("최근 활동 기록을 비웠습니다.");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeProductDetail();
    closeOrderRequest();
    closeAdminOrderCreate();
  }
});

updateMenuList();
renderAdminDashboard();
setAdminTab("orders");

if (document.querySelector(".admin-tabs")) {
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
