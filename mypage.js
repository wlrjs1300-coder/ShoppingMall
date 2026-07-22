(function initMyPage() {
  const api = async (path, options = {}) => {
    const response = await fetch(`/api/users${path}`, {
      method: options.method || "GET", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (response.status === 401) { location.replace(`login.html?next=${encodeURIComponent("mypage.html")}`); throw new Error("로그인이 필요합니다."); }
    if (!response.ok) throw new Error(body?.error || "요청을 처리하지 못했습니다.");
    return body;
  };
  const won = (value) => `${Number(value || 0).toLocaleString("ko-KR")}원`;
  const date = (value) => value ? new Date(value).toLocaleDateString("ko-KR") : "-";
  const ADDRESS_SLOT_MAX = 3;
  const ADDRESS_SLOT_STORAGE_PREFIX = "tteokAddressSlots";
  const getAddressStorageKey = (userId) => `${ADDRESS_SLOT_STORAGE_PREFIX}:${userId || "anonymous"}`;
  let addressSlots = [];
  let selectedAddressSlotIndex = 0;
  let currentUserId = null;
  const addressSlotsContainer = document.querySelector("[data-address-slots]");

  const getAddressPayloadFromForm = (form) => {
    if (!form) return null;
    return {
      recipientName: String(form.recipientName?.value || "").trim(),
      recipientPhone: String(form.recipientPhone?.value || "").trim(),
      postalCode: String(form.postalCode?.value || "").trim(),
      address: String(form.address?.value || "").trim(),
      addressDetail: String(form.addressDetail?.value || "").trim(),
    };
  };

  const isAddressSlotFilled = (slot) => Boolean(slot?.recipientName && slot?.address);
  const isValidSlotData = (slot) => Boolean(slot && String(slot.recipientName || "").trim() && String(slot.recipientPhone || "").trim() && String(slot.address || "").trim());
  const normalizeAddressSlots = (slots = []) => {
    const normalized = slots
      .filter((slot) => slot && Number(slot.index) > 0 && Number(slot.index) <= ADDRESS_SLOT_MAX)
      .map((slot) => ({
        ...slot,
        index: 0,
        recipientName: String(slot.recipientName || "").trim(),
        recipientPhone: String(slot.recipientPhone || "").trim(),
        postalCode: String(slot.postalCode || "").trim(),
        address: String(slot.address || "").trim(),
        addressDetail: String(slot.addressDetail || "").trim(),
        isDefault: Boolean(slot.isDefault),
      }))
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));

    const compacted = normalized.map((slot, index) => ({ ...slot, index: index + 1 }));
    while (compacted.length < ADDRESS_SLOT_MAX) {
      compacted.push({
        index: compacted.length + 1,
        recipientName: "",
        recipientPhone: "",
        postalCode: "",
        address: "",
        addressDetail: "",
        isDefault: false,
      });
    }

    const hasDefault = compacted.some((slot) => slot.isDefault);
    if (!hasDefault && compacted.some((slot) => isValidSlotData(slot))) {
      compacted.find((slot) => isValidSlotData(slot)).isDefault = true;
    }

    return compacted.slice(0, ADDRESS_SLOT_MAX);
  };

  const readAddressSlots = (userId) => {
    if (!addressSlotsContainer) return [];
    try {
      const source = localStorage.getItem(getAddressStorageKey(userId)) || "[]";
      const parsed = JSON.parse(source);
      if (!Array.isArray(parsed)) return [];
      return normalizeAddressSlots(parsed);
    } catch {
      return [];
    }
  };

  const writeAddressSlots = (userId, slots) => {
    try {
      localStorage.setItem(getAddressStorageKey(userId), JSON.stringify((slots || []).slice(0, ADDRESS_SLOT_MAX)));
    } catch {}
  };

  const fillAddressForm = (form, slot) => {
    if (!form) return;
    form.recipientName.value = slot?.recipientName || "";
    form.recipientPhone.value = slot?.recipientPhone || "";
    form.postalCode.value = slot?.postalCode || "";
    form.address.value = slot?.address || "";
    form.addressDetail.value = slot?.addressDetail || "";
  };

  const renderAddressSlots = (slots, selectedIndex = 0) => {
    if (!addressSlotsContainer) return;
    const filledSlots = slots
      .filter((slot) => isValidSlotData(slot))
      .sort((a, b) => a.index - b.index)
      .map((slot, index) => ({ ...slot, displayIndex: index + 1 }));
    addressSlotsContainer.innerHTML = filledSlots
      .map((slot) => {
        const hasData = true;
        const safeIndex = Number(slot.index || 0);
        const selected = safeIndex === selectedIndex;
        return `
          <article class="mypage-address-slot ${selected ? "is-selected" : ""}">
            <div class="mypage-address-slot-head">
              <strong>배송지 ${slot.displayIndex}</strong>
              ${hasData ? `<button type="button" class="mypage-address-default-button${slot.isDefault ? " is-active" : ""}" data-address-slot-default data-address-slot-index="${safeIndex}" ${slot.isDefault ? "aria-pressed=\"true\"" : "aria-pressed=\"false\""}>대표 배송지</button>` : ""}
            </div>
            ${hasData ? `
              <p>${escape(slot.recipientName)} ${escape(slot.recipientPhone)}</p>
              <p>${escape(slot.address)} ${slot.addressDetail ? ` ${escape(slot.addressDetail)}` : ""}</p>
              ${slot.postalCode ? `<p>우편번호 ${escape(slot.postalCode)}</p>` : ""}
              <div class="mypage-address-slot-actions">
                <button type="button" class="order-action-tab" data-address-slot-edit data-address-slot-index="${safeIndex}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-1 5 5-1L19 9l-4-4L4 16Z"/><path d="m13 7 4 4"/></svg><span>수정</span></button>
                <button type="button" class="order-action-tab is-danger" data-address-slot-delete data-address-slot-index="${safeIndex}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg><span>삭제</span></button>
              </div>
            ` : ""}
          </article>`;
      }).join("") + (filledSlots.length < ADDRESS_SLOT_MAX
        ? `<button type="button" class="mypage-address-add" data-address-slot-add><b aria-hidden="true">+</b><span>배송지 추가</span></button>`
        : "");

    if (!slots.some((slot) => slot.isDefault) && slots[0]) {
      slots[0].isDefault = true;
      writeAddressSlots(currentUserId, slots);
      renderAddressSlots(slots, selectedIndex);
      return;
    }
  };

  const setDefaultAddressSlot = (index) => {
    const safeIndex = Number(index) || 1;
    if (!addressSlots.length || safeIndex < 1 || safeIndex > ADDRESS_SLOT_MAX) return;
    addressSlots.forEach((slot) => {
      slot.isDefault = slot.index === safeIndex;
    });
    writeAddressSlots(currentUserId, addressSlots);
    renderAddressSlots(addressSlots, selectedAddressSlotIndex);
  };

  const syncDefaultAddressFromServer = (addressPayload) => {
    if (!addressPayload || !addressSlots.length) return;
    addressSlots.forEach((slot) => {
      if (!slot.isDefault) return;
      slot.recipientName = String(addressPayload.recipientName || "");
      slot.recipientPhone = String(addressPayload.recipientPhone || "");
      slot.postalCode = String(addressPayload.postalCode || "");
      slot.address = String(addressPayload.address || "");
      slot.addressDetail = String(addressPayload.addressDetail || "");
    });
    writeAddressSlots(currentUserId, addressSlots);
    renderAddressSlots(addressSlots, selectedAddressSlotIndex);
  };

  const initializeAddressSlots = (userId, serverDefaultAddress) => {
    currentUserId = userId || "anonymous";
    addressSlots = normalizeAddressSlots(readAddressSlots(currentUserId));
    if (addressSlots.length < ADDRESS_SLOT_MAX) {
      while (addressSlots.length < ADDRESS_SLOT_MAX) {
        addressSlots.push({
          index: addressSlots.length + 1,
          recipientName: "",
          recipientPhone: "",
          postalCode: "",
          address: "",
          addressDetail: "",
          isDefault: false,
        });
      }
    }
    if (serverDefaultAddress && !addressSlots.some((slot) => isValidSlotData(slot) && slot.isDefault)) {
      addressSlots[0] = { ...addressSlots[0], ...{
        index: 1,
        recipientName: String(serverDefaultAddress.recipientName || ""),
        recipientPhone: String(serverDefaultAddress.recipientPhone || ""),
        postalCode: String(serverDefaultAddress.postalCode || ""),
        address: String(serverDefaultAddress.address || ""),
        addressDetail: String(serverDefaultAddress.addressDetail || ""),
        isDefault: true,
      }};
    }
    if (!addressSlots.some((slot) => slot.isDefault)) addressSlots[0].isDefault = true;
    selectedAddressSlotIndex = addressSlots.findIndex((slot) => slot.isDefault);
    if (selectedAddressSlotIndex < 0) selectedAddressSlotIndex = 0;
    selectedAddressSlotIndex = addressSlots[selectedAddressSlotIndex].index;
    const defaultSlot = addressSlots.find((slot) => slot.isDefault) || addressSlots[0];
    const form = document.querySelector("[data-address-form]");
    if (form) form.hidden = true;
    writeAddressSlots(currentUserId, addressSlots);
    renderAddressSlots(addressSlots, selectedAddressSlotIndex);
  };

  const getAddressSlot = (index) => addressSlots.find((slot) => slot.index === Number(index));
  const selectAddressSlot = (index) => {
    if (!addressSlots.length) return null;
    const safeIndex = Number(index) || addressSlots[0].index;
    const nextSlot = getAddressSlot(safeIndex) || addressSlots[0];
    selectedAddressSlotIndex = nextSlot?.index || addressSlots[0].index;
    renderAddressSlots(addressSlots, selectedAddressSlotIndex);
    const form = document.querySelector("[data-address-form]");
    if (form) fillAddressForm(form, nextSlot);
    const hiddenField = form?.querySelector("[name='addressSlotIndex']");
    if (hiddenField) hiddenField.value = String(selectedAddressSlotIndex);
    return nextSlot;
  };

  const applyDefaultAddressSlotToServer = async (slot) => {
    if (!slot || !isValidSlotData(slot)) return;
    await api("/me/address", {
      method: "PATCH",
      body: {
        recipientName: slot.recipientName,
        recipientPhone: slot.recipientPhone,
        postalCode: slot.postalCode,
        address: slot.address,
        addressDetail: slot.addressDetail,
      },
    });
  };

  const persistAddressSlots = async () => {
    writeAddressSlots(currentUserId, addressSlots);
    const payload = addressSlots.find((slot) => slot.isDefault) || addressSlots[0];
    if (isValidSlotData(payload)) {
      try {
        await applyDefaultAddressSlotToServer(payload);
        syncDefaultAddressFromServer(payload);
      } catch (error) {
        console.warn("주소 저장 연동 실패", error);
      }
    }
  };

  const setAddressSlotData = (index, payload) => {
    const safeIndex = Number(index);
    const target = getAddressSlot(safeIndex);
    if (!target) return null;
    const next = {
      ...target,
      recipientName: String(payload.recipientName || ""),
      recipientPhone: String(payload.recipientPhone || ""),
      postalCode: String(payload.postalCode || ""),
      address: String(payload.address || ""),
      addressDetail: String(payload.addressDetail || ""),
      isDefault: Boolean(target.isDefault),
    };
    if (selectedAddressSlotIndex === safeIndex) selectedAddressSlotIndex = next.index;
    addressSlots = addressSlots.map((slot) => (slot.index === safeIndex ? next : slot));
    return next;
  };
  const formatOrderDateTime = (value) => {
    if (!value) return "-";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleString("ko-KR");
  };
  const getOrderDateKey = (value) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    const year = String(parsed.getFullYear());
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const getOrderDateLabel = (key) => {
    if (!key) return "기록 없음";
    const [year, month, day] = key.split("-");
    return `${year}년 ${Number(month)}월 ${Number(day)}일`;
  };
  const getOrderDateGroupKey = (order) => {
    return getOrderDateKey(order?.createdAt) || "기록 없음";
  };
  const getDateGroupKeys = (orders = []) => {
    const keys = Array.from(new Set(orders.map((order) => getOrderDateGroupKey(order)).filter(Boolean)));
    keys.sort((a, b) => {
      if (a === "기록 없음" && b === "기록 없음") return 0;
      if (a === "기록 없음") return 1;
      if (b === "기록 없음") return -1;
      return String(b).localeCompare(String(a));
    });
    return keys;
  };
  const setFormValue = (form, name, value) => {
    if (!form) return;
    const field = form.elements && form.elements[name] ? form.elements[name] : form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (field) field.value = value;
  };
  const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const message = (selector, text, success = false) => { const el = document.querySelector(selector); el.textContent = text; el.classList.toggle("is-success", success); };
  const inquiryApi = async (path, options = {}) => {
    const response = await fetch(`${API_BASE}/inquiries${path}`, { method: options.method || "GET", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: options.body ? JSON.stringify(options.body) : undefined });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "문의 내역을 불러오지 못했습니다.");
    return body;
  };
  const normalizeOrderStatus = (status) => {
    if (!status) return "";
    const normalized = String(status).trim();
    const map = {
      "결제완료": "접수완료", "결제대기": "접수대기", "주문접수": "접수완료",
      "상품준비중": "상품준비중", "상품준비완료": "상품준비완료", "배송준비중": "상품준비완료",
      "배송중": "배송중", "배송완료": "배송완료", "픽업준비중": "픽업준비완료",
      "픽업준비완료": "픽업준비완료", "픽업완료": "픽업완료",
      "취소": "취소", "주문취소": "취소", "결제취소": "취소", "환불완료": "취소", "주문완료": "주문완료",
    };
    return map[normalized] || normalized;
  };
  const getUnifiedOrderStatus = (order) => {
    const status = normalizeOrderStatus(order?.status);
    if (status === "취소") return "취소";
    if (status) return status;
    const workflow = normalizeOrderStatus(order?.workflowStatus);
    if (workflow === "취소") return "취소";
    if (workflow) return workflow;
    const paymentStatus = normalizeOrderStatus(order?.paymentStatus);
    if (paymentStatus === "취소") return "취소";
    return paymentStatus || "접수완료";
  };
  const getStatusMeta = (status) => {
    if (status === "취소") return { label: "취소", icon: "×", className: "is-danger" };
    if (status === "주문완료") return { label: "주문완료", icon: "✓", className: "is-status-start" };
    if (["배송완료", "픽업완료"].includes(status)) return { label: status, icon: "✓", className: "is-success is-status-complete" };
    if (["상품준비완료", "상품준비중", "배송중", "픽업준비완료", "접수완료"].includes(status)) return { label: status, icon: "•", className: "is-success is-status-progress" };
    return { label: status || "접수완료", icon: "•", className: "is-success is-status-start" };
  };
  const getOrderStatusLabel = (order) => getUnifiedOrderStatus(order);
  const getEstimatedArrivalLabel = (order) => {
    const createdAt = new Date(order?.createdAt || Date.now());
    if (Number.isNaN(createdAt.getTime())) return "도착일 미정";
    const estimated = new Date(createdAt);
    estimated.setDate(estimated.getDate() + 2);
    const month = estimated.getMonth() + 1;
    const day = estimated.getDate();
    const weekday = ["일", "월", "화", "수", "목", "금", "토"][estimated.getDay()];
    const base = `${month}/${day}(${weekday})`;
    return `${base} ${order?.fulfillmentType === "pickup" ? "픽업" : "도착"}`;
  };
  const getOrderImageSrc = (item = {}) => {
    const src = item.productImage;
    if (!src) return "assets/logo.svg";
    return src;
  };
  const normalizeProductDisplayName = (value) => {
    const name = String(value || "").trim();
    if (!name || name === "상품") return "";
    if (/^\s*(?:\d+|[가-힣]+)\s*번째\s*샘플(?:\s*주문)?\s*$/i.test(name)) return "";
    if (/^\s*샘플(?:\s*상품|\s*주문)?\s*$/i.test(name)) return "";
    return name;
  };
  const getDisplayItemObjects = (order = {}) => {
    const items = Array.isArray(order.items) ? order.items : [];
    return items
      .map((item) => {
        const rawName = item?.productName || item?.name || item?.title;
        const normalizedName = normalizeProductDisplayName(rawName);
        if (!normalizedName) return null;
        return { ...item, productName: normalizedName };
      })
      .filter(Boolean);
  };
  const getDisplayItems = (order = {}) => getDisplayItemObjects(order).map((item) => item.productName).filter(Boolean);
  const buildOrderProductSummary = (order) => {
    const items = getDisplayItems(order);
    if (!items.length) return "상품 정보 없음";
    const [first, ...rest] = items;
    return `${escape(first)}${rest.length > 0 ? ` 외 ${rest.length}건` : ""}`;
  };
  const buildOrderItemList = (order, isOpen) => {
    const items = getDisplayItems(order);
    if (!items.length) return "";
    const list = items.map((name) => `<li>${escape(name)}</li>`).join("");
    return `<div class="member-order-items-details ${isOpen ? "is-open" : ""}">
      <button type="button" class="member-order-item-toggle" aria-expanded="${isOpen ? "true" : "false"}" data-order-items-toggle>주문한 상품 보기</button>
      <ul class="member-order-item-list ${isOpen ? "is-open" : ""}" data-order-item-list>${list}</ul>
    </div>`;
  };
  const getDisplayOption = (item = {}) => item.option || "";
  const canReviewOrder = (order) => {
    const status = getOrderStatusLabel(order);
    return status === "배송완료" || status === "픽업완료";
  };
  const getOrderStatusDisplay = (order) => getStatusMeta(getOrderStatusLabel(order)).label;
  const orderDateFilter = document.querySelector("[data-order-date-filter]");
  const orderDatePagination = document.querySelector("[data-order-date-pagination]");
  const orderDateSection = document.querySelector("[data-mypage-panel='orders']");
  const ORDER_DATE_PAGE_SIZE = 5;
  let allOrders = [];
  let activeOrderDateKey = "all";
  let orderDatePage = 1;

  const scrollToOrderTop = () => {
    if (!orderDateSection) return;
    orderDateSection.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const renderOrderDatePagination = (orders = []) => {
    if (!orderDatePagination) return;
    if (activeOrderDateKey !== "all") {
      orderDatePagination.hidden = true;
      orderDatePagination.innerHTML = "";
      return;
    }
    const dateGroupKeys = getDateGroupKeys(orders);
    const totalPages = Math.max(1, Math.ceil(dateGroupKeys.length / ORDER_DATE_PAGE_SIZE));
    if (dateGroupKeys.length <= ORDER_DATE_PAGE_SIZE) {
      orderDatePagination.hidden = true;
      orderDatePagination.innerHTML = "";
      return;
    }
    if (orderDatePage > totalPages) orderDatePage = totalPages;
    if (orderDatePage < 1) orderDatePage = 1;
    orderDatePagination.hidden = false;
    orderDatePagination.innerHTML = `
      <button type="button" class="order-date-page-button is-prev" data-order-page="prev" ${orderDatePage <= 1 ? "disabled" : ""}>?댁쟾</button>
      <span class="order-date-page-status">${orderDatePage} / ${totalPages} 페이지</span>
      <button type="button" class="order-date-page-button is-next" data-order-page="next" ${orderDatePage >= totalPages ? "disabled" : ""}>?ㅼ쓬</button>
    `;
  };

  const getDatePageRangeOrders = (orders = []) => {
    if (activeOrderDateKey !== "all") return orders;
    const keys = getDateGroupKeys(orders);
    const totalPages = Math.max(1, Math.ceil(keys.length / ORDER_DATE_PAGE_SIZE));
    if (orderDatePage > totalPages) orderDatePage = totalPages;
    if (orderDatePage < 1) orderDatePage = 1;
    const start = (orderDatePage - 1) * ORDER_DATE_PAGE_SIZE;
    const visibleKeys = new Set(keys.slice(start, start + ORDER_DATE_PAGE_SIZE));
    return orders.filter((order) => visibleKeys.has(getOrderDateGroupKey(order)));
  };

  const renderOrderDateTabs = () => {
    if (!orderDateFilter) return;
    const dateKeys = Array.from(new Set(allOrders.map((order) => getOrderDateKey(order.createdAt)).filter(Boolean)));
    dateKeys.sort();
    dateKeys.reverse();
    const hasSelectableTabs = dateKeys.length > 1;
    if (activeOrderDateKey !== "all" && hasSelectableTabs && !dateKeys.includes(activeOrderDateKey)) {
      activeOrderDateKey = "all";
    }

    if (!hasSelectableTabs) {
      orderDateFilter.hidden = true;
      orderDateFilter.innerHTML = "";
      return;
    }
    orderDateFilter.hidden = false;
    const tabs = [
      `<button type="button" class="order-date-tab is-active" role="tab" aria-selected="true" data-order-date-tab="all">전체</button>`,
      ...dateKeys.map((key) => `<button type="button" class="order-date-tab" role="tab" data-order-date-tab="${escape(key)}" aria-selected="false">${getOrderDateLabel(key)}</button>`),
    ];
    orderDateFilter.innerHTML = tabs.join("");
    setActiveOrderDateTab(activeOrderDateKey);
  };

  const setActiveOrderDateTab = (key) => {
    if (!orderDateFilter) return;
    const tabs = [...orderDateFilter.querySelectorAll(".order-date-tab")];
    tabs.forEach((tab) => {
      const isActive = tab.dataset.orderDateTab === key;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });
  };

  const renderOrdersForSelectedDate = () => {
    try {
      if (activeOrderDateKey !== "all") {
        orderDatePage = 1;
      }
      const dateOrders = activeOrderDateKey === "all"
        ? getDatePageRangeOrders(allOrders)
        : allOrders.filter((order) => getOrderDateKey(order.createdAt) === activeOrderDateKey);
      renderOrders(dateOrders);
      renderOrderDatePagination(allOrders);
    } catch (error) {
      console.error("마이페이지 주문 필터 렌더링 실패:", error);
      allOrders = allOrders || [];
      renderOrders(allOrders);
      activeOrderDateKey = "all";
      setActiveOrderDateTab(activeOrderDateKey);
      renderOrderDatePagination(allOrders);
    }
  };
  const getOrderFulfillmentSteps = (order) => (order?.fulfillmentType === "pickup" ? [
    ["접수완료", "주문이 접수되어 픽업 준비를 시작합니다.", "01"],
    ["상품준비", "상품을 정성껏 준비하고 있습니다.", "02"],
    ["픽업준비완료", "상품 수령이 가능한 상태입니다.", "03"],
    ["픽업완료", "상품 픽업이 완료되었습니다.", "04"],
  ] : [
    ["접수완료", "주문이 접수되어 배송 준비를 시작합니다.", "01"],
    ["상품준비", "상품을 정성껏 준비하고 있습니다.", "02"],
    ["배송출발", "상품이 출발하여 배송 중입니다.", "03"],
    ["배송완료", "상품 배송이 완료되었습니다.", "04"],
  ]);
  const getTimelineStepTime = (order, keys) => {
    for (const key of keys) {
      const value = order?.[key];
      if (value) return formatOrderDateTime(value);
    }
    return "-";
  };
  const getStatusHistoryTime = (order, targetStatuses) => {
    if (!Array.isArray(order?.statusHistory) || !order.statusHistory.length) return null;
    const matched = new Set(targetStatuses.map((status) => normalizeOrderStatus(status)));
    for (const entry of order.statusHistory) {
      const next = normalizeOrderStatus(entry?.nextStatus);
      const previous = normalizeOrderStatus(entry?.previousStatus);
      if (matched.has(next) || matched.has(previous)) {
        return entry.createdAt || null;
      }
    }
    return null;
  };
  const getHistoryAwareTimelineTime = (order, keys) => {
    const primary = getTimelineStepTime(order, keys);
    if (primary !== "-") return primary;
    const statusAliases = {
      주문완료: ["주문완료", "결제완료", "결제대기", "접수대기", "접수완료"],
      접수완료: ["접수완료", "접수대기", "결제완료", "결제대기"],
      픽업준비완료: ["픽업준비완료", "상품준비완료", "상품준비중"],
      픽업완료: ["픽업완료"],
      배송출발: ["배송출발", "배송중"],
      배송완료: ["배송완료", "완료"],
      배송준비완료: ["상품준비완료", "상품준비중", "배송준비완료"],
    };
    const aliasTargets = keys.flatMap((key) => statusAliases[key] || [key]);
    const fromHistory = getStatusHistoryTime(order, aliasTargets);
    return fromHistory ? formatOrderDateTime(fromHistory) : "-";
  };
  const getProcessTimeline = (order) => (order?.fulfillmentType === "pickup" ? [
    { label: "주문완료", time: getHistoryAwareTimelineTime(order, ["주문완료", "completedAt", "orderCompletedAt", "createdAt"]), icon: "01", description: "주문이 완료되었습니다." },
    { label: "접수완료", time: getHistoryAwareTimelineTime(order, ["접수완료", "acceptedAt", "confirmedAt", "updatedAt"]), icon: "02", description: "매장에서 주문을 확인했습니다." },
    { label: "픽업준비완료", time: getHistoryAwareTimelineTime(order, ["픽업준비완료", "preparedAt", "pickReadyAt", "itemReadyAt", "shippedAt"]), icon: "03", description: "상품을 픽업할 수 있습니다." },
    { label: "픽업완료", time: getHistoryAwareTimelineTime(order, ["픽업완료", "pickedUpAt", "completedAt", "orderCompletedAt"]), icon: "04", description: "상품 픽업이 완료되었습니다." },
  ] : [
    { label: "주문완료", time: getHistoryAwareTimelineTime(order, ["주문완료", "completedAt", "orderCompletedAt", "createdAt"]), icon: "01", description: "주문이 완료되었습니다." },
    { label: "접수완료", time: getHistoryAwareTimelineTime(order, ["접수완료", "acceptedAt", "confirmedAt", "updatedAt"]), icon: "02", description: "매장에서 주문을 확인했습니다." },
    { label: "배송출발", time: getHistoryAwareTimelineTime(order, ["배송출발", "배송중", "shippedAt", "dispatchAt", "deliveryStartedAt"]), icon: "03", description: "상품이 출발하여 이동 중입니다." },
    { label: "배송완료", time: getHistoryAwareTimelineTime(order, ["배송완료", "deliveredAt", "completedAt", "orderCompletedAt"]), icon: "04", description: "상품 배송이 완료되었습니다." },
  ]);
  const getProcessTimelineStepIndex = (order) => {
    const status = getOrderStatusLabel(order);
    if (order?.fulfillmentType === "pickup") {
      const map = { 주문완료: 0, 접수완료: 1, 접수대기: 1, 상품준비중: 1, 상품준비완료: 1, 픽업준비완료: 2, 픽업완료: 3, 취소: -1 };
      return map[status] ?? 0;
    }
    const map = { 주문완료: 0, 접수완료: 1, 접수대기: 1, 상품준비중: 1, 상품준비완료: 1, 배송중: 2, 배송완료: 3, 취소: -1 };
    return map[status] ?? 0;
  };
  const buildOrderFulfillmentJourney = (order) => {
    const status = getOrderStatusLabel(order);
    const steps = getOrderFulfillmentSteps(order);
    const map = order?.fulfillmentType === "pickup"
      ? { 접수완료: 0, 결제완료: 0, 상품준비중: 1, 상품준비완료: 1, 픽업준비완료: 2, 픽업완료: 3, 취소: -1 }
      : { 접수완료: 0, 결제완료: 0, 상품준비중: 1, 상품준비완료: 1, 배송중: 2, 배송완료: 3, 취소: -1 };
    const currentIndex = map[status] ?? 0;
    const progress = status === "취소" ? 0 : Math.round((currentIndex / (steps.length - 1)) * 100);
    const currentLabel = status === "취소" ? "주문 취소" : status;

    return `<section class="member-order-journey-section${status === "취소" ? " is-cancelled" : ""}" aria-label="${order?.fulfillmentType === "pickup" ? "픽업 진행" : "배송 진행"}">
      <div class="member-order-journey-head">
        <div>
          <h3>${order?.fulfillmentType === "pickup" ? "픽업 진행" : "배송 진행"}</h3>
          <p class="member-order-journey-subtitle">현재 주문 진행 상태: ${currentLabel}</p>
        </div>
        <span class="member-order-journey-meta">${status === "취소" ? "주문 취소" : `${currentIndex + 1}/${steps.length} 단계`}</span>
      </div>
      <div class="member-order-journey" style="--journey-progress:${progress / 100}">
        ${steps.map(([label, description, icon], index) => `<article class="${index < currentIndex ? "is-complete" : index === currentIndex && status !== "취소" ? "is-active" : "is-upcoming"}"><div class="member-order-journey-illustration">${index < currentIndex ? "✓" : icon}</div><strong>${label}</strong><p>${description}</p></article>`).join("")}
      </div>
    </section>`;
  };
  const buildShippingTrackingDetail = (order) => {
    const status = getOrderStatusLabel(order);
    const statusDisplay = getOrderStatusDisplay(order);
    const steps = getOrderFulfillmentSteps(order);
    const processSteps = getProcessTimeline(order);
    const processStepIndex = getProcessTimelineStepIndex(order);
    const stepMap = order?.fulfillmentType === "pickup"
      ? { 접수완료: 0, 결제완료: 0, 상품준비중: 1, 상품준비완료: 1, 픽업준비완료: 2, 픽업완료: 3, 취소: -1 }
      : { 접수완료: 0, 결제완료: 0, 상품준비중: 1, 상품준비완료: 1, 배송중: 2, 배송완료: 3, 취소: -1 };
    const currentIndex = stepMap[status] ?? 0;
    const progress = status === "취소" ? 0 : Math.round((currentIndex / (steps.length - 1)) * 100);

    return `
      <span class="dialog-eyebrow">SHIPMENT TRACKING</span>
      <header class="order-tracking-head">
        <div class="order-tracking-title-wrap">
          <h2>배송 조회</h2>
          <p class="order-tracking-status-text">현재 상태: ${escape(statusDisplay)}</p>
        </div>
      </header>
      <section class="order-tracking-summary">
        <article class="order-tracking-summary-card is-process">
          <h3>배송·픽업 진행 과정</h3>
          <p class="order-tracking-summary-hint">주문 완료부터 현재 단계까지 시간 순서로 확인할 수 있습니다.</p>
          <ol class="order-tracking-process">
            ${processSteps.map((item, index) => {
              const state = index < processStepIndex ? "is-complete" : index === processStepIndex && status !== "취소" ? "is-active" : "is-upcoming";
              return `<li class="order-tracking-process-item ${state}"><span class="order-tracking-process-dot">${escape(item.icon)}</span><span class="order-tracking-process-content"><span class="order-tracking-process-label">${escape(item.label)}</span><span class="order-tracking-process-time">${escape(item.time)}</span><span class="order-tracking-process-desc">${escape(item.description)}</span></span></li>`;
            }).join("")}
          </ol>
        </article>
      </section>
      <section class="order-tracking-journey">
        <h3>${order.fulfillmentType === "pickup" ? "픽업 진행" : "배송 진행"}</h3>
        <div class="member-order-journey" style="--journey-progress:${progress / 100}">
          ${steps.map(([label, description, icon], index) => {
            const state = index < currentIndex ? "is-complete" : index === currentIndex && status !== "취소" ? "is-active" : "is-upcoming";
            return `<article class="${state}"><div class="member-order-journey-illustration">${index < currentIndex ? "✓" : icon}</div><strong>${escape(label)}</strong><p>${escape(description)}</p></article>`;
          }).join("")}
        </div>
      </section>
    `;
  };
  let memberInquiries = [];

  function renderInquiries(inquiries) {
    const list = document.querySelector("[data-member-inquiries]");
    const empty = document.querySelector("[data-inquiries-empty]");
    if (!list || !empty) return;
    empty.hidden = inquiries.length > 0;
    list.innerHTML = inquiries.map((item) => {
      const answered = item.status === "답변완료" && item.adminReply;
      const unread = answered && !item.readAt;
      const photos = Array.isArray(item.photos) ? item.photos.slice(0, 3) : [];
      return `<article class="mypage-inquiry-card ${unread ? "is-unread" : ""}" data-inquiry-id="${escape(item.id)}"><header><div><h3>${escape(item.productName)}</h3><span class="inquiry-member-status ${answered ? "is-answered" : ""}">${escape(item.status || "접수")}</span></div><time>${date(item.createdAt)}</time></header><small class="mypage-inquiry-id">접수번호 ${escape(item.id)}</small><p class="mypage-inquiry-question">${escape(item.message)}</p>${photos.length ? `<div class="mypage-inquiry-photos">${photos.map((photo, index) => `<img src="${escape(photo)}" alt="${escape(item.productName)} 문의 사진 ${index + 1}" loading="lazy" />`).join("")}</div>` : ""}${answered ? `<div class="mypage-inquiry-answer"><span>SHOP REPLY</span><p>${escape(item.adminReply)}</p></div>` : `<p class="mypage-inquiry-waiting">답변을 준비하고 있습니다.</p>`}<div class="mypage-content-actions"><button type="button" data-inquiry-edit ${answered ? "disabled title=\"답변 완료 문의는 수정할 수 없습니다\"" : ""}>수정</button><button type="button" class="is-danger" data-inquiry-delete>삭제</button></div></article>`;
    }).join("");
    const count = inquiries.filter((item) => item.status === "답변완료" && item.adminReply && !item.readAt).length;
    const badge = document.querySelector("[data-mypage-inquiry-count]");
    if (badge) { badge.textContent = String(count); badge.hidden = !count; }
  }

  const mypageTabs = [...document.querySelectorAll("[data-mypage-tab]")];
  const mypagePanels = [...document.querySelectorAll("[data-mypage-panel]")];
  const activateMyPageTab = (tabName, updateUrl = true) => {
    const selectedTab = mypageTabs.find((tab) => tab.dataset.mypageTab === tabName) || mypageTabs[0];
    if (!selectedTab) return;
    mypageTabs.forEach((tab) => {
      const active = tab === selectedTab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    mypagePanels.forEach((panel) => { panel.hidden = panel.dataset.mypagePanel !== selectedTab.dataset.mypageTab; });
    if (updateUrl) history.replaceState(null, "", `#${selectedTab.dataset.mypageTab}`);
    if (selectedTab.dataset.mypageTab === "inquiries" && memberInquiries.some((item) => item.status === "답변완료" && item.adminReply && !item.readAt)) {
      inquiryApi("/mine/read", { method: "POST" }).then(() => {
        memberInquiries = memberInquiries.map((item) => ({ ...item, readAt: item.status === "답변완료" && item.adminReply ? new Date().toISOString() : item.readAt }));
        renderInquiries(memberInquiries);
        document.querySelectorAll("[data-inquiry-unread]").forEach((node) => { node.hidden = true; });
      }).catch(() => {});
    }
  };
  document.querySelector(".mypage-nav")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-mypage-tab]");
    if (tab) activateMyPageTab(tab.dataset.mypageTab);
  });
  document.querySelector(".mypage-nav")?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, mypageTabs.indexOf(document.activeElement));
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? mypageTabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + mypageTabs.length) % mypageTabs.length;
    mypageTabs[nextIndex].focus();
    activateMyPageTab(mypageTabs[nextIndex].dataset.mypageTab);
  });
  activateMyPageTab(location.hash.slice(1), false);

  let memberReviews = [];
  let reviewOwnerId = "";
  const renderMyReviews = (userId, username = "") => {
    const list = document.querySelector("[data-member-reviews]");
    const empty = document.querySelector("[data-reviews-empty]");
    if (!list || !empty) return;
    let storedReviews = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(`tteokReviews:${userId || "anonymous"}`) || "[]");
      if (Array.isArray(parsed)) storedReviews = parsed;
    } catch {}
    if (!storedReviews.length && username === "portfolio_admin") {
      storedReviews = [
        { id: "portfolio-review-01", productName: "깨송편", rating: 5, keywords: ["맛이 좋아요", "포장이 깔끔해요"], photos: ["assets/products/menu-songpyeon.png", "assets/products/songpyeon.jpg"], content: "떡이 부드럽고 깨소가 고소해서 부모님도 맛있게 드셨어요. 포장도 단정해서 선물하기 좋았습니다.", createdAt: "2026-07-20T04:30:00.000Z" },
        { id: "portfolio-review-02", productName: "현절편", rating: 4, keywords: ["신선해요", "응대가 친절해요"], photos: ["assets/products/menu-white-jeolpyeon.png"], content: "쫀득한 식감이 좋고 당일 픽업 안내도 친절했습니다. 다음 행사 때도 주문하고 싶어요.", createdAt: "2026-07-12T07:10:00.000Z" },
        { id: "portfolio-review-03", productName: "답례떡", rating: 5, keywords: ["선물하기 좋아요", "포장이 깔끔해요"], photos: ["assets/products/menu-gift-box.png", "assets/products/menu-assorted-seolgi.png", "assets/products/assorted-tteok.jpg"], content: "회사 행사 답례품으로 주문했는데 개별 포장과 스티커가 깔끔했습니다. 수량도 정확하게 준비해 주셨어요.", createdAt: "2026-06-28T02:50:00.000Z" },
      ];
      try { localStorage.setItem(`tteokReviews:${userId}`, JSON.stringify(storedReviews)); } catch {}
    }
    if (username === "portfolio_admin") {
      const demoReviewDetails = {
        "portfolio-review-01": { keywords: ["맛이 좋아요", "포장이 깔끔해요"], photos: ["assets/products/menu-songpyeon.png", "assets/products/songpyeon.jpg"] },
        "portfolio-review-02": { keywords: ["신선해요", "응대가 친절해요"], photos: ["assets/products/menu-white-jeolpyeon.png"] },
        "portfolio-review-03": { keywords: ["선물하기 좋아요", "포장이 깔끔해요"], photos: ["assets/products/menu-gift-box.png", "assets/products/menu-assorted-seolgi.png", "assets/products/assorted-tteok.jpg"] },
      };
      let demoReviewsUpdated = false;
      storedReviews = storedReviews.map((review) => {
        const details = demoReviewDetails[review.id];
        if (!details || (Array.isArray(review.photos) && review.photos.length)) return review;
        demoReviewsUpdated = true;
        return { ...review, keywords: review.keywords?.length ? review.keywords : details.keywords, photos: details.photos };
      });
      if (demoReviewsUpdated) {
        try { localStorage.setItem(`tteokReviews:${userId}`, JSON.stringify(storedReviews)); } catch {}
      }
    }
    const orderReviews = allOrders.flatMap((order) => {
      const review = order.review || order.customerReview;
      if (!review) return [];
      return [{
        id: review.id || order.id,
        productName: review.productName || order.productName || order.product || "주문 상품",
        rating: Number(review.rating || 5),
        content: review.content || review.message || "",
        keywords: Array.isArray(review.keywords) ? review.keywords : [],
        imageUrl: review.imageUrl || "",
        createdAt: review.createdAt || order.updatedAt || order.createdAt,
      }];
    });
    const seen = new Set();
    const reviews = [...storedReviews, ...orderReviews].filter((review) => {
      const key = String(review.id || `${review.productName}-${review.createdAt}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    memberReviews = reviews;
    reviewOwnerId = userId || "anonymous";
    empty.hidden = reviews.length > 0;
    list.innerHTML = reviews.map((review) => {
      const rating = Math.max(1, Math.min(5, Number(review.rating || 5)));
      const keywords = Array.isArray(review.keywords) ? review.keywords.filter(Boolean) : [];
      const photos = Array.isArray(review.photos) ? review.photos.slice(0, 3) : [];
      return `<article class="mypage-review-card" data-review-id="${escape(review.id)}"><header><div><h3>${escape(review.productName || "상품 리뷰")}</h3><span class="mypage-review-stars" aria-label="별점 ${rating}점">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span></div><time>${date(review.createdAt)}</time></header>${keywords.length ? `<div class="mypage-review-keywords">${keywords.map((keyword) => `<span>${escape(keyword)}</span>`).join("")}</div>` : ""}${photos.length ? `<div class="mypage-review-photos">${photos.map((photo, index) => `<img src="${escape(photo)}" alt="${escape(review.productName || "상품")} 리뷰 사진 ${index + 1}" loading="lazy" />`).join("")}</div>` : ""}<p>${escape(review.content || "작성한 리뷰 내용이 없습니다.")}</p><div class="mypage-content-actions"><button type="button" data-review-edit>수정</button><button type="button" class="is-danger" data-review-delete>삭제</button></div></article>`;
    }).join("");
  };

  const inquiryEditDialog = document.querySelector("[data-inquiry-edit-dialog]");
  const inquiryEditForm = document.querySelector("[data-inquiry-edit-form]");
  const inquiryEditPhotoInput = document.querySelector("[data-inquiry-edit-photo-input]");
  const inquiryEditPhotoPreview = document.querySelector("[data-inquiry-edit-photo-preview]");
  let inquiryEditPhotos = [];
  const renderInquiryEditPhotos = () => {
    if (!inquiryEditPhotoPreview) return;
    inquiryEditPhotoPreview.innerHTML = inquiryEditPhotos.map((photo, index) => `<div class="review-photo-item"><img src="${escape(photo)}" alt="문의 첨부 사진 ${index + 1}" /><button type="button" data-inquiry-edit-photo-remove="${index}" aria-label="첨부 사진 ${index + 1} 삭제">×</button></div>`).join("");
  };
  const compressInquiryPhoto = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("사진을 불러오지 못했습니다."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("지원하지 않는 사진 파일입니다."));
      image.onload = () => {
        const scale = Math.min(1, 960 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/webp", 0.75));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  document.querySelector("[data-member-inquiries]")?.addEventListener("click", async (event) => {
    const card = event.target.closest("[data-inquiry-id]");
    if (!card) return;
    const inquiry = memberInquiries.find((item) => item.id === card.dataset.inquiryId);
    if (!inquiry) return;
    if (event.target.closest("[data-inquiry-edit]") && !event.target.closest("button")?.disabled) {
      inquiryEditForm.elements.id.value = inquiry.id;
      inquiryEditForm.elements.quantity.value = inquiry.quantity || 1;
      inquiryEditForm.elements.desiredDate.value = inquiry.desiredDate || "";
      inquiryEditForm.elements.message.value = inquiry.message || "";
      inquiryEditPhotos = Array.isArray(inquiry.photos) ? inquiry.photos.slice(0, 3) : [];
      if (inquiryEditPhotoInput) inquiryEditPhotoInput.value = "";
      renderInquiryEditPhotos();
      inquiryEditDialog.showModal();
    }
    if (event.target.closest("[data-inquiry-delete]") && await AppUI.confirm("이 문의 내역을 삭제할까요? 삭제 후에는 복구할 수 없습니다.", { title: "문의 삭제", tone: "danger", confirmText: "삭제", cancelText: "취소" })) {
      try {
        await inquiryApi(`/mine/${encodeURIComponent(inquiry.id)}`, { method: "DELETE" });
        memberInquiries = memberInquiries.filter((item) => item.id !== inquiry.id);
        renderInquiries(memberInquiries);
        AppUI.toast("문의 내역을 삭제했습니다.", "success");
      } catch (error) { AppUI.alert(error.message); }
    }
  });
  inquiryEditPhotoInput?.addEventListener("change", async () => {
    const messageNode = document.querySelector("[data-inquiry-edit-message]");
    messageNode.textContent = "";
    const available = 3 - inquiryEditPhotos.length;
    const files = [...(inquiryEditPhotoInput.files || [])].slice(0, Math.max(available, 0));
    if (!files.length && available <= 0) messageNode.textContent = "사진은 최대 3장까지 첨부할 수 있습니다.";
    for (const file of files) {
      if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
        messageNode.textContent = "사진은 JPG, PNG, WEBP 형식의 5MB 이하 파일만 첨부할 수 있습니다.";
        continue;
      }
      try { inquiryEditPhotos.push(await compressInquiryPhoto(file)); }
      catch (error) { messageNode.textContent = error.message; }
    }
    inquiryEditPhotoInput.value = "";
    renderInquiryEditPhotos();
  });
  inquiryEditPhotoPreview?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-inquiry-edit-photo-remove]");
    if (!button) return;
    inquiryEditPhotos.splice(Number(button.dataset.inquiryEditPhotoRemove), 1);
    renderInquiryEditPhotos();
  });
  document.querySelector("[data-inquiry-edit-cancel]")?.addEventListener("click", () => inquiryEditDialog.close());
  inquiryEditForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const { inquiry } = await inquiryApi(`/mine/${encodeURIComponent(form.elements.id.value)}`, {
        method: "PATCH",
        body: { quantity: Number(form.elements.quantity.value), desiredDate: form.elements.desiredDate.value, message: form.elements.message.value.trim(), photos: [...inquiryEditPhotos] },
      });
      memberInquiries = memberInquiries.map((item) => item.id === inquiry.id ? inquiry : item);
      renderInquiries(memberInquiries);
      inquiryEditDialog.close();
      AppUI.toast("문의 내용을 수정했습니다.", "success");
    } catch (error) { message("[data-inquiry-edit-message]", error.message); }
  });

  const reviewEditDialog = document.querySelector("[data-review-edit-dialog]");
  const reviewEditForm = document.querySelector("[data-review-edit-form]");
  document.querySelector("[data-member-reviews]")?.addEventListener("click", async (event) => {
    const card = event.target.closest("[data-review-id]");
    if (!card) return;
    const review = memberReviews.find((item) => String(item.id) === card.dataset.reviewId);
    if (!review) return;
    if (event.target.closest("[data-review-edit]")) {
      reviewEditForm.elements.id.value = review.id;
      reviewEditForm.elements.rating.value = String(review.rating || 5);
      reviewEditForm.elements.content.value = review.content || "";
      document.querySelector("[data-review-edit-product]").textContent = `${review.productName || "상품"} 리뷰를 수정합니다.`;
      reviewEditDialog.showModal();
    }
    if (event.target.closest("[data-review-delete]") && await AppUI.confirm("이 리뷰를 삭제할까요? 삭제 후에는 복구할 수 없습니다.", { title: "리뷰 삭제", tone: "danger", confirmText: "삭제", cancelText: "취소" })) {
      memberReviews = memberReviews.filter((item) => String(item.id) !== String(review.id));
      try { localStorage.setItem(`tteokReviews:${reviewOwnerId}`, JSON.stringify(memberReviews)); } catch {}
      renderMyReviews(reviewOwnerId);
      AppUI.toast("리뷰를 삭제했습니다.", "success");
    }
  });
  document.querySelector("[data-review-edit-cancel]")?.addEventListener("click", () => reviewEditDialog.close());
  reviewEditForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    memberReviews = memberReviews.map((review) => String(review.id) === form.elements.id.value
      ? { ...review, rating: Number(form.elements.rating.value), content: form.elements.content.value.trim(), updatedAt: new Date().toISOString() }
      : review);
    try { localStorage.setItem(`tteokReviews:${reviewOwnerId}`, JSON.stringify(memberReviews)); } catch {}
    renderMyReviews(reviewOwnerId);
    reviewEditDialog.close();
    AppUI.toast("리뷰를 수정했습니다.", "success");
  });

  function renderOrders(orders) {
    const list = document.querySelector("[data-member-orders]");
    document.querySelector("[data-orders-empty]").hidden = orders.length > 0;
    const previewLimit = 3;
    const grouped = orders.reduce((acc, order) => {
      const key = getOrderDateKey(order.createdAt) || "기록 없음";
      if (!acc[key]) acc[key] = [];
      acc[key].push(order);
      return acc;
    }, {});
    const sortedKeys = Object.keys(grouped).sort().reverse();
    list.innerHTML = sortedKeys.map((key) => {
      const dateOrders = grouped[key];
      const visibleOrders = dateOrders.slice(0, previewLimit);
      const hiddenOrders = dateOrders.slice(previewLimit);
      const visibleHtml = visibleOrders.map((order) => {
        const status = getOrderStatusLabel(order);
        const meta = getStatusMeta(status);
        const displayItems = getDisplayItemObjects(order);
        const firstItem = displayItems[0] || order.items?.[0] || {};
        const listItems = displayItems.length ? displayItems : [{ ...firstItem, productName: "상품 정보 없음" }];
        const displayOrder = { ...order, items: listItems };
        const productCount = (displayItems.length ? displayItems : order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0) || 0;
        const hiddenItems = (displayItems.length ? displayItems : order.items || []).length > 1;
        const orderSummary = buildOrderProductSummary(displayOrder);
        return `<article class="member-order-card" data-order-id="${escape(order.id)}">
          <div class="member-order-meta-block">
            <div class="member-order-meta">
              <span>${escape(getEstimatedArrivalLabel(order))}</span>
              <div class="member-order-status-row"><b class="order-status ${meta.className}">${meta.icon} ${escape(meta.label)}</b></div>
            </div>
          </div>
          <div class="member-order-main">
            <div class="member-order-product-group">
              <img class="member-order-product-image" src="${escape(getOrderImageSrc(firstItem))}" alt="${escape(firstItem.productName || "상품")}">
              <div class="member-order-summary">
                <strong>${orderSummary}</strong>
                ${hiddenItems ? buildOrderItemList(displayOrder, false) : ""}
                <span>${productCount}개 · ${order.fulfillmentType === "delivery" ? "배송" : "픽업"}</span>
              </div>
            </div>
            <div class="member-order-right-bottom">
              <b>${won(order.totalAmount)}</b>
              <div class="member-order-actions">
                <button type="button" class="order-action-tab" data-order-detail-button>배송조회</button>
                <button type="button" class="order-action-tab" data-order-tracking-button>교환/반품 신청</button>
                <button type="button" class="order-action-tab ${canReviewOrder(order) ? "" : "is-disabled"}" ${canReviewOrder(order) ? "" : "disabled"} data-order-review-button>리뷰 작성하기</button>
                ${order.cancelable ? `<button class="order-action-tab is-danger" type="button" data-order-cancel-button>주문 취소</button>` : ""}
              </div>
              </div>
            </div>
          </article>`;
      }).join("");
      const hiddenHtml = hiddenOrders.map((order) => {
        const status = getOrderStatusLabel(order);
        const meta = getStatusMeta(status);
        const displayItems = getDisplayItemObjects(order);
        const firstItem = displayItems[0] || order.items?.[0] || {};
        const productCount = (displayItems.length ? displayItems : order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0) || 0;
        const hiddenItems = (displayItems.length ? displayItems : order.items || []).length > 1;
        const listItems = displayItems.length ? displayItems : [{ ...firstItem, productName: "상품 정보 없음" }];
        const displayOrder = { ...order, items: listItems };
        const orderSummary = buildOrderProductSummary(displayOrder);
        return `<article class="member-order-card member-order-card-hidden" data-order-id="${escape(order.id)}">
          <div class="member-order-meta-block">
            <div class="member-order-meta">
              <span>${escape(getEstimatedArrivalLabel(order))}</span>
              <div class="member-order-status-row"><b class="order-status ${meta.className}">${meta.icon} ${escape(meta.label)}</b></div>
            </div>
          </div>
          <div class="member-order-main">
            <div class="member-order-product-group">
              <img class="member-order-product-image" src="${escape(getOrderImageSrc(firstItem))}" alt="${escape(firstItem.productName || "상품")}">
              <div class="member-order-summary">
                <strong>${orderSummary}</strong>
                ${hiddenItems ? buildOrderItemList(displayOrder, false) : ""}
                <span>${productCount}개 · ${order.fulfillmentType === "delivery" ? "배송" : "픽업"}</span>
              </div>
            </div>
            <div class="member-order-right-bottom">
              <b>${won(order.totalAmount)}</b>
              <div class="member-order-actions">
                <button type="button" class="order-action-tab" data-order-detail-button>배송조회</button>
                <button type="button" class="order-action-tab" data-order-tracking-button>교환/반품 신청</button>
                <button type="button" class="order-action-tab ${canReviewOrder(order) ? "" : "is-disabled"}" ${canReviewOrder(order) ? "" : "disabled"} data-order-review-button>리뷰 작성하기</button>
                ${order.cancelable ? `<button class="order-action-tab is-danger" type="button" data-order-cancel-button>주문 취소</button>` : ""}
              </div>
            </div>
          </div>
        </article>`;
      }).join("");
      const showMoreButton = hiddenOrders.length ? `<button type="button" class="order-date-group-more" data-order-date-more="${escape(key)}" data-open="false" aria-expanded="false">+ ${hiddenOrders.length}건 더 보기</button>` : "";
      return `<section class="member-order-date-group" data-order-date-group="${escape(key)}">
        <h3 class="member-order-date-title">
          <span class="member-order-date-title-text">${escape(getOrderDateLabel(key))}</span>
          <span class="member-order-date-count-text">총 ${dateOrders.length}건</span>
        </h3>
        <div class="member-order-list-inner" data-order-date-list="${escape(key)}">
          ${visibleHtml}
          ${hiddenHtml}
        </div>
        ${showMoreButton}
      </section>`;
    }).join("");
  }

  async function loadOrders() {
    const body = await api("/me/orders");
    allOrders = body?.orders || [];
    try {
      renderOrderDateTabs();
      renderOrdersForSelectedDate();
    } catch (error) {
      console.error("마이페이지 주문 필터 초기화 실패:", error);
      activeOrderDateKey = "all";
      orderDatePage = 1;
      renderOrders(allOrders);
      renderOrderDatePagination(allOrders);
    }
  }

  const returnRequestDialog = document.querySelector("[data-return-request-dialog]");
  const returnRequestForm = document.querySelector("[data-return-request-form]");
  const returnItemList = document.querySelector("[data-return-item-list]");
  let activeReturnOrder = null;
  const reviewWriteDialog = document.querySelector("[data-review-write-dialog]");
  const reviewWriteForm = document.querySelector("[data-review-write-form]");
  const reviewWriteContent = reviewWriteForm?.elements.content;
  const reviewPhotoInput = document.querySelector("[data-review-photo-input]");
  const reviewPhotoPreview = document.querySelector("[data-review-photo-preview]");
  let activeReviewOrder = null;
  let pendingReviewPhotos = [];

  const renderReviewPhotoPreview = () => {
    if (!reviewPhotoPreview) return;
    reviewPhotoPreview.innerHTML = pendingReviewPhotos.map((photo, index) => `<div class="review-photo-item"><img src="${escape(photo)}" alt="첨부 사진 ${index + 1}" /><button type="button" data-review-photo-remove="${index}" aria-label="첨부 사진 ${index + 1} 삭제">×</button></div>`).join("");
  };

  const compressReviewPhoto = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("사진을 읽지 못했습니다."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("지원하지 않는 이미지입니다."));
      image.onload = () => {
        const maxSize = 960;
        const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/webp", 0.78));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  const openReturnRequestDialog = (order) => {
    if (!returnRequestDialog || !returnRequestForm || !order) return;
    activeReturnOrder = order;
    returnRequestForm.reset();
    document.querySelector("[data-return-request-message]").textContent = "";
    document.querySelector("[data-return-order-id]").textContent = order.orderNumber || order.id || "-";
    document.querySelector("[data-return-order-date]").textContent = date(order.createdAt);
    const items = getDisplayItemObjects(order);
    const safeItems = items.length ? items : (order.items || []);
    returnItemList.innerHTML = safeItems.map((item, index) => {
      const name = item.productName || item.name || order.productName || order.product || "주문 상품";
      const quantity = Number(item.quantity || 1);
      return `<label class="return-item-option"><input type="checkbox" name="returnItem" value="${index}" ${index === 0 ? "checked" : ""} /><strong>${escape(name)}</strong><span>${quantity}개</span></label>`;
    }).join("") || '<p class="return-request-message">신청 가능한 상품 정보를 찾지 못했습니다.</p>';
    returnRequestDialog.showModal();
  };

  const openReviewWriteDialog = (order) => {
    if (!reviewWriteDialog || !reviewWriteForm || !order) return;
    activeReviewOrder = order;
    reviewWriteForm.reset();
    document.querySelector("[data-review-write-message]").textContent = "";
    document.querySelector("[data-review-character-count]").textContent = "0";
    document.querySelector("[data-review-rating-label]").textContent = "별점을 선택해 주세요.";
    const items = getDisplayItemObjects(order);
    const product = items[0] || order.items?.[0] || {};
    const productName = product.productName || product.name || order.productName || order.product || "주문 상품";
    const imageUrl = product.imageUrl || product.image || order.imageUrl || "assets/logo.svg";
    document.querySelector("[data-review-product-name]").textContent = productName;
    document.querySelector("[data-review-product-image]").src = imageUrl;
    document.querySelector("[data-review-order-date]").textContent = `${date(order.createdAt)} 주문`;
    const existing = memberReviews.find((review) => review.orderId === order.id);
    pendingReviewPhotos = Array.isArray(existing?.photos) ? existing.photos.slice(0, 3) : [];
    if (reviewPhotoInput) reviewPhotoInput.value = "";
    renderReviewPhotoPreview();
    if (existing) {
      const ratingInput = reviewWriteForm.querySelector(`input[name="rating"][value="${Number(existing.rating || 5)}"]`);
      if (ratingInput) ratingInput.checked = true;
      reviewWriteForm.elements.content.value = existing.content || "";
      document.querySelector("[data-review-character-count]").textContent = String((existing.content || "").length);
      document.querySelector("[data-review-rating-label]").textContent = `${Number(existing.rating || 5)}점 · 작성한 리뷰를 수정합니다.`;
      (existing.keywords || []).forEach((keyword) => {
        const input = [...reviewWriteForm.querySelectorAll('input[name="keyword"]')].find((item) => item.value === keyword);
        if (input) input.checked = true;
      });
      reviewWriteForm.querySelector('[type="submit"]').textContent = "리뷰 수정하기";
    } else {
      reviewWriteForm.querySelector('[type="submit"]').textContent = "리뷰 등록하기";
    }
    reviewWriteDialog.showModal();
  };

  document.querySelector("[data-member-orders]").addEventListener("click", async (event) => {
    const card = event.target.closest("[data-order-id]"); if (!card) return;
    if (event.target.closest("[data-order-detail-button]")) {
      try {
        const { order } = await api(`/me/orders/${encodeURIComponent(card.dataset.orderId)}`);
        document.querySelector("[data-order-detail]").innerHTML = buildShippingTrackingDetail(order);
        document.querySelector("[data-order-dialog]").showModal();
      } catch (error) { AppUI.alert(error.message); }
    }
    if (event.target.closest("[data-order-tracking-button]")) {
      const order = allOrders.find((item) => item.id === card.dataset.orderId);
      openReturnRequestDialog(order);
    }
    if (event.target.closest("[data-order-review-button]")) {
      if (event.target.closest("button").disabled) return;
      const order = allOrders.find((item) => item.id === card.dataset.orderId);
      openReviewWriteDialog(order);
    }
    if (event.target.closest("[data-order-cancel-button]") && await AppUI.confirm("이 주문을 취소할까요? 취소 후에는 되돌릴 수 없습니다.")) {
      try { await api(`/me/orders/${encodeURIComponent(card.dataset.orderId)}/cancel`, { method: "POST" }); await loadOrders(); }
      catch (error) { AppUI.alert(error.message); }
    }
  });
  document.querySelector("[data-member-orders]").addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-order-items-toggle]");
    if (toggle) {
      const group = toggle.closest(".member-order-items-details");
      if (!group) return;
      const itemList = group.querySelector("[data-order-item-list]");
      const isOpen = group.classList.contains("is-open");
      group.classList.toggle("is-open");
      if (itemList) itemList.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(!isOpen));
      toggle.textContent = isOpen ? "주문한 상품 접기" : "주문한 상품 보기";
    }

    const moreButton = event.target.closest("[data-order-date-more]");
    if (moreButton) {
      const groupSection = moreButton.closest("[data-order-date-group]");
      const isExpanded = moreButton.dataset.open === "true";
      if (!groupSection) return;
      groupSection.querySelectorAll(".member-order-card-hidden").forEach((card) => {
        card.classList.toggle("is-shown", !isExpanded);
      });
      moreButton.dataset.open = String(!isExpanded);
      moreButton.setAttribute("aria-expanded", String(!isExpanded));
      const hiddenCount = groupSection.querySelectorAll(".member-order-card-hidden").length;
      moreButton.textContent = isExpanded ? `+ ${hiddenCount}건 더 보기` : "접기";
    }
  });
  orderDateFilter?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-order-date-tab]");
    if (!button) return;
    activeOrderDateKey = button.dataset.orderDateTab;
    orderDatePage = 1;
    setActiveOrderDateTab(activeOrderDateKey);
    renderOrdersForSelectedDate();
  });
  orderDatePagination?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-order-page]");
    if (!action) return;
    const direction = action.dataset.orderPage;
    const dateGroupKeys = getDateGroupKeys(allOrders);
    const totalPages = Math.max(1, Math.ceil(dateGroupKeys.length / ORDER_DATE_PAGE_SIZE));
    if (direction === "prev" && orderDatePage > 1) {
      orderDatePage -= 1;
      renderOrdersForSelectedDate();
      scrollToOrderTop();
      return;
    }
    if (direction === "next" && orderDatePage < totalPages) {
      orderDatePage += 1;
      renderOrdersForSelectedDate();
      scrollToOrderTop();
    }
  });
  document.querySelector("[data-dialog-close]").addEventListener("click", () => document.querySelector("[data-order-dialog]").close());

  document.querySelector("[data-profile-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    try { await api("/me/profile", { method: "PATCH", body: { name: form.name.value, phone: form.phone.value, marketingConsent: form.marketingConsent.checked } }); message("[data-profile-message]", "회원 정보가 저장되었습니다.", true); document.querySelector("[data-member-name]").textContent = form.name.value.trim(); }
    catch (error) { message("[data-profile-message]", error.message); }
  });
  addressSlotsContainer?.addEventListener("click", async (event) => {
    const addButton = event.target.closest("[data-address-slot-add]");
    const editButton = event.target.closest("[data-address-slot-edit]");
    const deleteButton = event.target.closest("[data-address-slot-delete]");
    const defaultButton = event.target.closest("[data-address-slot-default]");

    if (addButton) {
      const emptySlot = addressSlots.find((slot) => !isValidSlotData(slot));
      if (!emptySlot) return;
      selectedAddressSlotIndex = emptySlot.index;
      const form = document.querySelector("[data-address-form]");
      fillAddressForm(form, null);
      form.hidden = false;
      const title = form.querySelector("[data-address-form-title]");
      if (title) title.textContent = `배송지 ${addressSlots.filter((slot) => isValidSlotData(slot)).length + 1} 추가`;
      form.querySelector("input")?.focus();
      return;
    }

    if (!editButton && !deleteButton && !defaultButton) return;

    const button = editButton || deleteButton || defaultButton;
    const slotIndex = Number(button?.dataset.addressSlotIndex || NaN);
    const selectedSlot = getAddressSlot(slotIndex);
    if (!selectedSlot) return;

    if (defaultButton) {
      if (selectedSlot.isDefault) return;
      setDefaultAddressSlot(slotIndex);
      const defaultSlot = addressSlots.find((slot) => slot.isDefault) || selectedSlot;
      fillAddressForm(document.querySelector("[data-address-form]"), defaultSlot);
      selectedAddressSlotIndex = defaultSlot.index;
      renderAddressSlots(addressSlots, selectedAddressSlotIndex);
      try {
        await applyDefaultAddressSlotToServer(defaultSlot);
        message("[data-address-message]", "대표 배송지로 설정했습니다.", true);
      } catch (error) {
        message("[data-address-message]", error.message);
      }
      return;
    }

    if (editButton) {
      selectAddressSlot(slotIndex);
      const form = document.querySelector("[data-address-form]");
      form.hidden = false;
      const title = form.querySelector("[data-address-form-title]");
      const displayIndex = addressSlots.filter((slot) => isValidSlotData(slot) && slot.index <= slotIndex).length;
      if (title) title.textContent = `배송지 ${displayIndex} 수정`;
      form.querySelector("input")?.focus();
      return;
    }

    if (deleteButton) {
      if (!await AppUI.confirm("선택한 배송지를 삭제할까요?", {
        title: "배송지 삭제",
        tone: "danger",
        confirmText: "??젣",
        cancelText: "취소",
      })) return;

      const remain = addressSlots.filter((slot) => slot.index !== slotIndex);
      addressSlots = normalizeAddressSlots(remain);
      if (!addressSlots.some((slot) => slot.isDefault) && addressSlots.some((slot) => isValidSlotData(slot))) {
        addressSlots.find((slot) => isValidSlotData(slot)).isDefault = true;
      }
      if (!addressSlots.some((slot) => slot.isDefault)) {
        addressSlots[0].isDefault = true;
      }
      selectedAddressSlotIndex = (addressSlots.find((slot) => slot.isDefault) || addressSlots[0]).index;
      const defaultSlot = addressSlots.find((slot) => slot.isDefault) || addressSlots[0];
      fillAddressForm(document.querySelector("[data-address-form]"), defaultSlot);
      writeAddressSlots(currentUserId, addressSlots);
      renderAddressSlots(addressSlots, selectedAddressSlotIndex);
      if (isValidSlotData(defaultSlot)) {
        try { await applyDefaultAddressSlotToServer(defaultSlot); message("[data-address-message]", "선택한 배송지를 삭제했습니다.", true); }
        catch (error) { message("[data-address-message]", error.message); }
      } else {
        message("[data-address-message]", "선택한 배송지를 삭제했습니다.");
      }
    }
  });
  const closeReturnRequestDialog = () => {
    if (returnRequestDialog?.open) returnRequestDialog.close();
    activeReturnOrder = null;
  };
  returnRequestDialog?.addEventListener("close", () => { activeReturnOrder = null; });
  document.querySelector("[data-return-request-close]")?.addEventListener("click", closeReturnRequestDialog);
  document.querySelector("[data-return-request-cancel]")?.addEventListener("click", closeReturnRequestDialog);
  returnRequestForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const messageNode = document.querySelector("[data-return-request-message]");
    const selected = [...form.querySelectorAll('input[name="returnItem"]:checked')];
    if (!selected.length) {
      messageNode.textContent = "교환 또는 반품을 신청할 상품을 선택해 주세요.";
      return;
    }
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const orderItems = getDisplayItemObjects(activeReturnOrder);
    const request = {
      id: `return-${Date.now()}`,
      orderId: activeReturnOrder.id,
      requestType: form.elements.requestType.value,
      reason: form.elements.reason.value,
      details: form.elements.details.value.trim(),
      items: selected.map((input) => orderItems[Number(input.value)] || activeReturnOrder.items?.[Number(input.value)]).filter(Boolean),
      status: "접수",
      createdAt: new Date().toISOString(),
    };
    try {
      const key = `tteokReturnRequests:${currentUserId || "anonymous"}`;
      const previous = JSON.parse(localStorage.getItem(key) || "[]");
      localStorage.setItem(key, JSON.stringify([request, ...(Array.isArray(previous) ? previous : [])]));
    } catch {}
    closeReturnRequestDialog();
    AppUI.toast(`${request.requestType === "exchange" ? "교환" : "반품"} 신청이 접수되었습니다.`, "success");
  });
  const closeReviewWriteDialog = () => {
    if (reviewWriteDialog?.open) reviewWriteDialog.close();
    activeReviewOrder = null;
  };
  document.querySelector("[data-review-write-close]")?.addEventListener("click", closeReviewWriteDialog);
  document.querySelector("[data-review-write-cancel]")?.addEventListener("click", closeReviewWriteDialog);
  reviewWriteDialog?.addEventListener("close", () => { activeReviewOrder = null; });
  reviewWriteForm?.addEventListener("change", (event) => {
    if (event.target.name === "rating") document.querySelector("[data-review-rating-label]").textContent = `${event.target.value}점을 선택했습니다.`;
  });
  reviewWriteContent?.addEventListener("input", () => {
    document.querySelector("[data-review-character-count]").textContent = String(reviewWriteContent.value.length);
  });
  reviewPhotoInput?.addEventListener("change", async () => {
    const messageNode = document.querySelector("[data-review-write-message]");
    messageNode.textContent = "";
    const available = 3 - pendingReviewPhotos.length;
    const files = [...(reviewPhotoInput.files || [])].slice(0, Math.max(available, 0));
    if (!files.length) {
      if (available <= 0) messageNode.textContent = "사진은 최대 3장까지 첨부할 수 있습니다.";
      reviewPhotoInput.value = "";
      return;
    }
    for (const file of files) {
      if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
        messageNode.textContent = "사진은 JPG, PNG, WEBP 형식의 5MB 이하 파일만 첨부할 수 있습니다.";
        continue;
      }
      try {
        pendingReviewPhotos.push(await compressReviewPhoto(file));
      } catch (error) {
        messageNode.textContent = error.message;
      }
    }
    reviewPhotoInput.value = "";
    renderReviewPhotoPreview();
  });
  reviewPhotoPreview?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-review-photo-remove]");
    if (!button) return;
    pendingReviewPhotos.splice(Number(button.dataset.reviewPhotoRemove), 1);
    renderReviewPhotoPreview();
  });
  reviewWriteForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const messageNode = document.querySelector("[data-review-write-message]");
    if (!form.elements.rating.value) {
      messageNode.textContent = "상품에 대한 별점을 선택해 주세요.";
      return;
    }
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const items = getDisplayItemObjects(activeReviewOrder);
    const product = items[0] || activeReviewOrder.items?.[0] || {};
    const previous = memberReviews.find((review) => review.orderId === activeReviewOrder.id);
    const review = {
      id: previous?.id || `review-${activeReviewOrder.id}`,
      orderId: activeReviewOrder.id,
      productName: product.productName || product.name || activeReviewOrder.productName || activeReviewOrder.product || "주문 상품",
      imageUrl: product.imageUrl || product.image || activeReviewOrder.imageUrl || "",
      rating: Number(form.elements.rating.value),
      keywords: [...form.querySelectorAll('input[name="keyword"]:checked')].map((input) => input.value),
      photos: [...pendingReviewPhotos],
      content: form.elements.content.value.trim(),
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    memberReviews = previous
      ? memberReviews.map((item) => item.id === previous.id ? review : item)
      : [review, ...memberReviews];
    try { localStorage.setItem(`tteokReviews:${currentUserId || "anonymous"}`, JSON.stringify(memberReviews)); } catch {}
    renderMyReviews(currentUserId || "anonymous");
    closeReviewWriteDialog();
    AppUI.toast(previous ? "리뷰를 수정했습니다." : "리뷰를 등록했습니다.", "success");
  });
  document.querySelector("[data-address-form-cancel]")?.addEventListener("click", () => {
    const form = document.querySelector("[data-address-form]");
    form.hidden = true;
    form.reset();
    const defaultSlot = addressSlots.find((slot) => slot.isDefault);
    selectedAddressSlotIndex = defaultSlot?.index || 0;
    renderAddressSlots(addressSlots, selectedAddressSlotIndex);
  });
  document.querySelector("[data-address-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = getAddressPayloadFromForm(form);
    if (!body) return;
    if (!body.recipientName || !body.recipientPhone || !body.postalCode || !body.address) {
      return message("[data-address-message]", "수령인, 연락처, 우편번호와 주소는 필수입니다.");
    }

    const savedSlot = setAddressSlotData(selectedAddressSlotIndex || 1, body) || addressSlots[0];
    if (!savedSlot) return;
    if (!addressSlots.some((slot) => slot.isDefault)) addressSlots[0].isDefault = true;
    selectedAddressSlotIndex = savedSlot.index;
    writeAddressSlots(currentUserId, addressSlots);
    renderAddressSlots(addressSlots, selectedAddressSlotIndex);

    const defaultSlot = addressSlots.find((slot) => slot.isDefault) || savedSlot;
    const payload = {
      recipientName: defaultSlot.recipientName,
      recipientPhone: defaultSlot.recipientPhone,
      postalCode: defaultSlot.postalCode,
      address: defaultSlot.address,
      addressDetail: defaultSlot.addressDetail,
    };
    try {
      await api("/me/address", { method: "PATCH", body: payload });
      form.hidden = true;
      renderAddressSlots(addressSlots, selectedAddressSlotIndex);
      AppUI.toast("배송지를 저장했습니다.", "success");
    } catch (error) {
      message("[data-address-message]", error.message);
    }
  });
  document.querySelector("[data-password-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    if (form.newPassword.value !== form.confirmPassword.value) return message("[data-password-message]", "새 비밀번호가 일치하지 않습니다.");
    try { await api("/me/password", { method: "POST", body: { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value } }); form.reset(); message("[data-password-message]", "비밀번호가 변경되었습니다.", true); }
    catch (error) { message("[data-password-message]", error.message); }
  });
  document.querySelector("[data-withdraw-button]")?.addEventListener("click", async () => {
    const password = prompt("탈퇴하려면 현재 비밀번호를 입력해 주세요."); if (!password) return;
    if (!await AppUI.confirm("정말 회원 탈퇴하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) return;
    try { await api("/me", { method: "DELETE", body: { password } }); location.replace("index.html?withdrawn=1"); }
    catch (error) { AppUI.alert(error.message); }
  });

  Promise.all([api("/me"), api("/me/address"), api("/me/orders"), api("/me/social-identities"), inquiryApi("/mine")]).then(([me, addressBody, orderBody, socialBody, inquiryBody]) => {
    const user = me.user; const profile = document.querySelector("[data-profile-form]");
    document.querySelector("[data-member-name]").textContent = user.name;
    document.querySelector("[data-member-since]").textContent = date(user.createdAt);
    const adminLink = document.querySelector("[data-mypage-admin-link]");
    if (adminLink) {
      adminLink.hidden = user.role !== "admin";
      if (adminLink.hidden) fetch("/api/users/admin-session", { method: "POST", credentials: "same-origin" })
        .then((response) => { if (response.ok) adminLink.hidden = false; })
        .catch(() => {});
    }
    setFormValue(profile, "username", user.username || "");
    setFormValue(profile, "email", user.email || "");
    setFormValue(profile, "name", user.name || "");
    setFormValue(profile, "phone", user.phone || "");
    if (profile?.elements?.marketingConsent) profile.elements.marketingConsent.checked = Boolean(user.marketingConsent);
    const address = addressBody?.address || {};
    initializeAddressSlots(user.id, {
      recipientName: address?.recipientName || user.name || "",
      recipientPhone: address?.recipientPhone || user.phone || "",
      postalCode: address?.postalCode || "",
      address: address?.address || "",
      addressDetail: address?.addressDetail || "",
    });
    allOrders = orderBody.orders || [];
    renderMyReviews(user.id, user.username || "");
    renderOrderDateTabs();
    renderOrdersForSelectedDate();
    memberInquiries = inquiryBody.inquiries || [];
    renderInquiries(memberInquiries);
    if (location.hash.slice(1) === "inquiries") activateMyPageTab("inquiries", false);
    const labels = { kakao: "카카오", naver: "네이버", google: "Google" };
    const icons = {
      kakao: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 5C8.8 5 3 9.5 3 15c0 3.6 2.5 6.8 6.3 8.5l-1.2 4.2c-.1.4.4.7.7.5l5.1-3.4c.7.1 1.4.2 2.1.2 7.2 0 13-4.5 13-10S23.2 5 16 5Z"/></svg>',
      naver: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 7h6.4l5.2 7.6V7H25v18h-6.4l-5.2-7.6V25H7V7Z"/></svg>',
      google: '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#4285F4" d="M27.6 16.3c0-.9-.1-1.7-.2-2.5H16v4.7h6.5a5.6 5.6 0 0 1-2.4 3.6v3.1H24c2.3-2.1 3.6-5.2 3.6-8.9Z"/><path fill="#34A853" d="M16 28c3.2 0 5.9-1.1 7.9-2.8L20 22.1c-1.1.7-2.5 1.2-4 1.2-3.1 0-5.8-2.1-6.7-5H5.2v3.2A12 12 0 0 0 16 28Z"/><path fill="#FBBC05" d="M9.3 18.3A7.2 7.2 0 0 1 9 16c0-.8.1-1.6.4-2.3v-3.2H5.2A12 12 0 0 0 4 16c0 2 .5 3.9 1.3 5.5l4-3.2Z"/><path fill="#EA4335" d="M16 8.7c1.8 0 3.4.6 4.7 1.8L24.2 7A11.8 11.8 0 0 0 16 4 12 12 0 0 0 5.2 10.5l4.1 3.2c1-2.9 3.6-5 6.7-5Z"/></svg>',
    };
    document.querySelector("[data-social-identities]").innerHTML = socialBody.providers.map((item) => `<li class="is-${item.provider}"><b><i class="social-brand-icon">${icons[item.provider]}</i>${labels[item.provider]}</b><span class="${item.connected ? "is-connected" : ""}">${item.connected ? "연결됨" : "연결 안 됨"}</span></li>`).join("");
    document.querySelector("[data-mypage-loading]").hidden = true; document.querySelector("[data-mypage-shell]").hidden = false;
  }).catch((error) => { if (!String(error.message).includes("로그인")) document.querySelector("[data-mypage-loading]").textContent = error.message; });
})();
