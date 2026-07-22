const menuEmpty = document.querySelector(".menu-empty");
const menuPagination = document.querySelector(".menu-pagination");
const menuResultCount = document.querySelector("[data-menu-result-count]");
const menuListTitle = document.querySelector("[data-menu-list-title]");
const menuGrid = document.querySelector("[data-products-grid]");
const featuredGrid = document.querySelector(".featured-food-grid");
let featuredCards = [];
const featuredPrev = document.querySelector("[data-featured-prev]");
const featuredNext = document.querySelector("[data-featured-next]");
const featuredPosition = document.querySelector("[data-featured-position]");
let activeMenuFilter = "all";
let activeMenuPage = 1;
const menuPageSize = 12;

function scrollToMenuListFromUrl() {
  if (window.location.hash !== "#menu-list") return;
  const menuList = document.querySelector("#menu-list");
  if (menuList) requestAnimationFrame(() => menuList.scrollIntoView({ block: "start" }));
}

function productPriceLabel(product) {
  return product.purchaseType === "direct" && Number(product.price) > 0
    ? `${Number(product.price).toLocaleString("ko-KR")}원`
    : "상담 후 안내";
}

function productPriceLines(product) {
  if (product.purchaseType !== "direct" || Number(product.price) <= 0) return `<strong>${productPriceLabel(product)}</strong>`;
  const packPrice = Number(product.price);
  const packWeight = Number(product.unitWeightGrams || 250);
  const malPrice = Math.round(packPrice * (8000 / packWeight));
  return `<div class="product-price-lines" aria-label="단위별 판매가">
    <span class="product-price-set"><span class="product-unit-label">1팩 ${packWeight.toLocaleString("ko-KR")}g</span><strong class="product-unit-price">${packPrice.toLocaleString("ko-KR")}원</strong></span>
    <span class="product-price-set"><span class="product-unit-label">반말</span><strong class="product-unit-price">${Math.round(malPrice / 2).toLocaleString("ko-KR")}원</strong></span>
    <span class="product-price-set"><span class="product-unit-label">한말</span><strong class="product-unit-price">${malPrice.toLocaleString("ko-KR")}원</strong></span>
  </div>`;
}

function homeProductPrice(product) {
  if (product.purchaseType !== "direct" || Number(product.price) <= 0) {
    return `<div class="home-card-consult"><strong>상담 후 안내</strong><span>구성과 수량을 맞춰드려요</span></div>`;
  }
  const packWeight = Number(product.unitWeightGrams || 250);
  return `<div class="home-card-price" aria-label="1팩 ${packWeight.toLocaleString("ko-KR")}그램 ${Number(product.price).toLocaleString("ko-KR")}원부터, 말 단위 가격은 상세 페이지에서 확인">
    <span>1팩 · ${packWeight.toLocaleString("ko-KR")}g</span>
    <strong>${Number(product.price).toLocaleString("ko-KR")}원부터</strong>
    <small>반말·한말 가격은 상세에서 확인</small>
  </div>`;
}

function productCardHtml(product, featured = false) {
  return `
    <article class="${featured ? "food-card" : "menu-item food-card small-food-card"}"
      tabindex="0" role="link" aria-label="${escapeHtml(product.name)} 상세 보기"
      data-product-id="${escapeHtml(product.id)}"
      data-category="${escapeHtml(product.category)}"
      data-name="${escapeHtml(product.name)}"
      data-price="${product.price === null ? "" : Number(product.price)}"
      data-purchase-type="${escapeHtml(product.purchaseType)}">
      <div class="food-card-image"><img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy" /></div>
      <div class="food-card-body">
        <span class="food-badge">${escapeHtml(product.category)}</span>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(product.description || "상품 설명을 준비하고 있습니다.")}</p>
        ${productPriceLines(product)}
      </div>
    </article>`;
}

function homeProductCardHtml(product, badge, badgeClass = "") {
  return `
    <a class="food-card home-best-card" data-product-id="${escapeHtml(product.id)}" href="product.html?id=${encodeURIComponent(product.id)}">
      <span class="ribbon-badge ${badgeClass}">${escapeHtml(badge)}</span>
      <div class="food-card-image"><img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy" /></div>
      <div class="food-card-body"><h3>${escapeHtml(product.name)}</h3>${homeProductPrice(product)}</div>
    </a>`;
}

async function loadHomeProducts() {
  const groups = [...document.querySelectorAll("[data-home-products]")];
  if (!groups.length) return;
  try {
    const response = await fetch(`${API_BASE}/products`, { cache: "no-store" });
    if (!response.ok) throw new Error("상품 API 응답 오류");
    const data = await response.json();
    if (!Array.isArray(data.products)) throw new Error("상품 API 형식 오류");
    const productMap = new Map(data.products.map((product) => [product.id, product]));
    const groupConfig = {
      featured: { ids: ["songpyeon-reserve", "baekil", "gift-box", "bulk-order"], badge: "베스트", badgeClass: "" },
      recommended: { ids: ["injeolmi", "chal-sirutteok", "honey-seolgi", "yaksik"], badge: "추천", badgeClass: "is-pick" },
    };
    groups.forEach((group) => {
      const config = groupConfig[group.dataset.homeProducts];
      const products = config ? config.ids.map((id) => productMap.get(id)).filter(Boolean) : [];
      group.innerHTML = products.length
        ? products.map((product) => homeProductCardHtml(product, config.badge, config.badgeClass)).join("")
        : `<div class="menu-catalog-state is-empty"><strong>현재 소개할 상품이 없습니다.</strong></div>`;
    });
  } catch {
    groups.forEach((group) => {
      group.innerHTML = `<div class="menu-catalog-state is-error" role="alert"><strong>상품을 불러오지 못했습니다.</strong></div>`;
    });
  }
}

function renderCatalogState(type, message) {
  if (!menuGrid) return;
  const retry = type === "error" ? `<button type="button" class="secondary-button" data-products-retry>다시 시도</button>` : "";
  menuGrid.innerHTML = `<div class="menu-catalog-state is-${type}" role="${type === "error" ? "alert" : "status"}"><strong>${escapeHtml(message)}</strong>${retry}</div>`;
  menuItems = [];
  if (menuResultCount) menuResultCount.textContent = "0";
  if (menuPagination) menuPagination.innerHTML = "";
}

async function loadProductCatalog() {
  if (!menuGrid) return;
  renderCatalogState("loading", "메뉴를 불러오고 있습니다.");
  if (featuredGrid) featuredGrid.innerHTML = `<div class="menu-catalog-state is-loading" role="status"><strong>BEST 상품을 불러오고 있습니다.</strong></div>`;
  try {
    const response = await fetch(`${API_BASE}/products`, { cache: "no-store" });
    if (!response.ok) throw new Error("상품 API 응답 오류");
    const data = await response.json();
    const products = Array.isArray(data.products) ? data.products : [];
    if (!products.length) {
      renderCatalogState("empty", "현재 판매 중인 상품이 없습니다.");
      if (featuredGrid) featuredGrid.innerHTML = `<div class="menu-catalog-state is-empty"><strong>현재 소개할 상품이 없습니다.</strong></div>`;
      featuredCards = [];
      updateFeaturedCarousel();
      return;
    }

    menuGrid.innerHTML = products.map((product) => productCardHtml(product)).join("");
    menuItems = [...menuGrid.querySelectorAll(".menu-item")];

    const featuredIds = ["songpyeon-reserve", "baekil", "susupat", "gift-box", "bulk-order"];
    const productMap = new Map(products.map((product) => [product.id, product]));
    const featuredProducts = featuredIds.map((id) => productMap.get(id)).filter(Boolean);
    if (featuredGrid) featuredGrid.innerHTML = featuredProducts.map((product) => productCardHtml(product, true)).join("");
    featuredCards = featuredGrid ? [...featuredGrid.querySelectorAll(":scope > .food-card")] : [];

    const queryFromUrl = new URLSearchParams(window.location.search).get("q");
    if (queryFromUrl && menuSearch) menuSearch.value = queryFromUrl;
    updateMenuList();
    updateFeaturedCarousel();
    scrollToMenuListFromUrl();
  } catch {
    renderCatalogState("error", "메뉴를 불러오지 못했습니다.");
    if (featuredGrid) featuredGrid.innerHTML = `<div class="menu-catalog-state is-error" role="alert"><strong>BEST 상품을 불러오지 못했습니다.</strong></div>`;
    featuredCards = [];
    updateFeaturedCarousel();
  }
}

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

  const activeButton = menuButtons.find((button) => button.dataset.filter === activeMenuFilter);
  const categoryLabel = activeMenuFilter === "all" ? "전체" : (activeButton?.textContent.trim() || activeMenuFilter);
  const listLabel = `${categoryLabel} 메뉴`;
  if (menuListTitle) menuListTitle.textContent = listLabel;
  if (menuGrid) menuGrid.setAttribute("aria-label", listLabel);
  if (menuPagination) menuPagination.setAttribute("aria-label", `${listLabel} 페이지 이동`);
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
  if (!featuredGrid) return;
  if (!featuredCards.length) {
    if (featuredPosition) featuredPosition.textContent = "0 / 0";
    if (featuredPrev) featuredPrev.disabled = true;
    if (featuredNext) featuredNext.disabled = true;
    return;
  }
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

menuGrid?.addEventListener("click", (event) => {
  if (event.target.closest("[data-products-retry]")) loadProductCatalog();
  const action = event.target.closest(".add-interest");
  if (!action) {
    const card = event.target.closest(".food-card[data-product-id]");
    if (card) window.location.href = `product.html?id=${encodeURIComponent(card.dataset.productId)}`;
    return;
  }
  event.stopPropagation();
  const card = action.closest(".food-card");
  if (!card) return;
  const price = Number(card.dataset.price || 0);
  const purchaseType = card.dataset.purchaseType || (price > 0 ? "direct" : "consultation");
  if (purchaseType === "direct" && price > 0) {
    addToCart({
      id: card.dataset.productId,
      name: card.dataset.name || card.querySelector("h3")?.textContent.trim(),
      price,
      category: card.dataset.category,
      imageUrl: card.querySelector("img")?.getAttribute("src") || "",
    });
    return;
  }
  window.location.href = `inquiry.html?product=${encodeURIComponent(card.dataset.productId || "")}`;
});

featuredGrid?.addEventListener("click", (event) => {
  const action = event.target.closest(".add-interest");
  if (!action) {
    const card = event.target.closest(".food-card[data-product-id]");
    if (card) window.location.href = `product.html?id=${encodeURIComponent(card.dataset.productId)}`;
    return;
  }
  const card = action.closest(".food-card");
  if (!card) return;
  const price = Number(card.dataset.price || 0);
  if ((card.dataset.purchaseType || "direct") === "direct" && price > 0) {
    addToCart({
      id: card.dataset.productId,
      name: card.dataset.name || card.querySelector("h3")?.textContent.trim(),
      price,
      category: card.dataset.category,
      imageUrl: card.querySelector("img")?.getAttribute("src") || "",
    });
  } else {
    window.location.href = `inquiry.html?product=${encodeURIComponent(card.dataset.productId || "")}`;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest('.food-card[role="link"][data-product-id]');
  if (!card || event.target.closest("button, a, input")) return;
  event.preventDefault();
  window.location.href = `product.html?id=${encodeURIComponent(card.dataset.productId)}`;
});

loadProductCatalog();
loadHomeProducts();

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
