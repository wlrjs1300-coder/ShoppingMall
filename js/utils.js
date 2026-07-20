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
