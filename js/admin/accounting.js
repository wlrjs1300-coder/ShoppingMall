function getFilteredLogisticsOrders(orders) {
  const selectedDate = adminLogisticsDateFilter?.value || "";
  const keyword = String(adminLogisticsSearchInput?.value || "").trim().toLowerCase();
  return orders
    .filter((order) => {
      const isComplete = order.logisticsStatus === "완료" || isTerminalStatus(order.status);
      const matchesDate = !selectedDate || order.pickupDate === selectedDate;
      const searchable = [order.customer, order.phone, order.product, order.deliveryAddress, order.memo]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return matchesDate && (!keyword || searchable.includes(keyword)) && !isComplete;
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
      const date = order.pickupDate || "날짜 미정";
      const time = order.pickupTime || "시간 미정";
      const type = order.fulfillmentType || "pickup";
      const address = order.deliveryAddress || order.memo || "-";
      const currentStatus = order.logisticsStatus || getDefaultLogisticsStatus(type);
      const statusOptions = type === "delivery" ? ["배송대기", "이동중", "완료"] : ["픽업대기", "이동중", "완료"];
      const statusLabels = type === "delivery"
        ? { 배송대기: "대기", 이동중: "배송중", 완료: "완료" }
        : { 픽업대기: "대기", 이동중: "준비중", 완료: "완료" };
      const mapLink = type === "delivery" && order.deliveryAddress
        ? ` <a class="admin-map-link" href="https://map.naver.com/p/search/${encodeURIComponent(order.deliveryAddress)}" target="_blank" rel="noopener noreferrer">지도</a>`
        : "";
      const fulfillmentIcon = type === "delivery"
        ? `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>`
        : `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 9h14l-1 11H6L5 9Z"/><path d="M9 9V7a3 3 0 0 1 6 0v2"/><path d="M8 13h8"/></svg>`;
      return `
        <tr data-order-id="${escapeHtml(order.id)}">
          <td><strong>${escapeHtml(date)}</strong></td>
          <td><strong>${escapeHtml(time)}</strong></td>
          <td><strong>${escapeHtml(order.customer || "-")}</strong></td>
          <td><span>${escapeHtml(order.phone || "-")}</span></td>
          <td><strong>${escapeHtml(order.product || "-")}</strong></td>
          <td><strong>${order.quantity || 1}개</strong></td>
          <td><span class="admin-fulfillment-badge is-${type === "delivery" ? "delivery" : "pickup"}">${fulfillmentIcon}<span>${getFulfillmentLabel(type)}</span></span></td>
          <td><span class="admin-memo">${escapeHtml(address)}</span>${mapLink}</td>
          <td>
            <div class="admin-logistics-status-actions" role="group" aria-label="${escapeHtml(order.customer || "주문")} 진행 상태">
              ${statusOptions.map((status) => `<button type="button" class="admin-logistics-status-button${currentStatus === status ? " is-active" : ""}" data-logistics-status="${status}" aria-pressed="${currentStatus === status}" title="${status}">${statusLabels[status]}</button>`).join("")}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function getAccountingNetRevenue(order) {
  return Math.max(0, Number(order.revenue || 0) - Number(order.refundAmount || order.canceledAmount || 0));
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
    saved.revenue += getAccountingNetRevenue(order);
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
    const isPaid = ["결제완료", "부분환불"].includes(order.paymentStatus);
    const isCancelled = ["취소", "주문취소"].includes(order.status) || order.workflowStatus === "취소" || ["결제취소", "환불완료"].includes(order.paymentStatus);
    return afterStart && beforeEnd && isPaid && !isCancelled;
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
    saved.revenue += getAccountingNetRevenue(order);
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
    saved.revenue += getAccountingNetRevenue(order);
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
  const expenses = sorted.map((item) => item.purchaseCost);

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
          backgroundColor: "rgba(226, 78, 111, 0.72)",
          borderColor: "rgba(210, 61, 94, 1)",
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: "입고 발주비",
          data: expenses,
          backgroundColor: "rgba(221, 158, 61, 0.68)",
          borderColor: "rgba(190, 126, 32, 1)",
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: "예상 이익",
          data: profits,
          backgroundColor: "rgba(58, 145, 111, 0.68)",
          borderColor: "rgba(43, 121, 89, 1)",
          borderWidth: 1,
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 7, boxHeight: 7, padding: 14 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString("ko-KR")}원`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: "rgba(224, 205, 210, .38)", drawBorder: false },
          ticks: {
            callback: (value) => `${Number(value).toLocaleString("ko-KR")}원`,
          },
        },
        x: { grid: { display: false } },
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
  const totalRevenue = items.reduce((sum, item) => sum + item.revenue, 0);
  const totalCost = items.reduce((sum, item) => sum + item.cost, 0);
  const totalProfit = totalRevenue - totalCost;
  const totalPurchaseCost = purchaseItems.reduce((sum, item) => sum + item.cost, 0);
  const cashFlow = totalRevenue - totalPurchaseCost;
  const totalMargin = totalRevenue ? Math.round((totalProfit / totalRevenue) * 100) : 0;
  const averageOrderValue = filteredOrders.length ? Math.round(totalRevenue / filteredOrders.length) : 0;
  const summaryCards = [...document.querySelectorAll(".admin-stats article")];
  const accountingSummary = [
    ["매출 합계", formatWon(totalRevenue), "선택 기간 주문 매출"],
    ["주문 건수", `${filteredOrders.length}건`, `평균 주문액 ${formatWon(averageOrderValue)}`],
    ["예상 이익", formatWon(totalProfit), "매출에서 원가 제외"],
    ["이익률", `${totalMargin}%`, "매출 대비 예상 이익"],
  ];
  summaryCards.forEach((card, index) => {
    const [label, value, meta] = accountingSummary[index];
    const labelNode = card.querySelector("[data-admin-stat-label]");
    const valueNode = card.querySelector("strong");
    const metaNode = card.querySelector("[data-admin-stat-meta]");
    if (labelNode) labelNode.textContent = label;
    if (valueNode) valueNode.textContent = value;
    if (metaNode) metaNode.textContent = meta;
    card.dataset.summaryTab = "accounting";
  });

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
            <td><span class="admin-status-pill">발주비</span></td>
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
            <td>${formatWon(item.orderCount ? Math.round(item.revenue / item.orderCount) : 0)}</td>
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

function renderAdminAuditLogs() {
  const list = document.querySelector(".admin-log-list");
  if (!list) return;
  const query = (document.querySelector("[data-admin-log-search]")?.value || "").trim().toLowerCase();
  const logs = readActivityLogs().filter((log) => {
    const haystack = [log.entityId, log.message, log.category, log.previousValue, log.nextValue, log.actor].join(" ").toLowerCase();
    return !query || haystack.includes(query);
  });
  const tabCount = document.querySelector('[data-admin-tab-count="logs"]');
  const visibleTotal = document.querySelector("[data-admin-log-visible-total]");
  const empty = document.querySelector(".admin-log-empty");
  if (tabCount) tabCount.textContent = String(readActivityLogs().length);
  if (visibleTotal) visibleTotal.textContent = String(logs.length);
  if (empty) empty.hidden = logs.length > 0;
  list.innerHTML = logs.map((log) => `
    <tr>
      <td><div class="admin-log-time"><strong>${new Date(log.createdAt).toLocaleDateString("ko-KR")}</strong><span>${new Date(log.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div></td>
      <td><span class="admin-log-category">${escapeHtml(log.category || "관리")}</span></td>
      <td><strong>${escapeHtml(log.entityId ? getAdminOrderNumber({ id: log.entityId }) : "-")}</strong></td>
      <td><div class="admin-log-change" title="${escapeHtml(log.previousValue ?? "-")}">${escapeHtml(log.previousValue ?? "-")}</div></td>
      <td><div class="admin-log-change" title="${escapeHtml(log.nextValue ?? "-")}"><strong>${escapeHtml(log.nextValue ?? "-")}</strong></div></td>
      <td>${escapeHtml(log.actor || "관리자")}</td>
      <td>${escapeHtml(log.message || "-")}</td>
    </tr>`).join("");
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
  const pendingPayments = orders.filter((order) => order.paymentStatus === "결제대기" && !["취소", "주문취소"].includes(order.status));

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
  setAdminAlert("payments", pendingPayments.length, pendingPayments.length ? `${pendingPayments[0].customer || "고객"} · ${pendingPayments[0].product || "상품"}` : "미결제 주문이 없습니다.");
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
  renderAdminAuditLogs();
  if (typeof renderAdminInquiries === "function") renderAdminInquiries();
  applyAdminTableLabels();
  reapplyAdminTableSorting();
  const activeTab = document.querySelector("[data-admin-tab].is-active")?.dataset.adminTab || "orders";
  updateAdminSummaryCards(activeTab);
}

function updateAdminSummaryCards(tabName) {
  const orders = readOrders();
  const activeOrders = orders.filter((order) => !["취소", "주문취소"].includes(order.status) && order.paymentStatus !== "결제취소");
  const confirmedOrders = activeOrders.filter((order) => order.amountStatus !== "pending");
  const costedOrders = confirmedOrders.filter((order) => Number(order.cost || 0) > 0);
  const totalQuantity = activeOrders.reduce((sum, order) => sum + Number(order.quantity || 0), 0);
  const totalRevenue = confirmedOrders.reduce((sum, order) => sum + Number(order.revenue || 0), 0);
  const totalCost = confirmedOrders.reduce((sum, order) => sum + Number(order.cost || 0), 0);
  const profit = totalRevenue - totalCost;
  const costedRevenue = costedOrders.reduce((sum, order) => sum + Number(order.revenue || 0), 0);
  const costedProfit = costedOrders.reduce((sum, order) => sum + Number(order.revenue || 0) - Number(order.cost || 0), 0);
  const marginRate = costedRevenue > 0 ? Math.round((costedProfit / costedRevenue) * 100) : 0;
  const customers = buildAdminCustomers(orders);
  const productionItems = buildProductionItems(orders);
  const inventory = readInventory();
  const purchases = readPurchaseOrders();
  const today = new Date().toISOString().slice(0, 10);
  const lowInventory = inventory.filter((item) => Number(item.stock || 0) < Number(item.safeStock || 0));
  const activePurchases = purchases.filter((order) => !String(order.status || "").includes("완료"));
  const activePurchaseInventoryIds = new Set(activePurchases.map((order) => order.inventoryId));
  const purchaseCandidates = inventory.filter((item) =>
    getInventoryStatus(item) !== "정상"
    && getRecommendedPurchaseQuantity(item) > 0
    && !activePurchaseInventoryIds.has(item.id),
  );
  const pickupOrders = orders.filter((order) => (order.fulfillmentType || "pickup") === "pickup");
  const deliveryOrders = orders.filter((order) => order.fulfillmentType === "delivery");
  const pendingLogistics = orders.filter((order) => !String(order.logisticsStatus || order.status || "").includes("완료"));
  const todayQuantity = productionItems
    .filter((item) => item.pickupDate === today)
    .reduce((sum, item) => sum + Number(item.quantity || 0), 0);

  const summaries = {
    orders: [
      ["처리 대상 주문", String(activeOrders.length), "취소 주문 제외"],
      ["생산 수량", String(totalQuantity), "전체 주문 수량"],
      ["매출 집계", formatWon(totalRevenue), "주문 매출 합계"],
      ["평균 이익률", `${marginRate}%`, "원가 입력 주문 기준"],
    ],
    inquiries: [
      ["전체 문의", String(window.adminInquirySummary?.total || 0), "메뉴에서 접수된 문의"],
      ["답변 대기", String(window.adminInquirySummary?.received || 0), "답변이 필요한 문의"],
      ["답변 완료", String(window.adminInquirySummary?.answered || 0), "처리가 끝난 문의"],
      ["답변 완료율", `${window.adminInquirySummary?.total ? Math.round((window.adminInquirySummary.answered / window.adminInquirySummary.total) * 100) : 0}%`, "전체 문의 기준"],
    ],
    customers: [
      ["전체 고객", String(customers.length), "주문·직접 등록 포함"],
      ["직접 등록 고객", String(readCustomers().length), "관리자가 등록한 고객"],
      ["재주문 고객", String(customers.filter((customer) => customer.orderCount >= 2).length), "2회 이상 주문 고객"],
      ["고객 매출", formatWon(customers.reduce((sum, customer) => sum + Number(customer.revenue || 0), 0)), "전체 고객 누적 매출"],
    ],
    production: [
      ["생산 품목", String(productionItems.length), "현재 생산 대상 품목"],
      ["총 생산 수량", String(productionItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0)), "생산 예정 총수량"],
      ["연결 주문", String(productionItems.reduce((sum, item) => sum + Number(item.orderCount || 0), 0)), "생산표에 연결된 주문"],
      ["오늘 생산", String(todayQuantity), "오늘 픽업 예정 수량"],
    ],
    inventory: [
      ["재고 품목", String(inventory.length), "등록된 원재료·포장재"],
      ["부족 재고", String(lowInventory.length), "안전 재고 미만 품목"],
      ["발주 후보", String(purchaseCandidates.length), "발주가 필요한 품목"],
      ["진행 중 발주", String(activePurchases.length), "입고 완료 전 발주"],
    ],
    logistics: [
      ["전체 일정", String(orders.length), "픽업·배송 전체 주문"],
      ["매장 픽업", String(pickupOrders.length), "매장 수령 예정"],
      ["배송 상담", String(deliveryOrders.length), "배송 방식 주문"],
      ["처리 대기", String(pendingLogistics.length), "완료 전 물류 일정"],
    ],
    accounting: [
      ["매출 합계", formatWon(totalRevenue), "전체 주문 매출"],
      ["원가 합계", formatWon(totalCost), "입력된 주문 원가"],
      ["예상 이익", formatWon(profit), "매출에서 원가 제외"],
      ["이익률", `${marginRate}%`, "원가 입력 주문 기준"],
    ],
    logs: [
      ["전체 로그", String(readActivityLogs().length), "최근 운영 변경 기록"],
      ["상태 변경", String(readActivityLogs().filter((log) => log.action === "status_change").length), "주문 상태 변경 기록"],
      ["오늘 변경", String(readActivityLogs().filter((log) => String(log.createdAt || "").slice(0, 10) === today).length), "오늘 기록된 작업"],
      ["처리 관리자", String(new Set(readActivityLogs().map((log) => log.actor || "관리자")).size), "로그에 기록된 처리자"],
    ],
  };

  const cards = [...document.querySelectorAll(".admin-stats article")];
  (summaries[tabName] || summaries.orders).forEach(([label, value, meta], index) => {
    const card = cards[index];
    if (!card) return;
    const labelElement = card.querySelector("[data-admin-stat-label]");
    const valueElement = card.querySelector("strong");
    const metaElement = card.querySelector("[data-admin-stat-meta]");
    if (labelElement) labelElement.textContent = label;
    if (valueElement) valueElement.textContent = value;
    if (metaElement) metaElement.textContent = meta;
    card.dataset.summaryTab = tabName;
  });
}

function setAdminTab(tabName) {
  if (tabName === "logistics") tabName = "orders";
  const panels = {
    orders: document.querySelector(".admin-order-panel"),
    inquiries: document.querySelector(".admin-inquiry-panel"),
    customers: document.querySelector(".admin-customer-panel"),
    production: document.querySelector(".admin-production-panel"),
    inventory: document.querySelector(".admin-inventory-panel"),
    accounting: document.querySelector(".admin-accounting-panel"),
    logs: document.querySelector(".admin-log-panel"),
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

  updateAdminSummaryCards(tabName);
  if (tabName === "inquiries" && typeof loadAdminInquiries === "function") loadAdminInquiries();
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

  if (groupName === "inventory") {
    const viewSelect = document.querySelector(".admin-inventory-view-select");
    if (viewSelect) viewSelect.value = tabName;
    document.querySelectorAll("[data-inventory-tab-actions]").forEach((actions) => {
      actions.hidden = actions.dataset.inventoryTabActions !== tabName;
    });
  }

  if (groupName === "accounting" && tabName === "overview") requestAccountingChartResize();
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
  renderAdminDashboard();
  setAdminFeedback("주문 정보가 저장되었습니다.");
}

// 포트폴리오 화면 캡처용 데모 데이터입니다. 아래 이름·연락처·주소·매출·재고 수치는
// 모두 가상값이며 실제 고객·매장·거래 정보가 아닙니다. admin.html?dev=1에서만 노출되는
// "데모 생성" 버튼으로만 실행되며, 이미 생성된 경우 중복 삽입되지 않도록 id 접두사로 확인합니다.
const DEMO_SEED_ID_PREFIX = "demo-seed";

async function createDemoOrders() {
  if (readOrders().some((order) => String(order.id).startsWith(DEMO_SEED_ID_PREFIX))) {
    AppUI.alert("포트폴리오용 데모 데이터가 이미 생성되어 있습니다. 다시 만들려면 먼저 운영 데이터를 초기화해 주세요.");
    return;
  }
  if (!await AppUI.confirm("포트폴리오 캡처용 주문·재고·발주 데모 데이터를 대량으로 추가할까요? 기존 데이터는 유지됩니다.")) return;

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
      paymentStatus: isCancelled ? "결제취소" : (["접수대기", "준비중"].includes(status) ? "결제대기" : "결제완료"),
      amountStatus: "confirmed",
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
    "접수대기", "준비중", "준비중", "준비완료", "배송중", "TERMINAL", "취소",
    "접수대기", "준비중", "준비중", "준비완료", "배송중", "TERMINAL", "취소",
    "접수대기",
  ];
  [6, 6, 5, 4, 3, 2, 1, 1, 0, 0, 9, 8, 10, 11, 12].forEach((daysAgo) => pushOrder(daysAgo, currentStatusPool));

  // 지난달 이전은 완료 이력 비중이 높지만, 7개 상태가 한쪽으로 치우치지 않도록
  // 완료(TERMINAL) 외 6개 상태도 고르게 섞어 배치합니다. 명절(추석·설) 전후 달은
  // 주문 건수를 소폭 늘려 매출관리 12개월 차트가 성수기 흐름과 함께 채워지도록 구성합니다.
  const historyStatusPool = [
    "TERMINAL", "접수대기", "TERMINAL", "준비완료", "TERMINAL", "준비중",
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

async function exportAdminOrdersCsv() {
  const orders = getFilteredAdminOrders();
  if (!orders.length) {
    setAdminFeedback("CSV로 저장할 주문이 없습니다.");
    return;
  }
  if (!await AppUI.confirm(`현재 검색 결과 ${orders.length}건을 CSV로 저장할까요? 파일에는 고객명·연락처·배송지가 포함되므로 안전하게 관리해 주세요.`)) return;

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
  setAdminFeedback(`현재 검색 결과 ${orders.length}건을 CSV로 저장했습니다.`);
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

  reader.addEventListener("load", async () => {
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
        AppUI.alert("불러올 수 있는 주문 백업 파일이 아닙니다.");
        return;
      }

      if (!await AppUI.confirm(`주문 ${orders.length}건을 불러오고 현재 데이터를 교체할까요?`)) return;
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
      AppUI.alert("백업 파일을 읽지 못했습니다. JSON 파일인지 확인해 주세요.");
    } finally {
      if (adminImportInput) adminImportInput.value = "";
    }
  });

  reader.readAsText(file);
}
