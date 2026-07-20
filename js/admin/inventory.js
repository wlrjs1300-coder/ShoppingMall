function buildProductionItems(orders) {
  const selectedDate = adminProductionDateFilter?.value || "";
  const searchTerm = String(document.querySelector(".admin-production-search-input")?.value || "").trim().toLowerCase();
  const activeOrders = orders.filter((order) => {
    const isActive = !isTerminalStatus(order.status);
    const matchesDate = !selectedDate || order.pickupDate === selectedDate;
    const materials = formatProductionMaterials(order.product, order.quantity).toLowerCase();
    const matchesSearch = !searchTerm || `${order.product || ""} ${materials}`.toLowerCase().includes(searchTerm);
    return isActive && matchesDate && matchesSearch;
  });
  const grouped = new Map();

  activeOrders.forEach((order) => {
    const pickupDate = order.pickupDate || "날짜 미정";
    const productionLines = Array.isArray(order.items) && order.items.length
      ? order.items.map((item) => ({ product: item.productName || "상품 미정", quantity: Number(item.quantity || 0) }))
      : [{ product: order.product || "상품 미정", quantity: Number(order.quantity || 0) }];

    productionLines.forEach(({ product, quantity }) => {
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
      productionStatuses: new Set(),
      assignees: new Set(),
      packagingTypes: new Set(),
      requests: [],
      orders: [],
      };

      saved.quantity += quantity;
      saved.orderCount += 1;
      saved.orderIds.push(order.id);
      if (order.pickupTime) saved.times.add(order.pickupTime);
      if (order.status) saved.statuses.add(order.status);
      saved.productionStatuses.add(order.productionStatus || (order.status === "준비완료" ? "생산 완료" : "생산 대기"));
      if (order.productionAssignee) saved.assignees.add(order.productionAssignee);
      if (order.packagingType) saved.packagingTypes.add(order.packagingType);
      if (String(order.memo || "").trim()) saved.requests.push(String(order.memo).trim());
      saved.orders.push(order);
      grouped.set(key, saved);
    });
  });

  return [...grouped.values()].sort((a, b) => {
    if (a.pickupDate === "날짜 미정") return 1;
    if (b.pickupDate === "날짜 미정") return -1;
    return new Date(a.pickupDate) - new Date(b.pickupDate);
  });
}

function initAdminProductionCalendar() {
  const picker = document.querySelector("[data-production-date-picker]");
  const input = picker?.querySelector(".admin-production-date-filter");
  const trigger = picker?.querySelector("[data-production-date-trigger]");
  const label = picker?.querySelector("[data-production-date-label]");
  const calendar = picker?.querySelector("[data-production-calendar]");
  const title = picker?.querySelector("[data-production-calendar-title]");
  const days = picker?.querySelector("[data-production-calendar-days]");
  if (!picker || !input || !trigger || !label || !calendar || !title || !days || picker.dataset.ready === "true") return;

  picker.dataset.ready = "true";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const toDateKey = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const formatLabel = (value) => {
    const [year, month, day] = String(value).split("-").map(Number);
    return year && month && day ? `${year}. ${month}. ${day}.` : "전체 날짜";
  };
  const scheduledDates = () => new Set(
    readOrders()
      .filter((order) => !isTerminalStatus(order.status) && /^\d{4}-\d{2}-\d{2}$/.test(order.pickupDate || ""))
      .map((order) => order.pickupDate),
  );

  const render = () => {
    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();
    title.textContent = `${year}년 ${month + 1}월`;
    const firstGridDate = new Date(year, month, 1 - new Date(year, month, 1).getDay());
    const datesWithOrders = scheduledDates();
    days.innerHTML = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(firstGridDate);
      date.setDate(firstGridDate.getDate() + index);
      const key = toDateKey(date);
      const classes = ["admin-production-calendar-day"];
      if (date.getMonth() !== month) classes.push("is-outside");
      if (key === toDateKey(today)) classes.push("is-today");
      if (key === input.value) classes.push("is-selected");
      if (datesWithOrders.has(key)) classes.push("has-orders");
      if (date.getDay() === 0) classes.push("is-sunday");
      if (date.getDay() === 6) classes.push("is-saturday");
      return `<button class="${classes.join(" ")}" type="button" data-production-calendar-date="${key}" aria-label="${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일${datesWithOrders.has(key) ? ", 생산 일정 있음" : ""}"${key === input.value ? ' aria-current="date"' : ""}><span>${date.getDate()}</span>${datesWithOrders.has(key) ? '<i aria-hidden="true"></i>' : ""}</button>`;
    }).join("");
  };

  const close = () => {
    calendar.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    picker.classList.remove("is-open");
  };
  const open = () => {
    if (input.value) {
      const [year, month] = input.value.split("-").map(Number);
      visibleMonth = new Date(year, month - 1, 1);
    }
    render();
    calendar.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    picker.classList.add("is-open");
  };
  const select = (value) => {
    input.value = value;
    label.textContent = formatLabel(value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  };

  trigger.addEventListener("click", () => calendar.hidden ? open() : close());
  picker.querySelector("[data-production-calendar-prev]")?.addEventListener("click", () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
    render();
  });
  picker.querySelector("[data-production-calendar-next]")?.addEventListener("click", () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
    render();
  });
  days.addEventListener("click", (event) => {
    const button = event.target.closest("[data-production-calendar-date]");
    if (button) select(button.dataset.productionCalendarDate);
  });
  picker.querySelector("[data-production-calendar-clear]")?.addEventListener("click", () => select(""));
  picker.querySelector("[data-production-calendar-today]")?.addEventListener("click", () => select(toDateKey(today)));
  document.addEventListener("click", (event) => { if (!picker.contains(event.target)) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !calendar.hidden) close(); });
  label.textContent = formatLabel(input.value);
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

function getProductionDateMeta(dateValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue || "")) return { label: "일정 미정", tone: "undated" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateValue}T00:00:00`);
  const diff = Math.round((target - today) / 86400000);
  if (diff < 0) return { label: "일정 지남", tone: "overdue" };
  if (diff === 0) return { label: "오늘", tone: "today" };
  if (diff === 1) return { label: "내일", tone: "tomorrow" };
  return { label: `${diff}일 후`, tone: "upcoming" };
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

async function resetRecipes() {
  if (!await AppUI.confirm("원재료 배합 기준을 기본값으로 되돌릴까요?")) return;
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
  if (total) total.textContent = String(items.length);
  if (tabCount) tabCount.textContent = String(items.length);
  if (empty) {
    const hasFilter = Boolean(adminProductionDateFilter?.value || document.querySelector(".admin-production-search-input")?.value.trim());
    empty.querySelector(".admin-empty-title").textContent = hasFilter ? "조건에 맞는 생산 항목이 없습니다." : "생산 대기 주문이 없습니다.";
    empty.querySelector(".admin-empty-desc").textContent = hasFilter ? "수령일이나 검색어를 변경해 보세요." : "완료되지 않은 주문이 접수되면 생산 목록에 표시됩니다.";
    empty.hidden = items.length > 0;
  }

  productionList.innerHTML = items
    .map((item) => {
      const dateMeta = getProductionDateMeta(item.pickupDate);
      const timeList = [...item.times].sort();
      const productionStatuses = [...item.productionStatuses];
      const productionStatus = productionStatuses.every((status) => status === "생산 완료")
        ? "생산 완료"
        : productionStatuses.some((status) => status === "생산 중") ? "생산 중" : "생산 대기";
      const packaging = [...item.packagingTypes].join(", ") || "기본 포장";
      const requestSummary = item.requests.length ? item.requests[0] : "요청사항 없음";
      const materials = getProductionMaterials(item.product, item.quantity);
      const isSelected = item.orderIds.length > 0 && item.orderIds.every((id) => selectedAdminProductionOrderIds.has(id));
      return `
        <tr class="production-${dateMeta.tone}" data-production-order-ids="${item.orderIds.join(",")}" data-production-product="${escapeHtml(item.product)}">
          <td><input class="admin-production-select" type="checkbox" aria-label="${escapeHtml(item.product)} 생산 항목 선택" ${isSelected ? "checked" : ""} /></td>
          <td><span class="admin-production-urgency is-${dateMeta.tone}">${dateMeta.label}</span></td>
          <td><div class="admin-production-schedule"><strong>${escapeHtml(item.pickupDate)}</strong><small>${escapeHtml(timeList.join(", ") || "시간 미정")}</small></div></td>
          <td><div class="admin-production-product"><strong>${escapeHtml(item.product)}</strong><small>${item.orderCount}건 주문</small></div></td>
          <td><strong class="admin-production-quantity">${item.quantity}<small>개</small></strong></td>
          <td><div class="admin-production-materials">${materials.map((material) => `<span>${escapeHtml(material.name)} <b>${escapeHtml(formatMaterialAmount(material.amount))}${escapeHtml(material.unit)}</b></span>`).join("")}</div></td>
          <td><div class="admin-production-request"><strong>${escapeHtml(packaging)}</strong><span title="${escapeHtml(requestSummary)}${item.requests.length > 1 ? ` · 외 ${item.requests.length - 1}건` : ""}">${escapeHtml(requestSummary)}${item.requests.length > 1 ? ` <em>· 외 ${item.requests.length - 1}건</em>` : ""}</span></div></td>
          <td><select class="admin-production-status" aria-label="${escapeHtml(item.product)} 생산 상태">${["생산 대기", "생산 중", "생산 완료"].map((status) => `<option value="${status}" ${status === productionStatus ? "selected" : ""}>${status}</option>`).join("")}</select></td>
          <td><button class="admin-production-detail-open" type="button">상세 보기</button></td>
        </tr>
      `;
    })
    .join("");
  syncAdminProductionBulkUI(items);
}

function syncAdminProductionBulkUI(items = buildProductionItems(readOrders())) {
  const visibleIds = items.flatMap((item) => item.orderIds);
  const selectedVisibleIds = visibleIds.filter((id) => selectedAdminProductionOrderIds.has(id));
  const selectedGroups = items.filter((item) => item.orderIds.some((id) => selectedAdminProductionOrderIds.has(id)));
  const bar = document.querySelector("[data-production-bulk-bar]");
  const count = document.querySelector("[data-production-selected-count]");
  const selectAll = document.querySelector("[data-production-select-all]");
  if (bar) bar.hidden = selectedGroups.length === 0;
  if (count) count.textContent = String(selectedGroups.length);
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;
    selectAll.indeterminate = selectedVisibleIds.length > 0 && selectedVisibleIds.length < visibleIds.length;
  }
}

function getProductionItemByOrderIds(orderIds) {
  const idSet = new Set(orderIds);
  return buildProductionItems(readOrders()).find((item) => item.orderIds.some((id) => idSet.has(id)));
}

function openAdminProductionDetail(orderIds) {
  const dialog = document.querySelector("[data-admin-production-detail-dialog]");
  const content = document.querySelector("[data-admin-production-detail]");
  const item = getProductionItemByOrderIds(orderIds);
  if (!dialog || !content || !item) return;
  const materials = getProductionMaterials(item.product, item.quantity);
  const inventory = readInventory();
  const productionStatuses = [...item.productionStatuses];
  const status = productionStatuses.every((value) => value === "생산 완료") ? "생산 완료" : productionStatuses.some((value) => value === "생산 중") ? "생산 중" : "생산 대기";
  const packaging = [...item.packagingTypes].join(", ") || "기본 포장";
  content.innerHTML = `
    <header><div><span>PRODUCTION DETAIL</span><h2 id="admin-production-detail-title">생산 상세</h2><p>${escapeHtml(item.product)} · ${item.quantity}개</p></div><button type="button" data-production-detail-close aria-label="생산 상세 닫기">×</button></header>
    <div class="admin-production-detail-body">
      <section class="admin-production-detail-overview"><div><span>수령 일정</span><strong>${escapeHtml(item.pickupDate)} ${escapeHtml([...item.times].sort().join(", ") || "시간 미정")}</strong></div><div><span>연결 주문</span><strong>${item.orderCount}건</strong></div><div><span>생산 수량</span><strong>${item.quantity}개</strong></div></section>
      <section><h3>작업 관리</h3><div class="admin-production-detail-form"><label><span>포장 방식</span><select data-production-packaging>${["기본 포장", "개별 포장", "선물 포장", "보자기 포장"].map((value) => `<option ${value === packaging ? "selected" : ""}>${value}</option>`).join("")}</select></label><label><span>생산 상태</span><select data-production-detail-status>${["생산 대기", "생산 중", "생산 완료"].map((value) => `<option ${value === status ? "selected" : ""}>${value}</option>`).join("")}</select></label></div></section>
      <section><h3>고객 요청사항</h3><div class="admin-production-request-list">${item.orders.map((order) => `<article><strong>${escapeHtml(order.customer || "고객")} · ${escapeHtml(order.phone || "-")}</strong><span>${escapeHtml(order.memo || "별도 요청사항 없음")}</span><small>${escapeHtml(getFulfillmentLabel(order.fulfillmentType))}</small></article>`).join("")}</div></section>
      <section><h3>필요 원재료</h3><div class="admin-production-material-list">${materials.map((material) => { const stock = inventory.find((entry) => entry.name === material.name); const enough = stock && Number(stock.stock) >= Number(material.amount); return `<article class="${enough ? "is-enough" : "is-short"}"><div><strong>${escapeHtml(material.name)}</strong><span>필요 ${escapeHtml(formatMaterialAmount(material.amount))}${escapeHtml(material.unit)}</span></div><small>${stock ? `재고 ${escapeHtml(formatMaterialAmount(stock.stock))}${escapeHtml(stock.unit || material.unit)}` : "미등록 원재료"}</small><b>${enough ? "충분" : "확인 필요"}</b></article>`; }).join("")}</div></section>
    </div>
    <footer data-production-detail-order-ids="${item.orderIds.join(",")}"><button type="button" data-production-detail-close>닫기</button><button class="is-primary" type="button" data-production-detail-save>변경 저장</button></footer>`;
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeAdminProductionDetail() {
  const dialog = document.querySelector("[data-admin-production-detail-dialog]");
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
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

async function deleteAdminInventory(itemId) {
  if (!itemId) return;
  const items = readInventory();
  const target = items.find((item) => item.id === itemId);
  const activePurchases = readPurchaseOrders().filter(
    (order) => order.inventoryId === itemId && order.status !== "입고완료",
  );

  if (activePurchases.length) {
    if (!await AppUI.confirm(`${target?.name || "이 품목"}에 진행 중인 발주 ${activePurchases.length}건이 있습니다. 발주까지 함께 삭제할까요?`)) return;
    writePurchaseOrders(readPurchaseOrders().filter((order) => !(order.inventoryId === itemId && order.status !== "입고완료")));
  } else {
    if (!await AppUI.confirm(`${target?.name || "재고 품목"}을 삭제할까요?`)) return;
  }

  writeInventory(items.filter((item) => item.id !== itemId));
  addActivityLog("재고", `${target?.name || "재고 품목"}을 삭제했습니다.`, "inventory");
  resetAdminInventoryForm();
  renderAdminDashboard();
  setAdminFeedback(`재고 품목을 삭제했습니다.${activePurchases.length ? ` 연관 발주 ${activePurchases.length}건도 함께 삭제했습니다.` : ""}`);
}

async function createSampleInventory() {
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
  if (existing.length && !await AppUI.confirm(`기본 재고 품목 ${samples.length}개를 추가할까요? 기존 재고는 유지됩니다.`)) return;

  writeInventory([...samples, ...existing]);
  addActivityLog("재고", `기본 원재료 재고 ${samples.length}개를 추가했습니다.`, "inventory");
  renderAdminDashboard();
  setAdminFeedback(`기본 재고 품목 ${samples.length}개를 추가했습니다.`);
}

function renderAdminInventory() {
  const inventoryList = document.querySelector(".admin-inventory-list");
  if (!inventoryList) return;

  const purchaseOrders = readPurchaseOrders();
  const purchaseForItem = (itemId) => purchaseOrders.find((order) => order.inventoryId === itemId && order.status !== "입고완료")
    || purchaseOrders.find((order) => order.inventoryId === itemId);
  const allItems = readInventory().sort((a, b) => {
    const aPurchase = purchaseForItem(a.id);
    const bPurchase = purchaseForItem(b.id);
    const aOnHold = Boolean(a.purchaseOnHold || aPurchase?.status === "보류");
    const bOnHold = Boolean(b.purchaseOnHold || bPurchase?.status === "보류");
    if (aOnHold !== bOnHold) return Number(aOnHold) - Number(bOnHold);
    const statusOrder = { 부족: 0, 주의: 1, 정상: 2 };
    const statusDiff = statusOrder[getInventoryStatus(a)] - statusOrder[getInventoryStatus(b)];
    if (statusDiff) return statusDiff;
    return String(a.name).localeCompare(String(b.name), "ko-KR");
  });
  const statusFilter = document.querySelector(".admin-inventory-status-filter")?.value || "all";
  const searchTerm = String(document.querySelector(".admin-inventory-search-input")?.value || "").trim().toLowerCase();
  const items = allItems.filter((item) => {
    const matchesStatus = statusFilter === "all" || getInventoryStatus(item) === statusFilter;
    const matchesSearch = !searchTerm || `${item.name || ""} ${item.memo || ""} ${item.unit || ""}`.toLowerCase().includes(searchTerm);
    return matchesStatus && matchesSearch;
  });
  const empty = document.querySelector(".admin-inventory-empty");
  const total = document.querySelector("[data-admin-inventory-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="inventory"]');
  const warningCount = allItems.filter((item) => getInventoryStatus(item) === "주의").length;
  const dangerCount = allItems.filter((item) => getInventoryStatus(item) === "부족").length;

  if (total) total.textContent = String(items.length);
  if (tabCount) tabCount.textContent = String(dangerCount + warningCount);
  if (empty) {
    const hasFilter = statusFilter !== "all" || Boolean(searchTerm);
    empty.querySelector(".admin-empty-title").textContent = hasFilter ? "조건에 맞는 재고가 없습니다." : "등록된 재고가 없습니다.";
    empty.querySelector(".admin-empty-desc").textContent = hasFilter ? "상태나 검색어를 변경해 다시 확인해 주세요." : "기본 재고를 추가하거나 직접 품목을 등록해 주세요.";
    empty.hidden = items.length > 0;
  }

  inventoryList.innerHTML = items
    .map((item) => {
      const status = getInventoryStatus(item);
      const purchase = purchaseForItem(item.id);
      const normalizedPurchaseStatus = ["발주요청", "발주중"].includes(purchase?.status) ? "발주완료" : purchase?.status;
      const isOnHold = Boolean(item.purchaseOnHold || normalizedPurchaseStatus === "보류");
      const recommended = getRecommendedPurchaseQuantity(item);
      const purchaseAmount = Number(purchase?.amount || recommended || 0);
      const purchaseState = normalizedPurchaseStatus || (isOnHold ? "보류" : "발주 전");
      return `
        <tr class="${isOnHold ? "is-on-hold" : ""}" data-inventory-id="${item.id}" data-inventory-status="${status}" data-purchase-order-id="${escapeHtml(purchase?.id || "")}" data-purchase-amount="${purchaseAmount}">
          <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.memo || "-")}</span></td>
          <td><strong>${item.stock}</strong> ${escapeHtml(item.unit)}</td>
          <td>${item.safeStock} ${escapeHtml(item.unit)}</td>
          <td><span class="admin-status-pill is-${status === "부족" ? "danger" : status === "주의" ? "warning" : "normal"}">${status}</span></td>
          <td>${purchaseAmount > 0 ? `${formatMaterialAmount(purchaseAmount)} ${escapeHtml(item.unit)}` : "-"}</td>
          <td>${purchase && !["보류", "입고완료"].includes(normalizedPurchaseStatus)
            ? `<select class="admin-purchase-status" aria-label="${escapeHtml(item.name)} 발주 상태"><option value="발주완료" selected>발주 완료</option><option value="입고완료">입고 완료</option></select>`
            : `<span class="admin-purchase-state-pill${isOnHold ? " is-hold" : normalizedPurchaseStatus === "입고완료" ? " is-complete" : ""}">${escapeHtml(purchaseState)}</span>`}</td>
          <td><span class="admin-memo">${escapeHtml(item.memo || "-")}</span></td>
          <td><div class="admin-purchase-row-actions"><button class="admin-purchase-request" type="button">발주하기</button><button class="admin-purchase-edit admin-inventory-edit" type="button">수정</button><button class="admin-purchase-hold admin-inventory-purchase-hold" type="button">보류</button><button class="admin-purchase-delete admin-inventory-delete" type="button">삭제</button></div></td>
        </tr>
      `;
    })
    .join("");

  renderPurchaseCandidates(allItems);
}

function renderPurchaseCandidates(items = readInventory()) {
  const purchaseList = document.querySelector(".admin-purchase-list");
  if (!purchaseList) return;

  const activePurchaseIds = new Set(readPurchaseOrders().filter((order) => order.status !== "입고완료").map((order) => order.inventoryId));
  const candidates = items
    .filter((item) => getInventoryStatus(item) !== "정상" && getRecommendedPurchaseQuantity(item) > 0 && !activePurchaseIds.has(item.id))
    .sort((a, b) => Number(Boolean(a.purchaseOnHold)) - Number(Boolean(b.purchaseOnHold)));
  const actionableCandidates = candidates.filter((item) => !item.purchaseOnHold);
  const empty = document.querySelector(".admin-purchase-empty");
  const total = document.querySelector("[data-purchase-candidate-total]");
  if (empty) empty.hidden = candidates.length > 0 || readPurchaseOrders().length > 0;
  if (total) total.textContent = String(actionableCandidates.length);

  purchaseList.innerHTML = candidates
    .map((item) => {
      const recommended = getRecommendedPurchaseQuantity(item);
      return `
        <tr class="admin-purchase-needed-row${item.purchaseOnHold ? " is-on-hold" : ""}" data-purchase-id="${escapeHtml(item.id)}" data-purchase-amount="${recommended}">
          <td><strong>${escapeHtml(item.name)}</strong><small class="admin-purchase-date">${item.purchaseOnHold ? "시즌 재고 · 발주 보류" : "발주 전"}</small></td>
          <td>${formatMaterialAmount(item.stock)}${escapeHtml(item.unit)}</td>
          <td>${formatMaterialAmount(recommended)}${escapeHtml(item.unit)}</td>
          <td><strong>금액 미정</strong><small class="admin-purchase-date">단가 미입력</small></td>
          <td><span class="admin-purchase-state-pill${item.purchaseOnHold ? " is-hold" : ""}">${item.purchaseOnHold ? "보류" : "발주 전"}</span></td>
          <td><div class="admin-purchase-row-actions"><button class="admin-purchase-request" type="button">발주하기</button><button class="admin-purchase-edit admin-purchase-candidate-edit" type="button">수정</button><button class="admin-purchase-hold admin-purchase-candidate-hold" type="button">보류</button><button class="admin-purchase-delete admin-purchase-candidate-delete" type="button">삭제</button></div></td>
        </tr>
      `;
    })
    .join("");
}

function togglePurchaseCandidateHold(itemId) {
  const items = readInventory();
  const target = items.find((item) => item.id === itemId);
  if (!target) return;
  const nextHold = !target.purchaseOnHold;
  writeInventory(items.map((item) => item.id === itemId
    ? { ...item, purchaseOnHold: nextHold, updatedAt: new Date().toISOString() }
    : item));
  addActivityLog("발주", `${target.name} 발주 보류를 ${nextHold ? "설정" : "해제"}했습니다.`, "inventory");
  renderAdminDashboard();
  setAdminFeedback(`${target.name} 품목을 ${nextHold ? "보류 목록 최하단으로 이동했습니다" : "발주 대상으로 복귀했습니다"}.`);
}
