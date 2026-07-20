function readOrders() {
  try {
    const raw = JSON.parse(localStorage.getItem(orderStorageKey) || "[]");
    let repaired = false;
    const orders = raw.map((source) => {
      const order = { ...source };
      if (order.status === "결제완료") {
        order.status = "접수대기";
        order.paymentStatus = "결제완료";
        repaired = true;
      } else if (order.status === "결제취소") {
        order.status = "취소";
        order.paymentStatus = "결제취소";
        repaired = true;
      }
      if (!order.paymentStatus) {
        order.paymentStatus = order.paymentKey ? "결제완료" : "결제대기";
        repaired = true;
      }
      if (["픽업완료", "배송완료"].includes(order.status) && order.paymentStatus === "결제대기") {
        order.paymentStatus = "결제완료";
        repaired = true;
      }
      if (!order.amountStatus) {
        order.amountStatus = Number(order.revenue || order.totalAmount || 0) > 0 ? "confirmed" : "pending";
        repaired = true;
      }
      if (!order.workflowStatus) {
        order.workflowStatus = ["취소", "주문취소"].includes(order.status) || ["결제취소", "환불완료"].includes(order.paymentStatus) ? "취소"
          : order.status === "배송완료" ? "배송완료"
            : order.status === "픽업완료" ? "픽업완료"
              : order.status === "배송중" ? "배송중"
                : order.status === "준비완료" && order.fulfillmentType !== "delivery" ? "픽업준비완료"
                  : order.status === "준비중" ? "접수완료"
                    : order.paymentStatus === "결제완료" ? "접수대기" : "결제대기";
        repaired = true;
      }
      if (order.workflowStatus === "결제완료") { order.workflowStatus = "접수대기"; repaired = true; }
      if (order.workflowStatus === "완료") { order.workflowStatus = order.fulfillmentType === "delivery" ? "배송완료" : "픽업완료"; repaired = true; }
      const createdDate = String(order.createdAt || "").slice(0, 10);
      if (createdDate && order.pickupDate && order.pickupDate < createdDate) {
        const date = new Date(`${createdDate}T00:00:00`);
        date.setDate(date.getDate() + 1);
        order.pickupDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        repaired = true;
      }
      return order;
    });
    if (repaired) localStorage.setItem(orderStorageKey, JSON.stringify(orders));
    return orders;
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  const old = readOrders();
  localStorage.setItem(orderStorageKey, JSON.stringify(orders));
  Promise.resolve(syncArrayToApi("/orders", old, orders)).then(async () => {
    if (!getApiToken()) return;
    const canonical = await apiFetch("/orders");
    if (Array.isArray(canonical)) {
      localStorage.setItem(orderStorageKey, JSON.stringify(canonical));
      if (typeof renderAdminDashboard === "function") renderAdminDashboard();
    }
    const logs = await apiFetch("/activity-logs?limit=500");
    if (Array.isArray(logs)) {
      localStorage.setItem(activityStorageKey, JSON.stringify(logs));
      if (typeof renderAdminAuditLogs === "function") renderAdminAuditLogs();
    }
  });
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

function addActivityLog(category, message, tab = "orders", details = {}) {
  writeActivityLogs(
    [
      {
        id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        category,
        message,
        tab,
        action: details.action || null,
        entityId: details.entityId || null,
        previousValue: details.previousValue ?? null,
        nextValue: details.nextValue ?? null,
        actor: details.actor || "관리자",
        createdAt: new Date().toISOString(),
      },
      ...readActivityLogs(),
    ].slice(0, 100),
  );
}
