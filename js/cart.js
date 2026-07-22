// ─── 장바구니 (비회원도 사용할 수 있도록 브라우저에 저장) ─────────
const CART_STORAGE_KEY = "tteokShoppingCart";
const GUEST_CHECKOUT_KEY = "tteokGuestCheckout";
const GUEST_CUSTOMER_KEY = "tteokGuestCustomer";
const cartUtils = window.CartUtils;

function currentPurchaseReturnUrl() {
  const page = window.location.pathname.split("/").pop() || "index.html";
  return `${page}${window.location.search}${window.location.hash}`;
}

function hasValidGuestProfile() {
  if (sessionStorage.getItem(GUEST_CHECKOUT_KEY) !== "true") return false;
  try {
    const guest = JSON.parse(sessionStorage.getItem(GUEST_CUSTOMER_KEY) || "null");
    return Boolean(
      guest?.customer
      && /^01[016789]\d{7,8}$/.test(String(guest.phone || ""))
      && guest?.address
      && typeof guest?.password === "string"
      && new TextEncoder().encode(guest.password).length >= 8,
    );
  } catch {
    return false;
  }
}

async function requirePurchaseAccess(next = currentPurchaseReturnUrl()) {
  if (hasValidGuestProfile()) return true;
  if (sessionStorage.getItem(GUEST_CHECKOUT_KEY) === "true") {
    sessionStorage.removeItem(GUEST_CHECKOUT_KEY);
    sessionStorage.removeItem(GUEST_CUSTOMER_KEY);
  }
  try {
    const response = await fetch("/api/users/me", { credentials: "same-origin" });
    if (response.ok) return true;
  } catch {}
  window.location.href = `login.html?next=${encodeURIComponent(next)}`;
  return false;
}

window.PurchaseAccess = {
  saveGuest(customer) {
    sessionStorage.setItem(GUEST_CHECKOUT_KEY, "true");
    sessionStorage.setItem(GUEST_CUSTOMER_KEY, JSON.stringify(customer));
  },
  clearGuest() {
    sessionStorage.removeItem(GUEST_CHECKOUT_KEY);
    sessionStorage.removeItem(GUEST_CUSTOMER_KEY);
  },
  hasCartItems() { return readCart().length > 0; },
  hasValidGuestProfile,
  require: requirePurchaseAccess,
};

function readCart() {
  return cartUtils.parseCart(localStorage.getItem(CART_STORAGE_KEY) || "[]");
}

function writeCart(cart) {
  localStorage.setItem(CART_STORAGE_KEY, cartUtils.serializeCart(cart));
  updateCartLinks();
}

async function addToCart(item) {
  if (!item?.id || !Number.isFinite(item.price) || item.price <= 0) return;
  if (!await requirePurchaseAccess()) {
    // 로그인 또는 비회원 주문을 선택한 뒤 이어갈 수 있도록 선택 상품은 보관한다.
    writeCart(cartUtils.addItem(readCart(), item));
    return false;
  }
  writeCart(cartUtils.addItem(readCart(), item));
  return true;
}

function updateCartLinks() {
  const count = new Set(readCart().map((item) => item.id)).size;
  document.querySelectorAll(".header-text-link").forEach((link) => {
    if (!link.textContent.trim().startsWith("장바구니")) return;
    link.href = "cart.html";
    link.textContent = `장바구니${count ? ` (${count > 99 ? "99+" : count})` : ""}`;
  });
}

updateCartLinks();

document.addEventListener("click", async (event) => {
  const link = event.target.closest('a[href="cart.html"]');
  if (!link) return;
  event.preventDefault();
  if (await requirePurchaseAccess("cart.html")) window.location.href = link.href;
});

if (document.body.classList.contains("cart-page")) requirePurchaseAccess("cart.html");

const cartList = document.querySelector("[data-cart-list]");
if (cartList) {
  const formatQuantity = (item) => `${Number(item.quantity || 0).toLocaleString("ko-KR")} ${item.quantityUnit === "pack" ? "팩" : "말"}`;
  const totalCount = document.querySelector("[data-cart-total-count]");
  const subtotalPrice = document.querySelector("[data-cart-subtotal-price]");
  const totalPrice = document.querySelector("[data-cart-total-price]");
  const summary = document.querySelector("[data-cart-summary]");
  const layout = document.querySelector(".cart-layout");
  const clearButton = document.querySelector("[data-cart-clear]");
  const selectAll = document.querySelector("[data-cart-select-all]");
  const selectedLabel = document.querySelector("[data-cart-selected-label]");
  const deleteSelected = document.querySelector("[data-cart-delete-selected]");
  const orderButton = document.querySelector("[data-cart-order-button]");
  const orderCount = document.querySelector("[data-cart-order-count]");

  const renderCart = () => {
    const cart = readCart();
    const count = cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const selectedItems = cart.filter((item) => item.selected !== false);
    const cartSummary = cartUtils.summarize(cart);
    const selectedCount = cartSummary.selectedQuantity;
    const price = cartSummary.selectedPrice;
    totalCount.textContent = `${selectedCount}개`;
    subtotalPrice.textContent = `${price.toLocaleString("ko-KR")}원`;
    totalPrice.textContent = `${price.toLocaleString("ko-KR")}원`;
    if (orderCount) orderCount.textContent = String(selectedCount);
    if (selectedLabel) selectedLabel.textContent = `${selectedItems.length} / ${cart.length}`;
    if (selectAll) {
      selectAll.checked = cart.length > 0 && selectedItems.length === cart.length;
      selectAll.indeterminate = selectedItems.length > 0 && selectedItems.length < cart.length;
      selectAll.disabled = cart.length === 0;
    }
    orderButton?.classList.toggle("is-disabled", selectedCount === 0);
    summary?.classList.toggle("is-empty", cart.length === 0);
    layout?.classList.toggle("is-empty", cart.length === 0);
    if (clearButton) clearButton.hidden = cart.length === 0;

    if (!cart.length) {
      cartList.innerHTML = `<div class="cart-empty"><span class="cart-empty-icon" aria-hidden="true">🛍️</span><strong>장바구니가 비어 있습니다.</strong><p>오늘 준비된 따뜻한 떡을 천천히 둘러보세요.</p><a class="secondary-button" href="menu.html">메뉴 보러 가기</a></div>`;
      return;
    }

    cartList.innerHTML = cart.map((item) => `
      <article class="cart-item" data-cart-id="${escapeHtml(item.id)}">
        <label class="cart-item-check"><input type="checkbox" data-cart-select ${item.selected === false ? "" : "checked"} aria-label="${escapeHtml(item.name)} 선택" /></label>
        <div class="cart-item-main">
          <div class="cart-item-image">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="" />` : `<span>따뜻한<br />떡집</span>`}</div>
          <div class="cart-item-copy"><span>${escapeHtml(item.category || "떡")}</span><h2>${escapeHtml(item.name)}</h2><p>단가 ${Number(item.price).toLocaleString("ko-KR")}원 (${formatQuantity(item)})</p></div>
        </div>
        <div class="cart-item-actions">
          <div class="cart-quantity" aria-label="${escapeHtml(item.name)} 수량">
            <button type="button" data-cart-decrease aria-label="수량 줄이기">−</button><output>${formatQuantity(item)}</output><button type="button" data-cart-increase aria-label="수량 늘리기">+</button>
          </div>
          <strong>${(Number(item.price) * Number(item.quantity)).toLocaleString("ko-KR")}원</strong>
          <button class="cart-remove" type="button" data-cart-remove>삭제</button>
        </div>
      </article>
    `).join("");
  };

  cartList.addEventListener("click", async (event) => {
    const row = event.target.closest("[data-cart-id]");
    if (!row) return;
    const cart = readCart();
    const item = cart.find((entry) => entry.id === row.dataset.cartId);
    if (!item) return;
    let nextCart = cart;
    const step = item.quantityUnit === "pack" ? 1 : 0.5;
    if (event.target.closest("[data-cart-increase]")) nextCart = cartUtils.setQuantity(nextCart, item.id, item.quantity + step, item.quantityUnit);
    if (event.target.closest("[data-cart-decrease]")) nextCart = cartUtils.setQuantity(nextCart, item.id, item.quantity - step, item.quantityUnit);
    if (event.target.matches("[data-cart-select]")) nextCart = cartUtils.setSelected(nextCart, item.id, event.target.checked);
    const removed = event.target.closest("[data-cart-remove]");
    if (removed) {
      event.preventDefault();
      if (!await AppUI.confirm(`${item.name}을(를) 장바구니에서 삭제할까요?`, {
        title: "상품 삭제",
        tone: "danger",
        icon: "🗑️",
        confirmText: "삭제",
        cancelText: "취소",
      })) return;
      nextCart = cartUtils.removeItem(nextCart, item.id, item.quantityUnit);
    }
    writeCart(nextCart);
    renderCart();
  });

  clearButton?.addEventListener("click", async () => {
    const readCartBeforeClear = readCart();
    if (!await AppUI.confirm("장바구니의 모든 상품을 삭제할까요?", {
      title: "장바구니 비우기",
      tone: "danger",
      icon: "🗑",
      confirmText: "비우기",
      cancelText: "아니요",
    })) return;
    writeCart([]);
    renderCart();
  });

  selectAll?.addEventListener("change", () => {
    const cart = cartUtils.selectAll(readCart(), selectAll.checked);
    writeCart(cart);
    renderCart();
  });

  deleteSelected?.addEventListener("click", async () => {
    const cart = readCart();
    const selectedCount = cart.filter((item) => item.selected !== false).length;
    if (!selectedCount) return;
    if (!await AppUI.confirm(`선택한 ${selectedCount}개 상품을 삭제할까요?`, {
      title: "선택 상품 삭제",
      tone: "danger",
      icon: "🗑",
      confirmText: "삭제",
      cancelText: "취소",
    })) return;
    writeCart(cartUtils.removeSelected(cart));
    renderCart();
  });

  orderButton?.addEventListener("click", (event) => {
    if (!orderButton.classList.contains("is-disabled")) return;
    event.preventDefault();
  });

  renderCart();

  fetch(`${API_BASE}/products`, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("products unavailable");
      return response.json();
    })
    .then(({ products }) => {
      if (!Array.isArray(products)) throw new Error("invalid products response");
      const reconciled = cartUtils.reconcileProducts(readCart(), products);
      if (!reconciled.removedCount && !reconciled.updatedCount) return;
      writeCart(reconciled.cart);
      renderCart();
      const messages = [];
      if (reconciled.removedCount) messages.push(`판매가 종료된 상품 ${reconciled.removedCount}개를 장바구니에서 제외했습니다.`);
      if (reconciled.updatedCount) messages.push(`상품 정보 ${reconciled.updatedCount}개를 최신 정보로 갱신했습니다.`);
      showInlineNotice(messages.join(" "));
    })
    .catch(() => showInlineNotice("최신 상품 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."));
}

const checkoutRoot = document.querySelector("[data-checkout-root]");
if (checkoutRoot) {
  const checkoutLoading = checkoutRoot.querySelector("[data-checkout-loading]");
  const checkoutEmpty = checkoutRoot.querySelector("[data-checkout-empty]");
  const checkoutForm = checkoutRoot.querySelector("[data-checkout-form]");
  const checkoutItems = checkoutRoot.querySelector("[data-checkout-items]");
  const checkoutItemCount = checkoutRoot.querySelector("[data-checkout-item-count]");
  const checkoutQuantity = checkoutRoot.querySelector("[data-checkout-quantity]");
  const checkoutTotal = checkoutRoot.querySelector("[data-checkout-total]");
  const checkoutFulfillments = [...checkoutRoot.querySelectorAll("[data-checkout-fulfillment]")];
  const checkoutAddress = checkoutRoot.querySelector("[data-checkout-address]");
  const checkoutAddressInput = checkoutAddress?.querySelector('[name="address"]');
  const checkoutPostalCodeInput = checkoutAddress?.querySelector('[name="postalCode"]');
  const checkoutAddressDetailInput = checkoutAddress?.querySelector('[name="addressDetail"]');
  const checkoutAddressSearch = checkoutAddress?.querySelector("[data-checkout-address-search]");
  const checkoutAddressModes = [...(checkoutAddress?.querySelectorAll('input[name="addressMode"]') || [])];
  const checkoutDefaultAddressOption = checkoutAddress?.querySelector("[data-checkout-default-address]");
  const checkoutDirectAddress = checkoutAddress?.querySelector("[data-checkout-direct-address]");
  const checkoutSubmit = checkoutRoot.querySelector("[data-checkout-submit]");
  const checkoutStatus = checkoutRoot.querySelector("[data-checkout-status]");
  const checkoutComplete = checkoutRoot.querySelector("[data-checkout-complete]");
  const onsitePayment = checkoutForm?.querySelector('input[name="paymentMethod"][value="onsite"]');
  const validationDialog = document.querySelector("[data-checkout-validation-dialog]");
  const validationList = validationDialog?.querySelector("[data-checkout-validation-list]");
  const pendingCheckoutKey = "tteokPendingCheckout";
  let checkoutSelection = [];
  let checkoutDefaultAddress = null;
  const getCheckoutFulfillment = () => checkoutForm?.querySelector('[name="fulfillmentType"]:checked')?.value || "pickup";

  const setCheckoutAddressState = () => {
    const isDelivery = getCheckoutFulfillment() === "delivery";
    if (checkoutAddress) checkoutAddress.hidden = !isDelivery;
    if (checkoutAddressInput) {
      checkoutAddressInput.required = Boolean(isDelivery);
    }
    if (onsitePayment) {
      onsitePayment.disabled = !isDelivery ? false : true;
      onsitePayment.closest("label")?.classList.toggle("is-disabled", isDelivery);
      if (isDelivery && onsitePayment.checked) {
        onsitePayment.checked = false;
        checkoutForm.querySelector('input[name="paymentMethod"][value="card"]')?.click();
      }
    }
  };

  const setCheckoutAddressMode = (mode) => {
    const useDefault = mode === "default" && checkoutDefaultAddress;
    if (checkoutDirectAddress) checkoutDirectAddress.hidden = Boolean(useDefault);
    if (useDefault) {
      if (checkoutPostalCodeInput) checkoutPostalCodeInput.value = checkoutDefaultAddress.postalCode || "";
      if (checkoutAddressInput) checkoutAddressInput.value = checkoutDefaultAddress.address || "";
      if (checkoutAddressDetailInput) checkoutAddressDetailInput.value = checkoutDefaultAddress.addressDetail || "";
    } else {
      if (checkoutPostalCodeInput) checkoutPostalCodeInput.value = "";
      if (checkoutAddressInput) checkoutAddressInput.value = "";
      if (checkoutAddressDetailInput) checkoutAddressDetailInput.value = "";
    }
  };

  const dateValue = checkoutForm?.elements.pickupDate;
  const dateDisplay = checkoutForm?.elements.pickupDateDisplay;
  if (dateValue) dateValue.required = false;
  if (dateDisplay) dateDisplay.required = true;
  const calendar = checkoutForm?.querySelector("[data-checkout-calendar]");
  const calendarTitle = checkoutForm?.querySelector("[data-checkout-calendar-title]");
  const calendarDays = checkoutForm?.querySelector("[data-checkout-calendar-days]");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const closeCalendar = () => { if (calendar) calendar.hidden = true; };
  const renderCheckoutCalendar = () => {
    if (!calendarTitle || !calendarDays) return;
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    calendarTitle.textContent = `${year}년 ${month + 1}월`;
    const firstDay = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();
    calendarDays.innerHTML = `${'<span></span>'.repeat(firstDay)}${Array.from({ length: lastDate }, (_, index) => {
      const date = new Date(year, month, index + 1);
      const key = dateKey(date);
      const disabled = date < today;
      const classes = [key === dateKey(today) ? "is-today" : "", key === dateValue?.value ? "is-selected" : ""].filter(Boolean).join(" ");
      return `<button type="button" data-checkout-calendar-date="${key}" class="${classes}" ${disabled ? "disabled" : ""}>${index + 1}</button>`;
    }).join("")}`;
  };
  const selectCheckoutDate = (key) => {
    if (dateValue) dateValue.value = key;
    if (dateDisplay) {
      const [year, month, day] = key.split("-");
      dateDisplay.value = `${year}. ${Number(month)}. ${Number(day)}.`;
    }
    closeCalendar();
  };
  dateDisplay?.addEventListener("click", () => {
    if (!calendar) return;
    calendar.hidden = !calendar.hidden;
    if (!calendar.hidden) renderCheckoutCalendar();
  });
  calendar?.addEventListener("click", (event) => {
    const dateButton = event.target.closest("[data-checkout-calendar-date]");
    if (dateButton) selectCheckoutDate(dateButton.dataset.checkoutCalendarDate);
    if (event.target.closest("[data-checkout-calendar-prev]")) { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1); renderCheckoutCalendar(); }
    if (event.target.closest("[data-checkout-calendar-next]")) { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1); renderCheckoutCalendar(); }
    if (event.target.closest("[data-checkout-calendar-today]")) selectCheckoutDate(dateKey(today));
  });
  document.addEventListener("click", (event) => {
    if (calendar && !calendar.hidden && !event.target.closest(".checkout-date-field")) closeCalendar();
  });

  const hourSelect = checkoutForm?.elements.pickupHour;
  const minuteSelect = checkoutForm?.elements.pickupMinute;
  const timeValue = checkoutForm?.elements.pickupTime;
  if (hourSelect) hourSelect.insertAdjacentHTML("beforeend", Array.from({ length: 24 }, (_, hour) => `<option value="${String(hour).padStart(2, "0")}">${String(hour).padStart(2, "0")}시</option>`).join(""));
  if (minuteSelect) minuteSelect.insertAdjacentHTML("beforeend", ["00", "30"].map((minute) => `<option value="${minute}">${minute}분</option>`).join(""));
  const syncTime = () => { if (timeValue) timeValue.value = hourSelect?.value && minuteSelect?.value ? `${hourSelect.value}:${minuteSelect.value}` : ""; };
  hourSelect?.addEventListener("change", syncTime);
  minuteSelect?.addEventListener("change", syncTime);

  validationDialog?.querySelector("[data-checkout-validation-close]")?.addEventListener("click", () => validationDialog.close());
  const showValidationDialog = () => {
    const missing = [];
    const labels = { customer: "주문자 이름", phone: "연락처", pickupDate: "희망 날짜", pickupHour: "희망 시간", pickupMinute: "희망 시간", address: "배송 주소", paymentMethod: "결제 방법" };
    checkoutForm.querySelectorAll(":invalid").forEach((field) => {
      const label = labels[field.name] || field.closest("label")?.querySelector(":scope > span")?.textContent?.trim() || "필수 정보";
      if (!missing.includes(label)) missing.push(label);
    });
    if (getCheckoutFulfillment() === "delivery" && !checkoutAddressInput?.value.trim() && !missing.includes("배송 주소")) missing.push("배송 주소");
    const validationTitle = validationDialog?.querySelector("#checkout-validation-title");
    const validationDescription = validationDialog?.querySelector("[data-checkout-validation-description]");
    if (validationTitle) validationTitle.textContent = missing.length === 1 ? `${missing[0]} 입력이 필요합니다` : "입력 정보를 확인해 주세요";
    if (validationDescription) validationDescription.textContent = missing.length === 1 ? "입력 후 주문 및 결제를 계속할 수 있습니다." : "주문 진행을 위해 아래 항목을 입력해 주세요.";
    if (validationList) {
      validationList.hidden = missing.length <= 1;
      validationList.innerHTML = missing.map((label) => `<li>${escapeHtml(label)}</li>`).join("");
    }
    if (validationDialog && typeof validationDialog.showModal === "function" && !validationDialog.open) validationDialog.showModal();
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== "tteok-postcode-selected") return;
    if (checkoutPostalCodeInput) checkoutPostalCodeInput.value = event.data.zonecode || "";
    if (checkoutAddressInput) checkoutAddressInput.value = event.data.address || "";
    checkoutAddressDetailInput?.focus();
  });

  checkoutAddressSearch?.addEventListener("click", () => {
    const width = 500;
    const height = 620;
    const left = Math.max(0, Math.round((screen.width - width) / 2));
    const top = Math.max(0, Math.round((screen.height - height) / 2));
    const popup = window.open("postcode.html", "tteokPostcode", `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no`);
    if (!popup) checkoutStatus.textContent = "주소 검색 팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.";
    else popup.focus();
  });

  const showCheckoutEmpty = (message = "장바구니에서 주문할 상품을 선택해 주세요.") => {
    checkoutLoading.hidden = true;
    checkoutForm.hidden = true;
    checkoutEmpty.hidden = false;
    const description = checkoutEmpty.querySelector("p");
    if (description) description.textContent = message;
  };

  const renderCheckout = () => {
    const summary = cartUtils.summarize(checkoutSelection);
    checkoutItems.innerHTML = checkoutSelection.map((item) => `
      <article class="checkout-item">
        <div class="checkout-item-image">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="" />` : ""}</div>
        <div><span>${escapeHtml(item.category || "떡")}</span><h3>${escapeHtml(item.name)}</h3><p>${Number(item.price).toLocaleString("ko-KR")}원 × ${Number(item.quantity).toLocaleString("ko-KR")} ${item.quantityUnit === "pack" ? "팩" : "말"}</p></div>
        <strong>${(Number(item.price) * item.quantity).toLocaleString("ko-KR")}원</strong>
      </article>`).join("");
    checkoutItemCount.textContent = `${summary.selectedItemCount}개`;
    checkoutQuantity.textContent = `${summary.selectedQuantity}개`;
    checkoutTotal.textContent = `${summary.selectedPrice.toLocaleString("ko-KR")}원`;
    checkoutLoading.hidden = true;
    checkoutEmpty.hidden = true;
    checkoutForm.hidden = false;
  };

  const loadCheckout = async () => {
    const selectedBeforeRefresh = readCart().filter((item) => item.selected !== false);
    if (!selectedBeforeRefresh.length) return showCheckoutEmpty();
    try {
      const response = await fetch(`${API_BASE}/products`, { cache: "no-store" });
      if (!response.ok) throw new Error("상품 API 응답 오류");
      const data = await response.json();
      if (!Array.isArray(data.products)) throw new Error("상품 API 형식 오류");
      const reconciled = cartUtils.reconcileProducts(readCart(), data.products);
      if (reconciled.removedCount || reconciled.updatedCount) writeCart(reconciled.cart);
      checkoutSelection = reconciled.cart.filter((item) => item.selected !== false);
      if (!checkoutSelection.length) return showCheckoutEmpty("선택한 상품이 판매 종료되어 주문할 수 없습니다. 장바구니를 다시 확인해 주세요.");
      renderCheckout();
    } catch {
      showCheckoutEmpty("최신 상품 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  };

  const prefillCheckoutCustomer = async () => {
    try {
      const guest = JSON.parse(sessionStorage.getItem(GUEST_CUSTOMER_KEY) || "null");
      if (guest?.customer && !checkoutForm.elements.customer.value) checkoutForm.elements.customer.value = guest.customer;
      if (guest?.phone && !checkoutForm.elements.phone.value) checkoutForm.elements.phone.value = guest.phone;
      if (guest?.address && checkoutAddressInput && !checkoutAddressInput.value) checkoutAddressInput.value = guest.address;
    } catch {}
    try {
      const response = await fetch(`${API_BASE}/users/me`, { credentials: "same-origin" });
      if (!response.ok) return;
      const { user } = await response.json();
      if (user?.name && !checkoutForm.elements.customer.value) checkoutForm.elements.customer.value = user.name;
      if (user?.phone && !checkoutForm.elements.phone.value) checkoutForm.elements.phone.value = user.phone;
    } catch {}
    try {
      const response = await fetch(`${API_BASE}/users/me/address`, { credentials: "same-origin" });
      if (!response.ok) return;
      const data = await response.json();
      checkoutDefaultAddress = data.address || null;
      if (!checkoutDefaultAddress || !checkoutDefaultAddressOption) return;
      checkoutDefaultAddressOption.hidden = false;
      const name = checkoutDefaultAddressOption.querySelector("[data-checkout-default-address-name]");
      const text = checkoutDefaultAddressOption.querySelector("[data-checkout-default-address-text]");
      if (name) name.textContent = checkoutDefaultAddress.addressName || "대표 배송지";
      if (text) text.textContent = `[${checkoutDefaultAddress.postalCode || "우편번호 없음"}] ${checkoutDefaultAddress.address || ""} ${checkoutDefaultAddress.addressDetail || ""}`.trim();
      const defaultMode = checkoutDefaultAddressOption.querySelector('input[value="default"]');
      if (defaultMode) { defaultMode.checked = true; setCheckoutAddressMode("default"); }
    } catch {}
  };

  checkoutFulfillments.forEach((field) => field.addEventListener("change", setCheckoutAddressState));
  checkoutAddressModes.forEach((field) => field.addEventListener("change", () => setCheckoutAddressMode(field.value)));
  setCheckoutAddressState();
  const dateInput = checkoutForm?.elements.pickupDate;
  if (dateInput) {
    const today = new Date();
    const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    dateInput.min = localToday;
  }

  checkoutForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!checkoutForm.checkValidity()) {
      showValidationDialog();
      return;
    }
    if (!checkoutSelection.length || checkoutSubmit.disabled) return;

    const formData = new FormData(checkoutForm);
    const payload = {
      items: checkoutSelection.map((item) => ({ productId: item.id, quantity: item.quantity, quantityUnit: item.quantityUnit || "pack" })),
      customer: String(formData.get("customer") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      fulfillmentType: String(formData.get("fulfillmentType") || "pickup"),
      deliveryAddress: [String(formData.get("address") || "").trim(), String(formData.get("addressDetail") || "").trim()].filter(Boolean).join(" "),
      postalCode: String(formData.get("postalCode") || "").trim(),
      pickupDate: String(formData.get("pickupDate") || ""),
      pickupTime: String(formData.get("pickupTime") || ""),
      memo: String(formData.get("memo") || "").trim(),
      paymentMethod: String(formData.get("paymentMethod") || ""),
      guestPassword: (() => {
        try { return JSON.parse(sessionStorage.getItem(GUEST_CUSTOMER_KEY) || "null")?.password || ""; } catch { return ""; }
      })(),
      guestAddress: (() => {
        try { return JSON.parse(sessionStorage.getItem(GUEST_CUSTOMER_KEY) || "null")?.address || ""; } catch { return ""; }
      })(),
    };
    const fingerprint = JSON.stringify(payload);
    let pending;
    try { pending = JSON.parse(localStorage.getItem(pendingCheckoutKey) || "null"); } catch { pending = null; }
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = {
        fingerprint,
        key: crypto.randomUUID ? crypto.randomUUID() : `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
      localStorage.setItem(pendingCheckoutKey, JSON.stringify(pending));
    }

    checkoutSubmit.disabled = true;
    checkoutSubmit.textContent = "주문 접수 중...";
    checkoutStatus.textContent = "";
    try {
      const response = await fetch(`${API_BASE}/orders/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": pending.key },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status < 500) localStorage.removeItem(pendingCheckoutKey);
        throw new Error(result.error || "주문을 접수하지 못했습니다.");
      }

      localStorage.removeItem(pendingCheckoutKey);
      if (result.paymentUrl) {
        window.location.href = result.paymentUrl;
        return;
      }
      const orderedIds = new Set(checkoutSelection.map((item) => item.id));
      writeCart(cartUtils.removeItems(readCart(), [...orderedIds]));
      checkoutForm.hidden = true;
      checkoutComplete.hidden = false;
      checkoutRoot.querySelector("[data-checkout-complete-id]").textContent = result.checkoutId;
      checkoutRoot.querySelector("[data-checkout-complete-total]").textContent = `${Number(result.totalAmount || 0).toLocaleString("ko-KR")}원`;
      const steps = checkoutRoot.querySelectorAll(".cart-steps li");
      steps.forEach((step, index) => step.classList.toggle("is-current", index === 2));
    } catch (error) {
      checkoutStatus.textContent = error.message || "네트워크 오류가 발생했습니다. 장바구니는 그대로 유지됩니다.";
      checkoutSubmit.disabled = false;
      checkoutSubmit.textContent = "주문 접수하기";
    }
  });

  loadCheckout();
  prefillCheckoutCustomer();
}

let menuItems = [];
const menuButtons = [...document.querySelectorAll(".menu-filters button, .menu-category-bar button")];
