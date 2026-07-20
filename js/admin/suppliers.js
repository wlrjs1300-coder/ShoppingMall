function resetSupplierForm() {
  if (!adminSupplierForm) return;
  adminSupplierForm.reset();
  adminSupplierForm.elements.namedItem("id").value = "";
  if (adminSupplierSubmit) adminSupplierSubmit.textContent = "공급처 저장";
  if (adminSupplierCancel) adminSupplierCancel.hidden = true;
}

function saveSupplier(formData) {
  const id = String(formData.get("id") || "").trim();
  const name = String(formData.get("name") || "").trim();
  if (!name) {
    setAdminFeedback("공급처명은 필수입니다.");
    return;
  }
  const suppliers = readSuppliers();
  const existing = id ? suppliers.find((supplier) => supplier.id === id) : null;
  const supplier = {
    id: id || `supplier-${Date.now()}`,
    name,
    phone: String(formData.get("phone") || "").trim(),
    items: String(formData.get("items") || "").trim(),
    memo: String(formData.get("memo") || "").trim(),
    updatedAt: new Date().toISOString(),
  };
  const nextSuppliers = existing
    ? suppliers.map((current) => (current.id === id ? { ...current, ...supplier } : current))
    : [{ ...supplier, createdAt: new Date().toISOString() }, ...suppliers];
  writeSuppliers(nextSuppliers);

  if (existing && existing.name !== name) {
    writePurchaseOrders(readPurchaseOrders().map((order) => (order.supplier === existing.name ? { ...order, supplier: name } : order)));
  }
  resetSupplierForm();
  closeAdminFormDrawer("supplier");
  renderAdminDashboard();
  setAdminFeedback(existing ? "공급처 정보를 수정했습니다." : "공급처를 등록했습니다.");
}

function editSupplier(supplierId) {
  if (!adminSupplierForm) return;
  const supplier = readSuppliers().find((current) => current.id === supplierId);
  if (!supplier) return;
  ["id", "name", "phone", "items", "memo"].forEach((field) => {
    adminSupplierForm.elements.namedItem(field).value = supplier[field] || "";
  });
  if (adminSupplierSubmit) adminSupplierSubmit.textContent = "수정 저장";
  if (adminSupplierCancel) adminSupplierCancel.hidden = false;
  openAdminFormDrawer("supplier", { editing: true });
}

function renderSuppliers() {
  const supplierList = document.querySelector(".admin-supplier-list");
  if (!supplierList) return;
  const suppliers = readSuppliers().sort((a, b) => String(a.name).localeCompare(String(b.name), "ko-KR"));
  const empty = document.querySelector(".admin-supplier-empty");
  const total = document.querySelector("[data-admin-supplier-total]");
  const options = document.querySelector("#adminSupplierOptions");
  if (empty) empty.hidden = suppliers.length > 0;
  if (total) total.textContent = String(suppliers.length);
  if (options) options.innerHTML = suppliers.map((supplier) => `<option value="${escapeHtml(supplier.name)}"></option>`).join("");

  supplierList.innerHTML = suppliers
    .map(
      (supplier) => `
        <tr data-supplier-id="${escapeHtml(supplier.id)}">
          <td><strong>${escapeHtml(supplier.name)}</strong></td>
          <td>${escapeHtml(supplier.phone || "-")}</td>
          <td>${escapeHtml(supplier.items || "-")}</td>
          <td>${escapeHtml(supplier.memo || "-")}</td>
          <td class="admin-row-actions">
            <button class="admin-supplier-edit" type="button">수정</button>
            <button class="admin-supplier-delete" type="button">삭제</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function createPurchaseOrder(itemId, amount, details = {}) {
  const items = readInventory();
  const item = items.find((current) => current.id === itemId);
  if (!item || Number(amount || 0) <= 0) return;

  const orders = readPurchaseOrders();

  writeInventory(items.map((current) => current.id === item.id ? { ...current, purchaseOnHold: false } : current));
  writePurchaseOrders([
    {
      id: `purchase-${Date.now()}`,
      inventoryId: item.id,
      name: item.name,
      amount: Number(amount),
      unit: item.unit,
      supplier: String(details.supplier || "").trim(),
      unitCost: Number(details.unitCost || 0),
      status: "발주완료",
      createdAt: new Date().toISOString(),
    },
    ...orders,
  ]);
  addActivityLog("발주", `${item.name} ${formatMaterialAmount(amount)}${item.unit} 발주를 요청했습니다.`, "inventory");
  renderAdminDashboard();
  setAdminFeedback(`${item.name} ${formatMaterialAmount(amount)}${item.unit} 발주를 요청했습니다.`);
}

function completePurchaseOrder(orderId) {
  const purchaseOrders = readPurchaseOrders();
  const order = purchaseOrders.find((current) => current.id === orderId);
  if (!order || order.receivedAt) return;
  const inventory = readInventory();
  const inventoryItem = inventory.find((current) => current.id === order.inventoryId);
  if (!inventoryItem) {
    setAdminFeedback(`${order.name}에 연결된 재고 품목이 삭제되었습니다. 발주를 삭제하고 재등록해 주세요.`);
    renderPurchaseOrders();
    return;
  }

  const newStock = Number((Number(inventoryItem.stock || 0) + Number(order.amount || 0)).toFixed(2));
  writeInventory(
    inventory.map((current) =>
      current.id === order.inventoryId
        ? { ...current, stock: newStock, updatedAt: new Date().toISOString() }
        : current,
    ),
  );
  if (Number(inventoryItem.safeStock || 0) > 0 && newStock >= Number(inventoryItem.safeStock || 0)) {
    clearLowStockNotified(inventoryItem.id);
  }
  writePurchaseOrders(
    purchaseOrders.map((current) =>
      current.id === orderId ? { ...current, status: "입고완료", receivedAt: new Date().toISOString() } : current,
    ),
  );
  addActivityLog("입고", `${order.name} ${formatMaterialAmount(order.amount)}${order.unit} 입고를 완료했습니다.`, "inventory");
  renderAdminDashboard();
  setAdminFeedback(`${order.name} ${formatMaterialAmount(order.amount)}${order.unit} 입고를 반영했습니다.`);
}

function updatePurchaseOrderStatus(orderId, status) {
  if (status === "입고완료") {
    completePurchaseOrder(orderId);
    return;
  }
  writePurchaseOrders(readPurchaseOrders().map((order) => (order.id === orderId ? { ...order, status } : order)));
  const order = readPurchaseOrders().find((current) => current.id === orderId);
  addActivityLog("발주", `${order?.name || "발주"} 상태를 ${status}(으)로 변경했습니다.`, "inventory");
  renderPurchaseOrders();
  setAdminFeedback(`발주 상태를 ${status}(으)로 변경했습니다.`);
}

function togglePurchaseOrderHold(orderId) {
  const orders = readPurchaseOrders();
  const target = orders.find((order) => order.id === orderId);
  if (!target) return;
  const isHolding = target.status === "보류";
  const nextStatus = isHolding ? (target.statusBeforeHold || "발주완료") : "보류";
  writePurchaseOrders(orders.map((order) => order.id === orderId
    ? { ...order, status: nextStatus, statusBeforeHold: isHolding ? "" : order.status, updatedAt: new Date().toISOString() }
    : order));
  addActivityLog("발주", `${target.name} 발주 보류를 ${isHolding ? "해제" : "설정"}했습니다.`, "inventory");
  renderAdminDashboard();
  setAdminFeedback(`${target.name} 발주를 ${isHolding ? "다시 진행합니다" : "보류 목록 최하단으로 이동했습니다"}.`);
}

function updatePurchaseOrderDetails(orderId, patch) {
  writePurchaseOrders(
    readPurchaseOrders().map((order) => (order.id === orderId ? { ...order, ...patch, updatedAt: new Date().toISOString() } : order)),
  );
  renderPurchaseOrders();
  setAdminFeedback("발주 정보를 저장했습니다.");
}

function renderPurchaseOrders() {
  const orderList = document.querySelector(".admin-purchase-order-list");
  if (!orderList) return;
  const orders = readPurchaseOrders()
    .map((order) => ({
      ...order,
      status: ["발주요청", "발주중"].includes(order.status) ? "발주완료" : order.status,
    }))
    .sort((a, b) => Number(a.status === "보류") - Number(b.status === "보류"));
  const empty = document.querySelector(".admin-purchase-order-empty");
  const unifiedEmpty = document.querySelector(".admin-purchase-empty");
  const costTotal = document.querySelector("[data-purchase-cost-total]");
  const activeCost = orders
    .filter((order) => !["입고완료", "보류"].includes(order.status))
    .reduce((sum, order) => sum + Number(order.amount || 0) * Number(order.unitCost || 0), 0);
  if (empty) empty.hidden = orders.length > 0;
  if (unifiedEmpty) {
    const hasCandidates = readInventory().some((item) => getInventoryStatus(item) !== "정상" && getRecommendedPurchaseQuantity(item) > 0 && !orders.some((order) => order.inventoryId === item.id && order.status !== "입고완료"));
    unifiedEmpty.hidden = orders.length > 0 || hasCandidates;
  }
  if (costTotal) costTotal.textContent = formatWon(activeCost);

  orderList.innerHTML = orders
    .map(
      (order) => `
        <tr data-purchase-order-id="${escapeHtml(order.id)}">
          <td class="admin-purchase-editable"><strong>${escapeHtml(order.name)}</strong><small class="admin-purchase-date">${new Date(order.createdAt).toLocaleDateString("ko-KR")} 요청</small><input class="admin-purchase-supplier" type="text" list="adminSupplierOptions" value="${escapeHtml(order.supplier || "")}" placeholder="공급처 선택" /></td>
          <td>${(() => { const item = readInventory().find((current) => current.id === order.inventoryId); return item ? `${formatMaterialAmount(item.stock)}${escapeHtml(item.unit)}` : "-"; })()}</td>
          <td>${formatMaterialAmount(order.amount)}${escapeHtml(order.unit)}</td>
          <td class="admin-purchase-editable"><strong>${formatWon(Number(order.amount || 0) * Number(order.unitCost || 0))}</strong><small class="admin-purchase-date"><span>${order.unitCost ? `${formatWon(Number(order.unitCost))} / ${escapeHtml(order.unit)}` : "단가 미입력"}</span></small><input class="admin-purchase-unit-cost" type="number" min="0" step="1" value="${Number(order.unitCost || 0)}" aria-label="발주 단가" /></td>
          <td>
            ${order.status === "보류" || order.status === "입고완료"
              ? `<span class="admin-purchase-state-pill ${order.status === "보류" ? "is-hold" : "is-complete"}">${order.status}</span>`
              : `<select class="admin-purchase-status"><option value="발주완료" selected>발주 완료</option><option value="입고완료">입고 완료</option></select>`}
          </td>
          <td><div class="admin-purchase-row-actions"><button class="admin-purchase-request admin-purchase-repeat" type="button" data-purchase-item-id="${escapeHtml(order.inventoryId)}" data-purchase-amount="${Number(order.amount || 0)}">발주하기</button><button class="admin-purchase-edit" type="button">수정</button><button class="admin-purchase-hold" type="button">보류</button><button class="admin-purchase-delete" type="button">삭제</button></div></td>
        </tr>
      `,
    )
    .join("");
}

function renderInventoryLogs() {
  const logList = document.querySelector(".admin-inventory-log-list");
  if (!logList) return;

  const logs = readInventoryLogs();
  const empty = document.querySelector(".admin-inventory-log-empty");
  if (empty) empty.hidden = logs.length > 0;

  logList.innerHTML = logs
    .map(
      (log) => `
        <tr>
          <td><strong>${new Date(log.createdAt).toLocaleString("ko-KR")}</strong></td>
          <td>${escapeHtml(log.product || "-")} <span>${Number(log.quantity || 0)}개</span></td>
          <td>${escapeHtml((log.materials || []).join(", ") || "-")}</td>
        </tr>
      `,
    )
    .join("");
}

function addInventoryLog(entry) {
  const nextLogs = [
    {
      id: `usage-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...entry,
    },
    ...readInventoryLogs(),
  ].slice(0, 80);
  writeInventoryLogs(nextLogs);
}

function deductInventoryForProduction(product, quantity) {
  const materials = getProductionMaterials(product, quantity);
  const inventory = readInventory();
  const applied = [];
  const insufficient = [];
  const missing = [];
  const usedMaterialNames = new Set();

  if (!inventory.length) return { applied, insufficient, missing: materials.map((material) => material.name) };

  const nextInventory = inventory.map((item) => {
    const material = materials.find((current) => current.name === item.name && !usedMaterialNames.has(current.name));
    if (!material) return item;

    usedMaterialNames.add(material.name);
    const currentStock = Number(item.stock || 0);
    const needed = Number(material.amount || 0);
    const actualDeduction = Math.min(currentStock, needed);
    const nextStock = currentStock - actualDeduction;
    if (actualDeduction > 0) {
      applied.push(`${material.name} ${formatMaterialAmount(actualDeduction)}${material.unit}`);
    }
    if (actualDeduction < needed) {
      insufficient.push(`${material.name} (필요 ${formatMaterialAmount(needed)}${material.unit}, 재고 ${formatMaterialAmount(currentStock)}${material.unit})`);
    }
    return {
      ...item,
      stock: Number(nextStock.toFixed(2)),
      updatedAt: new Date().toISOString(),
    };
  });

  materials.forEach((material) => {
    if (!usedMaterialNames.has(material.name)) missing.push(material.name);
  });

  writeInventory(nextInventory);
  return { applied, insufficient, missing };
}
