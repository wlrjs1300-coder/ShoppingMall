// 포트폴리오 시연용 예시 정보이며 실제 매장 상세 주소가 아닙니다.
const siteInfo = {
  phone: "031-000-0000",
  hours: "09:00 - 19:00",
  address: "경기도 화성시 소재",
  parking: "건물 내 주차 공간 이용 가능",
  storeUrl: "https://smartstore.naver.com/",
};

let phoneHref = `tel:${siteInfo.phone.replaceAll("-", "")}`;
let mapUrl = `https://map.naver.com/p/search/${encodeURIComponent(siteInfo.address)}`;
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
const pendingSyncStorageKey = "tteokPendingSync";
const API_BASE = window.location.protocol === "file:"
  ? "http://localhost:3001/api"
  : `${window.location.origin}/api`;

function applySiteInfo() {
  phoneHref = `tel:${siteInfo.phone.replaceAll("-", "")}`;
  mapUrl = `https://map.naver.com/p/search/${encodeURIComponent(siteInfo.address)}`;
  document.querySelectorAll(".js-store-name").forEach((element) => { element.textContent = siteInfo.name || "따뜻한 떡집"; });
  document.querySelectorAll(".js-phone-text").forEach((element) => { element.textContent = siteInfo.phone; });
  document.querySelectorAll(".js-phone-link").forEach((link) => { link.href = phoneHref; });
  document.querySelectorAll(".js-hours-text").forEach((element) => { element.textContent = siteInfo.hours; });
  document.querySelectorAll(".js-address-text").forEach((element) => { element.textContent = siteInfo.address; });
  document.querySelectorAll(".js-parking-text").forEach((element) => { element.textContent = siteInfo.parking; });
  document.querySelectorAll(".js-map-link").forEach((link) => { link.href = mapUrl; });
  document.querySelectorAll(".js-store-link").forEach((link) => { link.href = siteInfo.storeUrl; });
}

window.siteInfoReady = fetch(`${API_BASE}/site-config`, { headers: { Accept: "application/json" } })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("site config unavailable")))
  .then((data) => { Object.assign(siteInfo, data); applySiteInfo(); return siteInfo; })
  .catch(() => siteInfo);
