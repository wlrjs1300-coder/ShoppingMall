function getApiToken() {
  try { return sessionStorage.getItem(apiTokenKey); } catch { return null; }
}

function setApiToken(token) {
  try {
    if (token) sessionStorage.setItem(apiTokenKey, token);
    else sessionStorage.removeItem(apiTokenKey);
  } catch {}
}

function showSessionExpiredToast() {
  if (document.getElementById("session-expired-toast")) return;
  const toast = document.createElement("div");
  toast.id = "session-expired-toast";
  toast.style.cssText =
    "position:fixed;top:20px;left:50%;transform:translateX(-50%);" +
    "background:#fff0f3;color:#c0445e;border:1px solid rgba(218,135,155,.5);" +
    "padding:12px 24px;border-radius:10px;font-size:0.9rem;font-weight:600;" +
    "z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.12);white-space:nowrap;";
  toast.textContent = "로그인 세션이 만료됐습니다. 다시 로그인해 주세요.";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

async function apiFetch(path, { method = "GET", body, extraHeaders = {} } = {}) {
  const token = getApiToken();
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      setApiToken(null);
      showSessionExpiredToast();
      return null;
    }
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function apiFetchResult(path, { method = "GET", body, extraHeaders = {} } = {}) {
  const token = getApiToken();
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setApiToken(null);
      showSessionExpiredToast();
    }
    return { ok: res.ok, status: res.status, data, error: data?.error || "요청을 처리하지 못했습니다." };
  } catch {
    return { ok: false, status: 0, data: null, error: "서버에 연결하지 못했습니다." };
  }
}

function showApiErrorToast() {
  if (document.getElementById("api-error-toast")) return;
  const toast = document.createElement("div");
  toast.id = "api-error-toast";
  toast.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
    "background:#fff0f3;color:#c0445e;border:1px solid rgba(218,135,155,.5);" +
    "padding:10px 20px;border-radius:10px;font-size:0.84rem;z-index:99999;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.12);white-space:nowrap;";
  toast.innerHTML = '서버 저장 실패 — 로컬에 보관했습니다. <button type="button" data-api-sync-retry>다시 시도</button>';
  document.body.appendChild(toast);
  toast.querySelector("[data-api-sync-retry]")?.addEventListener("click", retryPendingSync);
}

function savePendingSync(job) {
  try { localStorage.setItem(pendingSyncStorageKey, JSON.stringify(job)); } catch {}
}

async function retryPendingSync() {
  let job;
  try { job = JSON.parse(localStorage.getItem(pendingSyncStorageKey) || "null"); } catch { job = null; }
  if (!job) return document.getElementById("api-error-toast")?.remove();
  const results = await syncArrayToApi(job.path, job.oldItems, job.newItems, { isRetry: true });
  if (results.length && results.every(Boolean)) {
    localStorage.removeItem(pendingSyncStorageKey);
    document.getElementById("api-error-toast")?.remove();
    if (typeof setAdminFeedback === "function") setAdminFeedback("서버에 다시 저장했습니다.");
  }
}

async function syncArrayToApi(path, oldItems, newItems, { isRetry = false } = {}) {
  if (!getApiToken()) return [];
  const oldMap = new Map(oldItems.map((item) => [item.id, item]));
  const newMap = new Map(newItems.map((item) => [item.id, item]));
  const promises = [];
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) promises.push(apiFetch(`${path}/${id}`, { method: "DELETE" }));
  }
  for (const [id, newItem] of newMap) {
    if (!oldMap.has(id)) {
      const createPath = path === "/orders" ? "/orders/admin" : path;
      promises.push(apiFetch(createPath, { method: "POST", body: newItem }));
    } else if (JSON.stringify(oldMap.get(id)) !== JSON.stringify(newItem)) {
      promises.push(apiFetch(`${path}/${id}`, { method: "PUT", body: newItem }));
    }
  }
  if (promises.length === 0) return [];
  const results = await Promise.all(promises);
  if (results.some((r) => r === null)) {
    savePendingSync({ path, oldItems, newItems, savedAt: new Date().toISOString() });
    showApiErrorToast();
  } else if (!isRetry) {
    try { localStorage.removeItem(pendingSyncStorageKey); } catch {}
  }
  return results;
}

async function loadFromApi() {
  if (!getApiToken()) return;
  const [orders, customers, notes, inventory, recipes, purchaseOrders, suppliers, activityLogs, inventoryLogs] = await Promise.all([
    apiFetch("/orders"),
    apiFetch("/customers"),
    apiFetch("/customers/notes"),
    apiFetch("/inventory"),
    apiFetch("/recipes"),
    apiFetch("/purchase-orders"),
    apiFetch("/suppliers"),
    apiFetch("/activity-logs?limit=500"),
    apiFetch("/inventory/logs"),
  ]);
  if (Array.isArray(orders)) localStorage.setItem(orderStorageKey, JSON.stringify(orders));
  if (Array.isArray(customers)) localStorage.setItem(customerStorageKey, JSON.stringify(customers));
  if (notes && typeof notes === "object") localStorage.setItem(customerNoteStorageKey, JSON.stringify(notes));
  if (Array.isArray(inventory)) localStorage.setItem(inventoryStorageKey, JSON.stringify(inventory));
  if (Array.isArray(recipes) && recipes.length) {
    // 서버에서 받은 평탄 구조 {product, ingredient, amount, unit}를
    // 클라이언트 키워드 그룹 구조 {keywords, materials}로 변환
    if ("product" in (recipes[0] || {})) {
      const grouped = {};
      for (const row of recipes) {
        if (!grouped[row.product]) grouped[row.product] = [];
        grouped[row.product].push({ name: row.ingredient, amount: row.amount, unit: row.unit });
      }
      const converted = Object.entries(grouped).map(([kw, mats]) => ({ keywords: [kw], materials: mats }));
      localStorage.setItem(recipeStorageKey, JSON.stringify(converted));
    } else {
      localStorage.setItem(recipeStorageKey, JSON.stringify(recipes));
    }
  }
  if (Array.isArray(purchaseOrders)) localStorage.setItem(purchaseOrderStorageKey, JSON.stringify(purchaseOrders));
  if (Array.isArray(suppliers)) localStorage.setItem(supplierStorageKey, JSON.stringify(suppliers));
  if (Array.isArray(activityLogs)) localStorage.setItem(activityStorageKey, JSON.stringify(activityLogs));
  if (Array.isArray(inventoryLogs)) localStorage.setItem(inventoryLogStorageKey, JSON.stringify(inventoryLogs));
}
