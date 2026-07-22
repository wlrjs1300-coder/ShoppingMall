(() => {
  const root = document.querySelector("[data-product-detail]");
  if (!root) return;

  const id = new URLSearchParams(window.location.search).get("id");
  const scrollToTopButton = document.querySelector(".scroll-to-top");
  if (scrollToTopButton) {
    const updateScrollToTop = () => scrollToTopButton.classList.toggle("is-visible", window.scrollY > 260);
    window.addEventListener("scroll", updateScrollToTop, { passive: true });
    scrollToTopButton.addEventListener("click", () => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    });
    updateScrollToTop();
  }

  const money = (value) => `${Math.round(Number(value || 0)).toLocaleString("ko-KR")}원`;
  const safe = (value) => escapeHtml(String(value ?? ""));
  const formatDate = (value) => value ? new Date(value).toLocaleDateString("ko-KR") : "-";
  const getUnitPrices = (product) => {
    const packPrice = Number(product.price || 0);
    const packWeight = Number(product.unitWeightGrams || 250);
    const malPrice = Math.round(packPrice * (8000 / packWeight));
    return { pack: packPrice, halfMal: malPrice / 2, mal: malPrice };
  };

  function renderError(message) {
    root.innerHTML = `<div class="product-detail-error" role="alert"><strong>${safe(message)}</strong><p>메뉴 목록에서 다른 상품을 확인해 보세요.</p><a class="secondary-button" href="menu.html">메뉴로 돌아가기</a></div>`;
  }

  function setupContentTabs() {
    const tabs = [...document.querySelectorAll("[data-product-tab]")];
    const panels = [...document.querySelectorAll("[data-product-panel]")];
    const activate = (tab) => {
      tabs.forEach((item) => {
        const active = item === tab;
        item.setAttribute("aria-selected", String(active));
        item.tabIndex = active ? 0 : -1;
      });
      panels.forEach((panel) => { panel.hidden = panel.dataset.productPanel !== tab.dataset.productTab; });
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activate(tab));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        activate(tabs[nextIndex]);
        tabs[nextIndex].focus();
      });
    });
  }

  function readProductReviews(product) {
    const stored = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith("tteokReviews:")) continue;
        const reviews = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(reviews)) stored.push(...reviews.filter((review) => review.productName === product.name));
      }
    } catch {}
    const samples = [
      { id:"sample-1", rating:5, customerName:"김**", content:`${product.name}이 신선하고 식감도 좋아서 가족 모두 맛있게 먹었습니다. 포장도 단정해서 선물하기 좋았어요.`, keywords:["신선해요","포장이 깔끔해요"], photos:[product.imageUrl], createdAt:"2026-07-18T09:00:00.000Z" },
      { id:"sample-2", rating:5, customerName:"이**", content:"예약한 시간에 맞춰 바로 받을 수 있었고 안내도 친절했습니다. 다음에도 다시 주문하고 싶어요.", keywords:["맛이 좋아요","응대가 친절해요"], photos:[], createdAt:"2026-07-11T04:30:00.000Z" },
      { id:"sample-3", rating:4, customerName:"박**", content:"부모님과 함께 먹기 좋았고 양도 알맞았습니다. 말 단위 가격을 비교할 수 있어 편리했어요.", keywords:["구성이 좋아요"], photos:[], createdAt:"2026-07-02T11:20:00.000Z" },
    ];
    return [...stored.map((review) => ({ ...review, customerName:"내 리뷰" })), ...samples];
  }

  function renderReviews(product) {
    const reviews = readProductReviews(product);
    const list = document.querySelector("[data-product-review-list]");
    const average = reviews.length ? reviews.reduce((sum, review) => sum + Number(review.rating || 5), 0) / reviews.length : 0;
    document.querySelectorAll("[data-review-count]").forEach((node) => { node.textContent = String(reviews.length); });
    const summaryCount = document.querySelector("[data-review-count-summary]");
    const averageNode = document.querySelector("[data-review-average]");
    if (summaryCount) summaryCount.textContent = String(reviews.length);
    if (averageNode) averageNode.textContent = average.toFixed(1);
    if (!list) return;
    list.innerHTML = reviews.map((review) => {
      const rating = Math.max(1, Math.min(5, Number(review.rating || 5)));
      const keywords = Array.isArray(review.keywords) ? review.keywords : [];
      const photos = Array.isArray(review.photos) ? review.photos.slice(0, 3) : [];
      return `<article class="product-review-card"><header><strong>${safe(review.customerName || "구매 고객")}</strong><span class="product-review-stars" aria-label="별점 ${rating}점">${"★".repeat(rating)}${"☆".repeat(5-rating)}</span><time>${formatDate(review.createdAt)}</time></header><div>${keywords.length ? `<div class="product-review-keywords">${keywords.map((word) => `<span>${safe(word)}</span>`).join("")}</div>` : ""}<p>${safe(review.content || "작성한 리뷰입니다.")}</p>${photos.length ? `<div class="product-review-photos">${photos.map((photo,index) => `<img src="${safe(photo)}" alt="리뷰 사진 ${index+1}" loading="lazy" />`).join("")}</div>` : ""}</div></article>`;
    }).join("");
  }

  async function renderQna(product) {
    const list = document.querySelector("[data-product-qna-list]");
    const write = document.querySelector("[data-product-qna-write]");
    if (write) write.href = `inquiry.html?product=${encodeURIComponent(product.id)}`;
    try {
      const response = await fetch(`${API_BASE}/inquiries/product/${encodeURIComponent(product.id)}`, { cache:"no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "문의 내역을 불러오지 못했습니다.");
      const inquiries = Array.isArray(data.inquiries) ? data.inquiries : [];
      document.querySelectorAll("[data-qna-count]").forEach((node) => { node.textContent = String(inquiries.length); });
      if (!list) return;
      list.innerHTML = inquiries.length ? inquiries.map((inquiry) => `<details class="product-qna-item"><summary><span class="product-qna-status">${inquiry.adminReply ? "답변 완료" : "답변 대기"}</span><strong>${safe(inquiry.message)}</strong><span>${safe(inquiry.customerName)}</span><time>${formatDate(inquiry.createdAt)}</time></summary><div class="product-qna-body"><p>${safe(inquiry.message)}</p>${inquiry.adminReply ? `<p class="product-qna-answer">${safe(inquiry.adminReply)}</p>` : ""}</div></details>`).join("") : `<p class="product-content-empty">아직 등록된 상품 문의가 없습니다.<br />첫 번째 문의를 남겨보세요.</p>`;
    } catch (error) {
      if (list) list.innerHTML = `<p class="product-content-empty">${safe(error.message)}</p>`;
    }
  }

  function renderProductContent(product) {
    const title = document.querySelector("[data-product-story-title]");
    const description = document.querySelector("[data-product-story-description]");
    const detail = document.querySelector("[data-product-story-detail]");
    const image = document.querySelector("[data-product-story-image]");
    const ingredients = document.querySelector("[data-product-ingredients]");
    const origin = document.querySelector("[data-product-origin]");
    const originList = document.querySelector("[data-product-origin-list]");
    if (title) title.textContent = `${product.name}, 정성껏 준비합니다`;
    if (description) description.textContent = product.description || "좋은 재료와 정성으로 만든 따뜻한 떡집의 메뉴입니다.";
    if (detail) detail.textContent = "간식부터 가족 모임과 선물까지 필요한 수량에 맞춰 준비해 드립니다.";
    if (ingredients) ingredients.textContent = product.ingredients || "쌀, 소금 및 상품별 부재료";
    if (origin) origin.textContent = product.origin || "쌀 국내산 · 그 외 원재료는 상품별 별도 표기";
    if (originList) {
      const name = String(product.name || "");
      let items = [["멥쌀", "국내산"], ["소금", "국내산"], ["설탕", "외국산"]];
      if (/약식|약밥/.test(name)) items = [["찹쌀", "국내산"], ["흑설탕", "외국산"], ["밤", "국내산"], ["대추", "국내산"], ["잣", "국내산"], ["참기름", "국내산"]];
      else if (/쑥/.test(name)) items = [["멥쌀", "국내산"], ["쑥", "국내산"], ["소금", "국내산"], ["설탕", "외국산"]];
      else if (/호박/.test(name)) items = [["멥쌀", "국내산"], ["호박", "국내산"], ["설탕", "외국산"], ["소금", "국내산"]];
      else if (/송편/.test(name)) items = [["멥쌀", "국내산"], ["참깨", "외국산"], ["설탕", "외국산"], ["소금", "국내산"], ["참기름", "국내산"]];
      else if (/팥|시루/.test(name)) items = [["멥쌀", "국내산"], ["팥", "중국산"], ["설탕", "외국산"], ["소금", "국내산"]];
      else if (/인절미|찰떡|찹쌀/.test(name)) items = [["찹쌀", "국내산"], ["콩가루", "국내산"], ["설탕", "외국산"], ["소금", "국내산"]];
      else if (/밤|대추/.test(name)) items = [["멥쌀", "국내산"], ["밤", "국내산"], ["대추", "국내산"], ["설탕", "외국산"], ["소금", "국내산"]];
      originList.innerHTML = items.map(([ingredient, country]) => `<div><dt>${safe(ingredient)}</dt><dd>${safe(country)}</dd></div>`).join("");
    }
    if (image) {
      image.src = product.imageUrl;
      image.alt = `${product.name} 상품 모습`;
    }
    renderReviews(product);
    renderQna(product);
  }

  function render(product) {
    const direct = product.purchaseType === "direct" && Number(product.price) > 0;
    const prices = getUnitPrices(product);
    let selectedUnit = "pack";
    document.title = `${product.name} | 따뜻한 떡집`;
    document.querySelector("[data-detail-breadcrumb]").textContent = product.name;
    renderProductContent(product);

    root.innerHTML = `
      <div class="product-detail-visual">
        <span class="product-detail-category-tag">${safe(product.category)}</span>
        <img src="${safe(product.imageUrl)}" alt="${safe(product.name)}" />
      </div>
      <div class="product-detail-info">
        <p class="section-kicker">MENU DETAIL</p>
        <h1>${safe(product.name)}</h1>
        <p class="product-detail-description">${safe(product.description || "정성껏 준비한 따뜻한 떡집 메뉴입니다.")}</p>
        <section class="product-detail-price-panel" aria-label="판매가">
          <div class="product-detail-price-heading">
            <span>판매가</span>
            <small>주문 단위별 가격</small>
          </div>
          ${direct ? `<div class="product-detail-unit-prices">
            <div class="product-detail-unit-price is-pack"><span>1팩 · ${Number(product.unitWeightGrams || 250).toLocaleString("ko-KR")}g</span><strong>${money(prices.pack)}</strong></div>
            <div class="product-detail-unit-price"><span>반말</span><strong>${money(prices.halfMal)}</strong></div>
            <div class="product-detail-unit-price"><span>한말</span><strong>${money(prices.mal)}</strong></div>
          </div>` : `<strong class="product-detail-consult-price">상담 후 안내</strong>`}
        </section>
        <div class="product-detail-delivery-fee" aria-label="배송료 안내"><span>배송료</span><strong>3,500원</strong><small>매장 픽업 무료</small></div>
        <ul class="product-detail-points">
          <li><span aria-hidden="true">✓</span> 주문 일정에 맞춰 신선하게 생산합니다.</li>
          <li><span aria-hidden="true">✓</span> 팩과 말 단위 중 필요한 수량을 선택할 수 있습니다.</li>
          <li><span aria-hidden="true">✓</span> 정확한 수령 일정은 주문 단계에서 확인합니다.</li>
        </ul>
        ${direct ? `
          <div class="product-detail-unit-picker">
            <span>구매 단위</span>
            <div class="product-detail-unit-badges" role="group" aria-label="구매 단위 선택">
              <button class="product-detail-unit-badge is-active" type="button" data-detail-unit="pack" aria-pressed="true">팩 단위</button>
              <button class="product-detail-unit-badge" type="button" data-detail-unit="mal" aria-pressed="false">말 단위</button>
            </div>
          </div>
          <div class="product-detail-quantity">
            <span data-detail-quantity-label>수량 (팩)</span>
            <div><button type="button" data-quantity-minus aria-label="수량 줄이기">−</button><input type="number" value="1" min="1" max="99" step="1" data-detail-quantity aria-label="수량" /><button type="button" data-quantity-plus aria-label="수량 늘리기">＋</button></div>
          </div>
          <div class="product-detail-total"><span>총 상품 금액</span><strong data-detail-total>${money(prices.pack)}</strong></div>
          <div class="product-detail-actions"><button class="secondary-button" type="button" data-detail-cart>장바구니 담기</button><button class="primary-button" type="button" data-detail-buy>바로 주문하기</button></div>
        ` : `
          <div class="product-consultation-notice"><strong>상담이 필요한 메뉴예요</strong><p>희망 수량과 날짜를 남겨주시면 가능한 구성과 금액을 안내해 드립니다.</p></div>
          <a class="primary-button product-detail-inquiry" href="inquiry.html?product=${encodeURIComponent(product.id)}">문의 남기기</a>
        `}
      </div>`;

    if (!direct) return;
    const quantity = root.querySelector("[data-detail-quantity]");
    const total = root.querySelector("[data-detail-total]");
    const quantityLabel = root.querySelector("[data-detail-quantity-label]");
    const unitButtons = [...root.querySelectorAll("[data-detail-unit]")];
    const step = () => selectedUnit === "pack" ? 1 : 0.5;
    const minimum = () => selectedUnit === "pack" ? 1 : 0.5;
    const unitPrice = () => selectedUnit === "pack" ? prices.pack : prices.mal;
    const normalize = (value = quantity.value) => {
      const snapped = Math.round((Number(value) || minimum()) / step()) * step();
      return Math.max(minimum(), Math.min(99, snapped));
    };
    const update = (next = quantity.value) => {
      quantity.value = String(normalize(next));
      total.textContent = money(unitPrice() * normalize());
    };

    unitButtons.forEach((button) => button.addEventListener("click", () => {
      selectedUnit = button.dataset.detailUnit;
      unitButtons.forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      quantity.min = String(minimum());
      quantity.step = String(step());
      quantity.value = String(minimum());
      quantityLabel.textContent = selectedUnit === "pack" ? "수량 (팩)" : "수량 (말)";
      update();
    }));
    root.querySelector("[data-quantity-minus]").addEventListener("click", () => update(normalize() - step()));
    root.querySelector("[data-quantity-plus]").addEventListener("click", () => update(normalize() + step()));
    quantity.addEventListener("input", () => update());

    const addSelectedQuantity = async () => {
      const cartItem = { id: product.id, name: product.name, price: unitPrice(), category: product.category, imageUrl: product.imageUrl, quantityUnit: selectedUnit };
      const allowed = await addToCart(cartItem);
      writeCart(cartUtils.setQuantity(readCart(), product.id, normalize(), selectedUnit));
      return allowed;
    };
    root.querySelector("[data-detail-cart]").addEventListener("click", async () => {
      const added = await addSelectedQuantity();
      if (added) window.showHeaderCartNotice?.(product.name);
    });
    root.querySelector("[data-detail-buy]").addEventListener("click", async () => {
      await addSelectedQuantity();
      if (await window.PurchaseAccess.require("cart.html")) window.location.href = "cart.html";
    });
  }

  if (!id) return renderError("선택한 메뉴 정보가 없습니다.");
  setupContentTabs();
  fetch(`${API_BASE}/products/${encodeURIComponent(id)}`, { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.product) throw new Error(body.error || "메뉴를 찾을 수 없습니다.");
      render(body.product);
    })
    .catch((error) => renderError(error.message));
})();
