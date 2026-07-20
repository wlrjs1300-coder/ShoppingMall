(() => {
  const root = document.querySelector("[data-product-detail]");
  if (!root) return;
  const id = new URLSearchParams(window.location.search).get("id");
  const money = (value) => `${Number(value).toLocaleString("ko-KR")}원`;
  const safe = (value) => escapeHtml(String(value ?? ""));

  function renderError(message) {
    root.innerHTML = `<div class="product-detail-error" role="alert"><strong>${safe(message)}</strong><p>메뉴 목록에서 다른 상품을 확인해 보세요.</p><a class="secondary-button" href="menu.html">메뉴로 돌아가기</a></div>`;
  }

  function render(product) {
    const direct = product.purchaseType === "direct" && Number(product.price) > 0;
    document.title = `${product.name} | 따뜻한 떡집`;
    document.querySelector("[data-detail-breadcrumb]").textContent = product.name;
    root.innerHTML = `
      <div class="product-detail-visual">
        <span class="product-detail-category-tag">${safe(product.category)}</span>
        <img src="${safe(product.imageUrl)}" alt="${safe(product.name)}" />
      </div>
      <div class="product-detail-info">
        <p class="section-kicker">MENU DETAIL</p>
        <h1>${safe(product.name)}</h1>
        <p class="product-detail-description">${safe(product.description || "정성껏 준비한 따뜻한 떡집 메뉴입니다.")}</p>
        <div class="product-detail-price-row"><span>${direct ? "판매가" : "주문 방식"}</span><strong>${direct ? `${product.unitWeightGrams ? `<small>(${Number(product.unitWeightGrams).toLocaleString("ko-KR")}g당)</small> ` : ""}${money(product.price)}` : "상담 후 안내"}</strong></div>
        <ul class="product-detail-points">
          <li><span aria-hidden="true">✓</span> 주문 일정에 맞춘 신선한 생산</li>
          <li><span aria-hidden="true">✓</span> 수량과 포장 요청은 주문 단계에서 확인</li>
          <li><span aria-hidden="true">✓</span> 정확한 수령 일정은 상담 후 확정</li>
        </ul>
        ${direct ? `
          <div class="product-detail-quantity">
            <span>수량</span>
            <div><button type="button" data-quantity-minus aria-label="수량 줄이기">−</button><input type="number" value="1" min="1" max="99" data-detail-quantity aria-label="수량" /><button type="button" data-quantity-plus aria-label="수량 늘리기">＋</button></div>
          </div>
          <div class="product-detail-total"><span>총 상품 금액</span><strong data-detail-total>${money(product.price)}</strong></div>
          <div class="product-detail-actions"><button class="secondary-button" type="button" data-detail-cart>장바구니 담기</button><button class="primary-button" type="button" data-detail-buy>바로 주문하기</button></div>
        ` : `
          <div class="product-consultation-notice"><strong>상담이 필요한 메뉴예요</strong><p>희망 수량과 날짜를 남겨주시면 가능한 구성과 금액을 안내해 드립니다.</p></div>
          <a class="primary-button product-detail-inquiry" href="inquiry.html?product=${encodeURIComponent(product.id)}">문의 남기기</a>
        `}
        <a class="product-detail-back" href="menu.html">← 메뉴 목록으로 돌아가기</a>
      </div>`;

    if (!direct) return;
    const quantity = root.querySelector("[data-detail-quantity]");
    const total = root.querySelector("[data-detail-total]");
    const normalize = () => Math.max(1, Math.min(99, Number.parseInt(quantity.value, 10) || 1));
    const update = (next) => { quantity.value = Math.max(1, Math.min(99, next)); total.textContent = money(product.price * normalize()); };
    root.querySelector("[data-quantity-minus]").addEventListener("click", () => update(normalize() - 1));
    root.querySelector("[data-quantity-plus]").addEventListener("click", () => update(normalize() + 1));
    quantity.addEventListener("input", () => update(normalize()));
    const cartItem = { id: product.id, name: product.name, price: Number(product.price), category: product.category, imageUrl: product.imageUrl };
    const addSelectedQuantity = async () => {
      await addToCart(cartItem);
      writeCart(cartUtils.setQuantity(readCart(), product.id, normalize()));
    };
    root.querySelector("[data-detail-cart]").addEventListener("click", addSelectedQuantity);
    root.querySelector("[data-detail-buy]").addEventListener("click", async () => {
      const allowed = await addSelectedQuantity();
      if (await window.PurchaseAccess.require("cart.html")) window.location.href = "cart.html";
      return allowed;
    });
  }

  if (!id) return renderError("선택한 메뉴 정보가 없습니다.");
  fetch(`${API_BASE}/products/${encodeURIComponent(id)}`, { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.product) throw new Error(body.error || "메뉴를 찾을 수 없습니다.");
      render(body.product);
    })
    .catch((error) => renderError(error.message));
})();
