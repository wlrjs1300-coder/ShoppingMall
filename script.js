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

const heroSlides = [...document.querySelectorAll(".hero-slide")];
const heroDotsContainer = document.querySelector("[data-hero-dots]");
const heroPosition = document.querySelector("[data-hero-position]");
const heroPrev = document.querySelector("[data-hero-prev]");
const heroNext = document.querySelector("[data-hero-next]");
const heroToggle = document.querySelector("[data-hero-toggle]");
const heroToggleIcon = document.querySelector("[data-hero-toggle-icon]");
let heroIndex = 0;
let heroTimer = null;
const heroIntervalMs = 5000;

if (heroSlides.length > 1) {
  heroDotsContainer?.append(
    ...heroSlides.map((_, index) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.setAttribute("aria-label", `${index + 1}번 배너로 이동`);
      if (index === 0) dot.classList.add("is-active");
      dot.addEventListener("click", () => goToHeroSlide(index));
      return dot;
    })
  );

  function renderHeroSlide() {
    heroSlides.forEach((slide, index) => slide.classList.toggle("is-active", index === heroIndex));
    heroDotsContainer?.querySelectorAll("button").forEach((dot, index) => dot.classList.toggle("is-active", index === heroIndex));
    if (heroPosition) heroPosition.textContent = `${heroIndex + 1} / ${heroSlides.length}`;
  }

  function goToHeroSlide(index) {
    heroIndex = (index + heroSlides.length) % heroSlides.length;
    renderHeroSlide();
  }

  function startHeroAutoplay() {
    stopHeroAutoplay();
    heroTimer = setInterval(() => goToHeroSlide(heroIndex + 1), heroIntervalMs);
  }

  function stopHeroAutoplay() {
    if (heroTimer) clearInterval(heroTimer);
    heroTimer = null;
  }

  heroPrev?.addEventListener("click", () => goToHeroSlide(heroIndex - 1));
  heroNext?.addEventListener("click", () => goToHeroSlide(heroIndex + 1));

  heroToggle?.addEventListener("click", () => {
    const isPlaying = heroToggle.dataset.playing === "true";
    if (isPlaying) {
      stopHeroAutoplay();
      heroToggle.dataset.playing = "false";
      heroToggle.setAttribute("aria-label", "배너 자동재생 시작");
      if (heroToggleIcon) heroToggleIcon.textContent = "▶";
    } else {
      startHeroAutoplay();
      heroToggle.dataset.playing = "true";
      heroToggle.setAttribute("aria-label", "배너 자동재생 일시정지");
      if (heroToggleIcon) heroToggleIcon.textContent = "❚❚";
    }
  });

  renderHeroSlide();
  startHeroAutoplay();
}

const menuSearch = document.querySelector("#menuSearch");
const menuItems = [...document.querySelectorAll(".menu-item")];
const menuButtons = [...document.querySelectorAll(".menu-filters button, .menu-category-bar button")];
const menuEmpty = document.querySelector(".menu-empty");
const menuPagination = document.querySelector(".menu-pagination");
const menuResultCount = document.querySelector("[data-menu-result-count]");
const featuredGrid = document.querySelector(".featured-food-grid");
const featuredCards = [...document.querySelectorAll(".featured-food-grid > .food-card")];
const featuredPrev = document.querySelector("[data-featured-prev]");
const featuredNext = document.querySelector("[data-featured-next]");
const featuredPosition = document.querySelector("[data-featured-position]");
let activeMenuFilter = "all";
let activeMenuPage = 1;
const menuPageSize = 12;

function updateMenuList() {
  const query = (menuSearch?.value || "").trim().toLowerCase();
  const matchedItems = [];

  menuItems.forEach((item) => {
    const searchable = [item.dataset.name, item.dataset.category, item.textContent].filter(Boolean).join(" ").toLowerCase();
    const category = item.dataset.category || "";
    const matchesQuery = !query || searchable.includes(query);
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
  if (menuResultCount) menuResultCount.textContent = String(matchedItems.length);
}

function getFeaturedCardIndex() {
  if (!featuredGrid || !featuredCards.length) return 0;
  const gridLeft = featuredGrid.getBoundingClientRect().left;
  return featuredCards.reduce((closestIndex, card, index) => (
    Math.abs(card.getBoundingClientRect().left - gridLeft)
      < Math.abs(featuredCards[closestIndex].getBoundingClientRect().left - gridLeft)
      ? index
      : closestIndex
  ), 0);
}

function updateFeaturedCarousel() {
  if (!featuredGrid || !featuredCards.length) return;
  const index = getFeaturedCardIndex();
  if (featuredPosition) featuredPosition.textContent = `${index + 1} / ${featuredCards.length}`;
  if (featuredPrev) featuredPrev.disabled = index === 0;
  if (featuredNext) featuredNext.disabled = index === featuredCards.length - 1;
}

function moveFeaturedCarousel(direction) {
  if (!featuredGrid || !featuredCards.length) return;
  const nextIndex = Math.max(0, Math.min(featuredCards.length - 1, getFeaturedCardIndex() + direction));
  featuredGrid.scrollTo({ left: featuredCards[nextIndex].offsetLeft - featuredGrid.offsetLeft, behavior: "smooth" });
}

featuredPrev?.addEventListener("click", () => moveFeaturedCarousel(-1));
featuredNext?.addEventListener("click", () => moveFeaturedCarousel(1));
featuredGrid?.addEventListener("scroll", () => requestAnimationFrame(updateFeaturedCarousel), { passive: true });
window.addEventListener("resize", updateFeaturedCarousel);
updateFeaturedCarousel();

menuSearch?.addEventListener("input", () => {
  activeMenuPage = 1;
  updateMenuList();
});

document.querySelector(".header-search")?.addEventListener("submit", (event) => {
  if (menuItems.length) {
    event.preventDefault();
  }
});

if (menuSearch && menuItems.length) {
  const queryFromUrl = new URLSearchParams(window.location.search).get("q");
  if (queryFromUrl) {
    menuSearch.value = queryFromUrl;
    updateMenuList();
  }
}

menuButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeMenuFilter = button.dataset.filter || "all";
    activeMenuPage = 1;
    menuButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    updateMenuList();
  });
});

if (menuButtons.length) {
  const filterFromUrl = new URLSearchParams(window.location.search).get("filter");
  const matchedButton = filterFromUrl && menuButtons.find((button) => button.dataset.filter === filterFromUrl);
  if (matchedButton) {
    activeMenuFilter = filterFromUrl;
    menuButtons.forEach((item) => item.classList.toggle("is-active", item === matchedButton));
    updateMenuList();
  }
}

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
      const profit = Number(order.revenue || 0) - Number(order.cost || 0);
      return `
        <tr data-order-id="${escapeHtml(order.id)}" data-status="${escapeHtml(order.status || "접수대기")}">
          <td>${created}</td>
          <td><strong>${escapeHtml(order.customer || "-")}</strong><span>${escapeHtml(order.phone || "")}</span></td>
          <td><strong>${escapeHtml(order.product || "-")}</strong><span>${escapeHtml(order.priceText || "상담 후 안내")}</span></td>
          <td>${order.quantity || 1}</td>
          <td><strong>${escapeHtml(pickup || "-")}</strong><span>${fulfillment}</span></td>
          <td>
            <select class="admin-status" data-status-value="${escapeHtml(order.status || "접수대기")}">
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
  closeAdminFormDrawer("customer");
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
  openAdminFormDrawer("customer", { editing: true });
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
  closeAdminFormDrawer("inventory");
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
  openAdminFormDrawer("inventory", { editing: true });
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
  closeAdminFormDrawer("supplier");
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
  openAdminFormDrawer("supplier", { editing: true });
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
            <select class="admin-logistics-status" data-status-value="${escapeHtml(currentStatus)}">
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

function requestAccountingChartResize() {
  if (!accountingChartInstance) return;

  // Chart.js가 숨겨진 상위 탭/서브탭 안에서 0px 너비로 계산되는 것을 피합니다.
  // 두 단계의 프레임을 기다려 hidden 해제와 서브탭 진입 애니메이션이 반영된 뒤
  // 실제로 보이는 경우에만 크기를 다시 계산합니다.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector(".admin-revenue-chart");
      if (!canvas || canvas.hidden || canvas.closest("[hidden]")) return;
      accountingChartInstance.resize();
    });
  });
}

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
  const button = document.querySelector(`[data-alert-type="${type}"]`);
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
  applyAdminTableLabels();
  reapplyAdminTableSorting();
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
  closeAdminFormDrawer();

  document.querySelectorAll("[data-admin-tab]").forEach((tab) => {
    const isActive = tab.dataset.adminTab === tabName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  Object.entries(panels).forEach(([name, panel]) => {
    if (!panel) return;
    if (name !== tabName) {
      panel.hidden = true;
      panel.classList.remove("is-entering");
    } else {
      panel.hidden = false;
      panel.classList.remove("is-entering");
      requestAnimationFrame(() => panel.classList.add("is-entering"));
    }
  });

  if (tabName === "accounting") requestAccountingChartResize();
}

function setAdminSubtab(groupName, tabName, { focus = false } = {}) {
  const tabs = [...document.querySelectorAll(`[data-admin-subtab-group="${groupName}"][data-admin-subtab]`)];
  const panels = [...document.querySelectorAll(`[data-admin-subpanel-group="${groupName}"][data-admin-subpanel]`)];
  if (!tabs.some((tab) => tab.dataset.adminSubtab === tabName)) return;

  tabs.forEach((tab) => {
    const isActive = tab.dataset.adminSubtab === tabName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    if (isActive && focus) tab.focus();
  });

  panels.forEach((panel) => {
    const isActive = panel.dataset.adminSubpanel === tabName;
    panel.hidden = !isActive;
    panel.classList.remove("is-entering");
    if (isActive) requestAnimationFrame(() => panel.classList.add("is-entering"));
  });

  if (groupName === "accounting" && tabName === "trends") requestAccountingChartResize();
}

function initAdminSubtabs() {
  const groups = new Set(
    [...document.querySelectorAll("[data-admin-subtab-group][data-admin-subtab]")].map((tab) => tab.dataset.adminSubtabGroup),
  );
  groups.forEach((groupName) => {
    const active = document.querySelector(`[data-admin-subtab-group="${groupName}"].is-active`)
      || document.querySelector(`[data-admin-subtab-group="${groupName}"][data-admin-subtab]`);
    if (active) setAdminSubtab(groupName, active.dataset.adminSubtab);
  });
}

function getAdminCellSortText(cell) {
  if (!cell) return "";
  if (cell.dataset.sortValue !== undefined) return cell.dataset.sortValue.trim();
  const field = cell.querySelector("input, select, textarea");
  return (field?.value || cell.textContent || "").replace(/\s+/g, " ").trim();
}

function isAdminNumericSortValue(value) {
  return /^[+-]?[\d,.]+\s*(?:원|건|개|명|곳|회|kg|g|봉|팩|장|%|개입)?$/i.test(value.replace(/\s+/g, ""));
}

function parseAdminSortNumber(value) {
  const normalized = value.replace(/,/g, "").match(/[+-]?(?:\d+\.?\d*|\.\d+)/)?.[0];
  return normalized === undefined ? Number.NEGATIVE_INFINITY : Number(normalized);
}

function sortAdminTable(table, columnIndex, direction = "ascending", requestedType = "auto") {
  const body = table?.tBodies?.[0];
  if (!body) return;

  const rows = [...body.rows];
  const values = rows.map((row, index) => ({ row, index, value: getAdminCellSortText(row.cells[columnIndex]) }));
  const populatedValues = values.map((item) => item.value).filter(Boolean);
  const sortType = requestedType === "auto"
    ? (populatedValues.length > 0 && populatedValues.every(isAdminNumericSortValue) ? "number" : "text")
    : requestedType;
  const multiplier = direction === "descending" ? -1 : 1;
  const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

  values.sort((a, b) => {
    const result = sortType === "number"
      ? parseAdminSortNumber(a.value) - parseAdminSortNumber(b.value)
      : collator.compare(a.value, b.value);
    return result === 0 ? a.index - b.index : result * multiplier;
  });
  values.forEach(({ row }) => body.append(row));
}

function initAdminTableSorting() {
  document.querySelectorAll(".admin-main .admin-table, .admin-main .admin-mini-table").forEach((table) => {
    table.querySelectorAll("thead th").forEach((header) => {
      const label = header.textContent.trim();
      if (header.dataset.sortable === "false" || ["관리", "처리"].includes(label)) return;
      header.classList.add("admin-sortable-header");
      header.tabIndex = 0;
      header.setAttribute("aria-sort", "none");
      header.title = `${label} 기준 정렬`;
    });
  });
}

function reapplyAdminTableSorting() {
  document.querySelectorAll(".admin-main th[aria-sort='ascending'], .admin-main th[aria-sort='descending']").forEach((header) => {
    sortAdminTable(
      header.closest("table"),
      header.cellIndex,
      header.getAttribute("aria-sort"),
      header.dataset.sortType || "auto",
    );
  });
}

function applyAdminTableLabels() {
  document.querySelectorAll(".admin-main .admin-table").forEach((table) => {
    const labels = [...table.querySelectorAll("thead th")].map((header) => header.textContent.replace(/[↕↑↓]/g, "").trim());
    table.querySelectorAll("tbody tr").forEach((row) => {
      [...row.cells].forEach((cell, index) => {
        cell.dataset.label = labels[index] || "정보";
      });
    });
  });
}

function handleAdminTableSort(header) {
  if (!header?.classList.contains("admin-sortable-header")) return;
  const table = header.closest("table");
  const nextDirection = header.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
  table.querySelectorAll("thead th[aria-sort]").forEach((current) => current.setAttribute("aria-sort", "none"));
  header.setAttribute("aria-sort", nextDirection);
  sortAdminTable(table, header.cellIndex, nextDirection, header.dataset.sortType || "auto");
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

// 포트폴리오 화면 캡처용 데모 데이터입니다. 아래 이름·연락처·주소·매출·재고 수치는
// 모두 가상값이며 실제 고객·매장·거래 정보가 아닙니다. admin.html?dev=1에서만 노출되는
// "데모 생성" 버튼으로만 실행되며, 이미 생성된 경우 중복 삽입되지 않도록 id 접두사로 확인합니다.
const DEMO_SEED_ID_PREFIX = "demo-seed";

function createDemoOrders() {
  if (readOrders().some((order) => String(order.id).startsWith(DEMO_SEED_ID_PREFIX))) {
    alert("포트폴리오용 데모 데이터가 이미 생성되어 있습니다. 다시 만들려면 먼저 운영 데이터를 초기화해 주세요.");
    return;
  }
  if (!confirm("포트폴리오 캡처용 주문·재고·발주 데모 데이터를 대량으로 추가할까요? 기존 데이터는 유지됩니다.")) return;

  const today = new Date();

  const demoCustomers = [
    { name: "김하늘", phone: "010-0000-0001" },
    { name: "이서준", phone: "010-0000-0002" },
    { name: "박지우", phone: "010-0000-0003" },
    { name: "최유진", phone: "010-0000-0004" },
    { name: "정민서", phone: "010-0000-0005" },
    { name: "한도윤", phone: "010-0000-0006" },
  ];
  const demoGroupCustomers = [
    { name: "인근 사무실", phone: "010-0000-0007" },
    { name: "지역 행사장", phone: "010-0000-0008" },
  ];
  const demoProducts = [
    { product: "백설기", unitPrice: 2500 },
    { product: "꿀설기", unitPrice: 3000 },
    { product: "무지개떡", unitPrice: 2800 },
    { product: "인절미", unitPrice: 3500 },
    { product: "쑥인절미", unitPrice: 3800 },
    { product: "찹쌀떡", unitPrice: 1800 },
    { product: "약식", unitPrice: 4000 },
    { product: "송편", unitPrice: 4000 },
    { product: "영양떡", unitPrice: 3300 },
  ];
  const demoGroupProducts = ["답례떡 세트", "단체주문"];
  const deliveryAddresses = ["인근 사무실 배송", "지역 행사장 배송", "경기도 화성시 소재"];

  let seq = 0;
  let groupSeq = 0;
  let individualSeq = 0;
  const demoOrders = [];

  // status 배열에 "TERMINAL"을 넣으면 주문의 실제 수령방식(픽업/배송)에 맞는
  // 종료 상태(픽업완료/배송완료)로 자동 치환됩니다. "배송중"은 기존 주문 상태 select의
  // 유연한 처리(목록에 없는 값도 추가 옵션으로 표시)를 그대로 활용한 값입니다.
  // customer·product는 groupSeq/individualSeq로 별도 관리해 6분주기(isGroup 판정)와
  // 어긋나지 않도록 하여 가상 고객·상품 목록 전체가 고르게 돌아가며 쓰이게 합니다.
  const pushOrder = (daysAgo, statusPool) => {
    const createdAtDate = new Date(today.getTime() - daysAgo * 86400000);
    const isGroup = seq % 6 === 5;
    const customerPool = isGroup ? demoGroupCustomers : demoCustomers;
    const customer = isGroup ? customerPool[groupSeq % customerPool.length] : customerPool[individualSeq % customerPool.length];
    let status = statusPool[seq % statusPool.length];
    const fulfillmentType = status === "배송중" ? "delivery" : seq % 4 === 0 ? "delivery" : "pickup";
    if (status === "TERMINAL") status = getTerminalStatus(fulfillmentType);
    const isCancelled = status === "취소";

    let product;
    let unitPrice;
    let quantity;
    let priceText;
    if (isGroup) {
      product = demoGroupProducts[groupSeq % demoGroupProducts.length];
      quantity = 40 + ((seq * 7) % 80);
      unitPrice = 0;
      priceText = "상담 후 안내";
      groupSeq += 1;
    } else {
      const pick = demoProducts[individualSeq % demoProducts.length];
      product = pick.product;
      unitPrice = pick.unitPrice;
      quantity = 8 + ((seq * 3) % 22);
      priceText = `${unitPrice.toLocaleString("ko-KR")}원`;
      individualSeq += 1;
    }

    const baseRevenue = isGroup ? 90000 + ((seq * 12500) % 260000) : unitPrice * quantity;
    const revenue = isCancelled ? 0 : baseRevenue;
    const cost = isCancelled ? 0 : Math.round(baseRevenue * (0.55 + (seq % 5) * 0.02));
    const deliveryAddress = fulfillmentType === "delivery" ? deliveryAddresses[seq % deliveryAddresses.length] : "매장 방문 수령";
    const logisticsStatus = status === "배송중"
      ? "이동중"
      : status === getTerminalStatus(fulfillmentType)
        ? "완료"
        : getDefaultLogisticsStatus(fulfillmentType);

    demoOrders.push({
      id: `${DEMO_SEED_ID_PREFIX}-order-${seq + 1}`,
      createdAt: createdAtDate.toISOString(),
      product,
      priceText,
      quantity,
      pickupDate: new Date(createdAtDate.getTime() + 86400000 * (1 + (seq % 4))).toISOString().slice(0, 10),
      pickupTime: ["09:00", "10:30", "13:00", "16:30"][seq % 4],
      customer: customer.name,
      phone: customer.phone,
      memo: isGroup ? "단체·행사 주문, 사전 협의 필요" : "",
      status,
      revenue,
      cost,
      unitPrice,
      fulfillmentType,
      deliveryAddress,
      logisticsStatus,
    });
    seq += 1;
  };

  // 이번 달(최근 7일 위주)은 접수부터 완료·취소까지 7개 상태가 고르게 섞이도록 배치합니다.
  const currentStatusPool = [
    "접수대기", "결제완료", "준비중", "준비완료", "배송중", "TERMINAL", "취소",
    "접수대기", "결제완료", "준비중", "준비완료", "배송중", "TERMINAL", "취소",
    "접수대기",
  ];
  [6, 6, 5, 4, 3, 2, 1, 1, 0, 0, 9, 8, 10, 11, 12].forEach((daysAgo) => pushOrder(daysAgo, currentStatusPool));

  // 지난달 이전은 완료 이력 비중이 높지만, 7개 상태가 한쪽으로 치우치지 않도록
  // 완료(TERMINAL) 외 6개 상태도 고르게 섞어 배치합니다. 명절(추석·설) 전후 달은
  // 주문 건수를 소폭 늘려 매출관리 12개월 차트가 성수기 흐름과 함께 채워지도록 구성합니다.
  const historyStatusPool = [
    "TERMINAL", "접수대기", "TERMINAL", "결제완료", "TERMINAL", "준비중",
    "TERMINAL", "준비완료", "TERMINAL", "배송중", "TERMINAL", "취소", "TERMINAL",
  ];
  const monthPlan = [
    { monthsAgo: 1, count: 3 },
    { monthsAgo: 2, count: 2 },
    { monthsAgo: 3, count: 2 },
    { monthsAgo: 4, count: 2 },
    { monthsAgo: 5, count: 6 }, // 설 연휴 성수기
    { monthsAgo: 6, count: 5 }, // 설 연휴 준비
    { monthsAgo: 7, count: 3 },
    { monthsAgo: 8, count: 3 },
    { monthsAgo: 9, count: 6 }, // 추석 연휴 성수기
    { monthsAgo: 10, count: 5 }, // 추석 연휴 준비
    { monthsAgo: 11, count: 2 },
  ];
  monthPlan.forEach(({ monthsAgo, count }) => {
    for (let i = 0; i < count; i += 1) {
      const spread = Math.round((i + 1) * (26 / (count + 1)));
      pushOrder(monthsAgo * 30 + spread, historyStatusPool);
    }
  });

  // 재고관리 화면에 정상·주의·부족 상태가 모두 보이도록 구성한 원재료 목록입니다.
  // 상태(정상/주의/부족)는 하드코딩하지 않고 stock·safeStock 값으로 getInventoryStatus()가 계산합니다.
  const now = new Date().toISOString();
  const existingInventory = readInventory();
  const existingInventoryNames = new Set(existingInventory.map((item) => item.name));
  const inventorySamples = [
    { name: "멥쌀가루", stock: 45, unit: "kg", safeStock: 15, memo: "기본 떡류 공통 원재료" },
    { name: "찹쌀가루", stock: 28, unit: "kg", safeStock: 12, memo: "찰떡·인절미용" },
    { name: "쑥가루", stock: 4, unit: "kg", safeStock: 3, memo: "쑥인절미·쑥절편용" },
    { name: "팥앙금", stock: 7, unit: "kg", safeStock: 5, memo: "백일떡·수수팥떡용" },
    { name: "콩가루", stock: 2, unit: "kg", safeStock: 4, memo: "인절미 고물용" },
    { name: "흑임자", stock: 1.5, unit: "kg", safeStock: 3, memo: "약식·고물용" },
    { name: "설탕", stock: 20, unit: "kg", safeStock: 8, memo: "기본 감미료" },
    { name: "소금", stock: 10, unit: "kg", safeStock: 4, memo: "기본 부재료" },
    { name: "대추", stock: 3, unit: "kg", safeStock: 2.5, memo: "고명용" },
    { name: "견과류", stock: 2, unit: "kg", safeStock: 3, memo: "약식·모듬떡용" },
    { name: "포장용기", stock: 300, unit: "개", safeStock: 100, memo: "낱개 포장용" },
    { name: "보자기", stock: 150, unit: "장", safeStock: 60, memo: "선물·답례용 포장" },
    { name: "스티커", stock: 80, unit: "장", safeStock: 60, memo: "브랜드 라벨용" },
  ]
    .filter((item) => !existingInventoryNames.has(item.name))
    .map((item, index) => ({
      id: `${DEMO_SEED_ID_PREFIX}-inventory-${index}`,
      ...item,
      createdAt: now,
      updatedAt: now,
    }));
  const mergedInventory = [...inventorySamples, ...existingInventory];

  // 공급처 관리 화면용 가상 거래처입니다.
  const existingSuppliers = readSuppliers();
  const existingSupplierNames = new Set(existingSuppliers.map((supplier) => supplier.name));
  const supplierSamples = [
    { name: "화성곡물상회", phone: "031-000-0101", items: "멥쌀가루, 찹쌀가루, 설탕", memo: "쌀가루류 정기 납품" },
    { name: "동탄제과원료", phone: "031-000-0102", items: "팥앙금, 콩가루, 흑임자", memo: "앙금·고물류 전담" },
    { name: "우리포장산업", phone: "031-000-0103", items: "포장용기, 보자기, 스티커", memo: "포장재 전담" },
    { name: "경기농산물유통", phone: "031-000-0104", items: "대추, 견과류, 쑥가루", memo: "부재료·건과 공급" },
  ]
    .filter((supplier) => !existingSupplierNames.has(supplier.name))
    .map((supplier) => ({
      id: `${DEMO_SEED_ID_PREFIX}-supplier-${supplier.name}`,
      ...supplier,
      createdAt: now,
      updatedAt: now,
    }));

  // 발주 진행 현황에 완료 이력과 진행 중 발주가 함께 보이도록 구성합니다.
  // (부족 상태인 견과류는 일부러 발주를 만들지 않아 "발주 후보"로 남겨둡니다.)
  const purchasePlan = [
    { name: "멥쌀가루", supplier: "화성곡물상회", amount: 30, unitCost: 2200, status: "입고완료", daysAgo: 55 },
    { name: "찹쌀가루", supplier: "화성곡물상회", amount: 20, unitCost: 2800, status: "입고완료", daysAgo: 30 },
    { name: "설탕", supplier: "화성곡물상회", amount: 15, unitCost: 1800, status: "입고완료", daysAgo: 10 },
    { name: "포장용기", supplier: "우리포장산업", amount: 200, unitCost: 150, status: "입고완료", daysAgo: 80 },
    { name: "보자기", supplier: "우리포장산업", amount: 100, unitCost: 400, status: "입고완료", daysAgo: 14 },
    { name: "콩가루", supplier: "동탄제과원료", amount: 6, unitCost: 3200, status: "발주요청", daysAgo: 1 },
    { name: "흑임자", supplier: "동탄제과원료", amount: 5, unitCost: 5000, status: "발주중", daysAgo: 3 },
  ];
  const purchaseOrderSamples = purchasePlan
    .map((plan, index) => {
      const item = mergedInventory.find((inv) => inv.name === plan.name);
      if (!item) return null;
      const createdAtDate = new Date(today.getTime() - plan.daysAgo * 86400000);
      const isReceived = plan.status === "입고완료";
      return {
        id: `${DEMO_SEED_ID_PREFIX}-purchase-${index}`,
        inventoryId: item.id,
        name: plan.name,
        amount: plan.amount,
        unit: item.unit,
        supplier: plan.supplier,
        unitCost: plan.unitCost,
        status: plan.status,
        createdAt: createdAtDate.toISOString(),
        ...(isReceived ? { receivedAt: createdAtDate.toISOString() } : {}),
      };
    })
    .filter(Boolean);

  writeInventory([...inventorySamples, ...existingInventory]);
  writeSuppliers([...supplierSamples, ...existingSuppliers]);
  writePurchaseOrders([...purchaseOrderSamples, ...readPurchaseOrders()]);
  writeOrders([...demoOrders, ...readOrders()]);
  addActivityLog(
    "데모",
    `포트폴리오 캡처용 주문 ${demoOrders.length}건, 재고 ${inventorySamples.length}건, 발주 ${purchaseOrderSamples.length}건을 추가했습니다.`,
    "orders",
  );
  renderAdminDashboard();
  setAdminTab("orders");
  setAdminFeedback(
    `포트폴리오용 데모 데이터를 추가했습니다. (주문 ${demoOrders.length}건 · 재고 ${inventorySamples.length}건 · 발주 ${purchaseOrderSamples.length}건)`,
  );
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

adminCustomerCancel?.addEventListener("click", () => {
  resetAdminCustomerForm();
  closeAdminFormDrawer("customer");
});

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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAdminFormDrawer();
    closeProductDetail();
    closeOrderRequest();
    closeAdminOrderCreate();
  }
});

updateMenuList();
renderAdminDashboard();
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
async function runFormSubmit(button, busyText, action) {
  if (!button) { await action(); return; }
  const defaultText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  let keepBusy = false;
  try {
    keepBusy = await action();
  } finally {
    if (!keepBusy) {
      button.disabled = false;
      button.textContent = defaultText;
    }
  }
}

// 회원가입/로그인 응답을 사용자 메시지로 매핑하는 공통 규칙 (400/409/429/500/네트워크 오류)
function describeAuthError(status, body, fallback) {
  if (status === 409) return body?.error || "이미 가입된 이메일입니다.";
  if (status === 429) return body?.error || "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 400 || status === 401) return body?.error || fallback;
  return "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

function showInlineNotice(text) {
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
    "background:#fff0f3;color:#c0445e;border:1px solid rgba(218,135,155,.5);" +
    "padding:10px 20px;border-radius:10px;font-size:0.84rem;z-index:99999;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.12);white-space:nowrap;";
  notice.textContent = text;
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 3500);
}

// ─── 회원가입 ────────────────────────────────────────────────
const signupForm = document.querySelector("[data-signup-form]");
if (signupForm) {
  const signupMessage = signupForm.querySelector("[data-signup-message]");
  const signupSubmitButton = signupForm.querySelector('[type="submit"]');

  // "전체 동의" 체크박스 ↔ 개별 약관 체크박스 동기화
  const agreeAllCheckbox = signupForm.querySelector("[data-agree-all]");
  const agreeCheckboxes = [
    ...signupForm.querySelectorAll('input[name="agreeTerms"], input[name="agreePrivacy"], input[name="agreeMarketing"]'),
  ];
  agreeAllCheckbox?.addEventListener("change", () => {
    agreeCheckboxes.forEach((checkbox) => { checkbox.checked = agreeAllCheckbox.checked; });
  });
  agreeCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (agreeAllCheckbox) agreeAllCheckbox.checked = agreeCheckboxes.every((c) => c.checked);
    });
  });

  signupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    signupMessage.classList.remove("is-success");
    signupMessage.textContent = "";

    const data = new FormData(signupForm);
    const name = String(data.get("name") || "").trim();
    const phoneDigits = String(data.get("phone") || "").replace(/\D/g, "");
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const passwordConfirm = String(data.get("passwordConfirm") || "");
    const postalCode = String(data.get("postalCode") || "").trim();
    const address = String(data.get("address") || "").trim();
    const addressDetail = String(data.get("addressDetail") || "").trim();
    const agreeTerms = Boolean(data.get("agreeTerms"));
    const agreePrivacy = Boolean(data.get("agreePrivacy"));
    const agreeMarketing = Boolean(data.get("agreeMarketing"));

    // 서버(server/utils/normalize.js, server/routes/users.js)와 최대한 동일한 규칙으로 검사
    if (!name || name.length > 50) {
      signupMessage.textContent = "이름을 확인해 주세요.";
      return;
    }
    if (!phoneDigits || !/^01[0-9]{8,9}$/.test(phoneDigits)) {
      signupMessage.textContent = "휴대폰 번호 형식을 확인해 주세요.";
      return;
    }
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      signupMessage.textContent = "이메일 형식을 확인해 주세요.";
      return;
    }
    // bcrypt는 72바이트를 넘는 입력을 조용히 잘라버리므로 문자 길이가 아닌 UTF-8 바이트로 검사한다
    const passwordBytes = new TextEncoder().encode(password).length;
    if (password.length < 8 || passwordBytes > 72) {
      signupMessage.textContent = "비밀번호는 8자 이상, 72바이트(영문 72자/한글 24자 이내)로 입력해 주세요.";
      return;
    }
    if (password !== passwordConfirm) {
      signupMessage.textContent = "비밀번호가 일치하지 않습니다.";
      return;
    }
    if (!address || address.length > 200) {
      signupMessage.textContent = "배송지 주소를 확인해 주세요.";
      return;
    }
    if (addressDetail.length > 200) {
      signupMessage.textContent = "상세 주소를 확인해 주세요.";
      return;
    }
    if (!agreeTerms || !agreePrivacy) {
      signupMessage.textContent = "필수 약관(이용약관, 개인정보 수집·이용)에 동의해 주세요.";
      return;
    }

    runFormSubmit(signupSubmitButton, "가입 처리 중...", async () => {
      try {
        // 고객 인증은 HttpOnly Cookie 방식이라 관리자용 apiFetch()(Authorization 헤더/sessionStorage 토큰)를
        // 쓰지 않고 일반 fetch로 호출한다. 같은 오리진이라 credentials는 명시하지 않아도 쿠키가 오가지만
        // 의도를 명확히 하기 위해 "same-origin"을 지정한다.
        const res = await fetch("/api/users/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            email, password, name,
            phone: phoneDigits,
            postalCode: postalCode || undefined,
            address,
            addressDetail: addressDetail || undefined,
            agreeTerms, agreePrivacy, agreeMarketing,
          }),
        });

        let body = null;
        try { body = await res.json(); } catch {}

        if (res.ok) {
          signupMessage.classList.add("is-success");
          signupMessage.textContent = "가입이 완료되었습니다. 홈으로 이동합니다.";
          if (signupSubmitButton) signupSubmitButton.textContent = "이동 중...";
          setTimeout(() => { window.location.href = "index.html"; }, 900);
          return true; // 리다이렉트 전까지 버튼 비활성 유지
        }

        signupMessage.textContent = describeAuthError(res.status, body, "입력값을 다시 확인해 주세요.");
        return false;
      } catch {
        signupMessage.textContent = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.";
        return false;
      }
    });
  });
}

// ─── 로그인 ──────────────────────────────────────────────────
const loginForm = document.querySelector("[data-login-form]");
if (loginForm) {
  const loginMessage = loginForm.querySelector("[data-login-message]");
  const loginSubmitButton = loginForm.querySelector('[type="submit"]');

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loginMessage.classList.remove("is-success");
    loginMessage.textContent = "";

    const data = new FormData(loginForm);
    const email = String(data.get("email") || "").trim();
    // 비밀번호는 trim하지 않는다 — 앞뒤 공백도 비밀번호의 일부일 수 있음
    const password = String(data.get("password") || "");

    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      loginMessage.textContent = "이메일 형식을 확인해 주세요.";
      return;
    }
    if (!password) {
      loginMessage.textContent = "비밀번호를 입력해 주세요.";
      return;
    }
    if (new TextEncoder().encode(password).length > 72) {
      loginMessage.textContent = "비밀번호 길이를 확인해 주세요.";
      return;
    }

    runFormSubmit(loginSubmitButton, "로그인 중...", async () => {
      try {
        const res = await fetch("/api/users/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password }),
        });

        let body = null;
        try { body = await res.json(); } catch {}

        if (res.ok) {
          loginMessage.classList.add("is-success");
          loginMessage.textContent = "로그인되었습니다. 홈으로 이동합니다.";
          if (loginSubmitButton) loginSubmitButton.textContent = "이동 중...";
          setTimeout(() => { window.location.href = "index.html"; }, 900);
          return true;
        }

        loginMessage.textContent = describeAuthError(res.status, body, "이메일 또는 비밀번호가 올바르지 않습니다.");
        return false;
      } catch {
        loginMessage.textContent = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.";
        return false;
      }
    });
  });
}

// ─── 헤더 로그인 상태 표시 (index/menu/faq/signup/login 공통) ──
const authSignupLink = document.querySelector("[data-auth-signup-link]");
const authLoginLink = document.querySelector("[data-auth-login-link]");
if (authSignupLink && authLoginLink) {
  const applyGuestHeader = () => {
    authSignupLink.textContent = "회원가입";
    authSignupLink.href = "signup.html";
    authSignupLink.removeAttribute("role");
    authSignupLink.onclick = null;
    authLoginLink.textContent = "로그인";
    authLoginLink.href = "login.html";
    authLoginLink.removeAttribute("role");
    authLoginLink.onclick = null;
  };

  const applyMemberHeader = () => {
    authSignupLink.textContent = "마이페이지";
    authSignupLink.href = "#";
    authSignupLink.setAttribute("role", "button");
    authSignupLink.onclick = (event) => {
      event.preventDefault();
      showInlineNotice("마이페이지는 준비 중입니다.");
    };
    authLoginLink.textContent = "로그아웃";
    authLoginLink.href = "#";
    authLoginLink.setAttribute("role", "button");
    authLoginLink.onclick = (event) => {
      event.preventDefault();
      // 고객 쿠키만 제거한다 — 관리자용 tteokApiToken(sessionStorage)은 손대지 않음
      fetch("/api/users/logout", { method: "POST", credentials: "same-origin" })
        .catch(() => {})
        .finally(() => {
          applyGuestHeader();
          showInlineNotice("로그아웃되었습니다.");
        });
    };
  };

  fetch("/api/users/me", { credentials: "same-origin" })
    .then((res) => (res.status === 200 ? res.json() : null))
    .then((body) => {
      if (body?.user) applyMemberHeader();
    })
    .catch(() => {
      // 네트워크 오류 시에도 비로그인 기본 상태(정적 HTML 그대로)를 유지하고 페이지 기능은 막지 않는다
    });
}
