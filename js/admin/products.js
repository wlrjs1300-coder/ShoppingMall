let adminProducts = [];
let editingAdminProductId = "";
let adminOrderPanelTargetHeight = document.querySelector(".admin-order-panel")?.getBoundingClientRect().height || 0;
let adminProductsLoadPromise = null;
const ADMIN_PRODUCT_MAX_SOURCE_IMAGE_BYTES = 12_000_000;
const ADMIN_PRODUCT_TARGET_IMAGE_BYTES = 750_000;
const ADMIN_PRODUCT_MAX_IMAGE_EDGE = 1200;

function withAdminProductImageTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function createAdminProductId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 8)
    || Math.random().toString(36).slice(2, 10);
  return `menu-${date}-${suffix}`;
}

function readAdminProductFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("이미지 파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

function loadAdminProductBitmap(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(objectUrl); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("이미지를 불러오지 못했습니다.")); };
    image.src = objectUrl;
  });
}

function canvasToAdminProductBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

async function optimizeAdminProductImage(file) {
  const image = await withAdminProductImageTimeout(
    loadAdminProductBitmap(file), 8_000, "이미지를 불러오는 데 시간이 오래 걸립니다. JPG 또는 WEBP 파일로 다시 시도해 주세요.",
  );
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const scale = Math.min(1, ADMIN_PRODUCT_MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이 브라우저에서는 이미지 최적화를 사용할 수 없습니다.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let blob = await withAdminProductImageTimeout(
    canvasToAdminProductBlob(canvas, 0.72), 6_000, "이미지 최적화 시간이 초과되었습니다. 다른 사진으로 다시 시도해 주세요.",
  );
  if (blob && blob.size > ADMIN_PRODUCT_TARGET_IMAGE_BYTES) {
    const reduction = Math.min(0.9, Math.sqrt(ADMIN_PRODUCT_TARGET_IMAGE_BYTES / blob.size) * 0.9);
    const compactCanvas = document.createElement("canvas");
    compactCanvas.width = Math.max(1, Math.round(canvas.width * reduction));
    compactCanvas.height = Math.max(1, Math.round(canvas.height * reduction));
    const compactContext = compactCanvas.getContext("2d");
    if (!compactContext) throw new Error("이 브라우저에서는 이미지 최적화를 사용할 수 없습니다.");
    compactContext.drawImage(canvas, 0, 0, compactCanvas.width, compactCanvas.height);
    blob = await withAdminProductImageTimeout(
      canvasToAdminProductBlob(compactCanvas, 0.6), 6_000, "이미지 최적화 시간이 초과되었습니다. 다른 사진으로 다시 시도해 주세요.",
    );
  }
  if (!blob || blob.size > ADMIN_PRODUCT_TARGET_IMAGE_BYTES) throw new Error("이미지를 자동 최적화하지 못했습니다. 다른 사진을 선택해 주세요.");
  return readAdminProductFile(blob);
}

async function readAdminProductImage(file) {
  if (!file || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
    throw new Error("PNG, JPG, WEBP, GIF 이미지 파일만 첨부할 수 있습니다.");
  }
  if (file.size > ADMIN_PRODUCT_MAX_SOURCE_IMAGE_BYTES) throw new Error("원본 이미지는 한 장당 12MB 이하로 선택해 주세요.");
  return file.size <= ADMIN_PRODUCT_TARGET_IMAGE_BYTES ? readAdminProductFile(file) : optimizeAdminProductImage(file);
}

function getAdminProductDetailImages() {
  const form = document.querySelector("[data-admin-product-form]");
  try { return JSON.parse(form?.elements.detailImages.value || "[]"); } catch { return []; }
}

function renderAdminProductDetailPreviews(images = getAdminProductDetailImages()) {
  const form = document.querySelector("[data-admin-product-form]");
  const container = document.querySelector("[data-admin-product-detail-previews]");
  if (!form || !container) return;
  form.elements.detailImages.value = JSON.stringify(images);
  container.innerHTML = images.length ? images.map((url, index) => `<figure><img src="${escapeHtml(url)}" alt="상세 이미지 ${index + 1} 미리보기" /><figcaption><span>${index + 1}번째 이미지</span><button type="button" data-admin-product-detail-remove="${index}" aria-label="${index + 1}번째 상세 이미지 삭제">삭제</button></figcaption></figure>`).join("") : "<p>등록된 상세 이미지가 없습니다.</p>";
  syncAdminProductPreview();
}

function fitAdminProductTableHeight() {
  const wrap = document.querySelector(".admin-product-table-wrap");
  const productPanel = document.querySelector(".admin-product-panel");
  const orderPanel = document.querySelector(".admin-order-panel");
  if (!wrap || !productPanel || !orderPanel) return;
  if (!orderPanel.hidden) adminOrderPanelTargetHeight = orderPanel.getBoundingClientRect().height;
  if (!Number.isFinite(adminOrderPanelTargetHeight) || adminOrderPanelTargetHeight <= 0) return;
  const nonTableHeight = productPanel.getBoundingClientRect().height - wrap.getBoundingClientRect().height;
  const targetTableHeight = Math.max(180, adminOrderPanelTargetHeight - nonTableHeight);
  wrap.style.height = `${targetTableHeight}px`;
  wrap.style.maxHeight = `${targetTableHeight}px`;
}

function setAdminProductLoadState(state, message = "") {
  const container = document.querySelector("[data-admin-product-load-state]");
  const table = document.querySelector(".admin-product-table-wrap");
  if (!container || !table) return;
  const title = container.querySelector("[data-admin-product-load-title]");
  const detail = container.querySelector("[data-admin-product-load-message]");
  const retry = container.querySelector("[data-admin-product-retry]");
  container.hidden = state === "ready";
  table.hidden = state !== "ready";
  container.classList.toggle("is-error", state === "error");
  if (title) title.textContent = state === "loading" ? "메뉴를 불러오고 있습니다" : "메뉴를 불러오지 못했습니다";
  if (detail) detail.textContent = message || (state === "loading" ? "잠시만 기다려 주세요." : "서버 연결을 확인한 뒤 다시 시도해 주세요.");
  if (retry) retry.hidden = state !== "error";
}

function formatAdminProductPrice(product) {
  return product.purchaseType === "consultation" ? "상담 후 안내" : formatWon(Number(product.price || 0));
}

async function loadAdminProducts() {
  if (!getApiToken()) return;
  if (adminProductsLoadPromise) return adminProductsLoadPromise;
  adminProductsLoadPromise = loadAdminProductsOnce();
  try { return await adminProductsLoadPromise; }
  finally { adminProductsLoadPromise = null; }
}

async function loadAdminProductsOnce() {
  setAdminProductLoadState("loading");
  const result = await apiFetchResult("/products/admin");
  if (!result.ok) {
    const message = result.status === 404
      ? "실행 중인 서버에 메뉴관리 API가 없습니다. Node 서버를 재시작한 뒤 다시 불러와 주세요."
      : result.error;
    setAdminProductLoadState("error", message);
    return;
  }
  adminProducts = Array.isArray(result.data?.products) ? result.data.products : [];
  setAdminProductLoadState("ready");
  renderAdminProducts();
}

function renderAdminProducts() {
  const list = document.querySelector("[data-admin-product-list]");
  if (!list) return;
  const keyword = String(document.querySelector("[data-admin-product-search]")?.value || "").trim().toLowerCase();
  const view = document.querySelector("[data-admin-product-view-filter]")?.value || "all";
  const products = adminProducts.filter((product) => {
    const haystack = `${product.id} ${product.name} ${product.category}`.toLowerCase();
    const matchesView = view === "all"
      || (view === "consultation" ? product.purchaseType === "consultation" : product.status === view);
    return (!keyword || haystack.includes(keyword)) && matchesView;
  });

  list.innerHTML = products.map((product) => `
    <tr data-admin-product-id="${escapeHtml(product.id)}" draggable="true">
      <td class="admin-product-order-cell"><div class="admin-product-order-controls"><button type="button" data-admin-product-move="up" aria-label="${escapeHtml(product.name)} 위로 이동">↑</button><span title="끌어서 순서 변경" aria-hidden="true">⠿</span><button type="button" data-admin-product-move="down" aria-label="${escapeHtml(product.name)} 아래로 이동">↓</button></div></td>
      <td class="admin-product-image-cell"><img class="admin-product-thumb" src="${escapeHtml(product.imageUrl)}" alt="" /></td>
      <td class="admin-product-name-cell"><strong>${escapeHtml(product.name)}</strong><p>${escapeHtml(product.description || "설명 없음")}</p></td>
      <td class="admin-product-category-cell" data-label="카테고리">${escapeHtml(product.category)}</td>
      <td class="admin-product-purchase-cell" data-label="판매 방식">${product.purchaseType === "direct" ? "바로 구매" : "상담 주문"}</td>
      <td class="admin-product-price-cell" data-label="판매가">${escapeHtml(formatAdminProductPrice(product))}</td>
      <td class="admin-product-status-cell" data-label="판매 상태"><button class="admin-product-status ${product.status === "active" ? "is-active" : "is-inactive"}" type="button" data-admin-product-toggle aria-label="${escapeHtml(product.name)} 판매 상태 변경">${product.status === "active" ? "판매 중" : "판매 중지"}</button></td>
      <td class="admin-product-actions-cell"><div class="admin-row-actions"><button type="button" data-admin-product-edit>수정</button><button class="is-danger" type="button" data-admin-product-delete>삭제</button></div></td>
    </tr>`).join("");

  const empty = document.querySelector("[data-admin-product-empty]");
  if (empty) empty.hidden = products.length > 0;
  const total = document.querySelector("[data-admin-product-total]");
  if (total) total.textContent = String(products.length);
  const caption = document.querySelector("[data-admin-product-filter-caption]");
  const tone = document.querySelector(".admin-product-view-filter [data-status-tone]");
  const captions = { all: "전체 메뉴", active: "고객 노출", inactive: "노출 안 함", consultation: "가격 문의" };
  if (caption) caption.textContent = captions[view] || captions.all;
  if (tone) tone.dataset.statusTone = view === "active" ? "done" : view === "inactive" ? "canceled" : "all";
  const tabCount = document.querySelector('[data-admin-tab-count="products"]');
  if (tabCount) {
    tabCount.textContent = String(adminProducts.length);
    tabCount.setAttribute("aria-label", `등록 메뉴 ${adminProducts.length}개`);
  }
  const categories = [...new Set(adminProducts.map((product) => product.category).filter(Boolean))].sort();
  const categorySelect = document.querySelector('[data-admin-product-form] [name="category"]');
  if (categorySelect) {
    const selected = categorySelect.value;
    const values = selected && !categories.includes(selected) ? [selected, ...categories] : categories;
    categorySelect.innerHTML = `<option value="">카테고리를 선택하세요</option>${values.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
    categorySelect.value = selected;
  }
  if (typeof applyAdminPermissions === "function") applyAdminPermissions({ permissions: [...currentAdminPermissions] });
  requestAnimationFrame(fitAdminProductTableHeight);
}

function syncAdminProductPriceField() {
  const form = document.querySelector("[data-admin-product-form]");
  if (!form) return;
  const isDirect = form.elements.purchaseType.value === "direct";
  const field = form.querySelector("[data-admin-product-price-field]");
  const inputs = [form.elements.price, form.elements.halfMalPrice, form.elements.malPrice];
  const weightInputs = [form.elements.unitWeightGrams, form.elements.halfMalWeightGrams, form.elements.malWeightGrams];
  const help = form.querySelector("[data-admin-product-purchase-help]");
  field?.classList.toggle("is-disabled", !isDirect);
  form.querySelector("[data-admin-product-weight-field]")?.classList.toggle("is-disabled", !isDirect);
  inputs.forEach((input) => {
    input.disabled = !isDirect;
    input.required = isDirect;
    if (!isDirect) input.value = "";
  });
  weightInputs.forEach((input, index) => {
    input.disabled = !isDirect;
    input.required = isDirect && index === 0;
    if (!isDirect) input.value = "";
  });
  if (help) help.textContent = isDirect
    ? "고객이 장바구니에 바로 담을 수 있습니다."
    : "가격을 노출하지 않고 상품 문의로 연결합니다.";
  const purchaseShell = form.elements.purchaseType.closest(".admin-product-select-shell");
  if (purchaseShell) purchaseShell.dataset.value = form.elements.purchaseType.value;
  syncAdminProductPreview();
}

function syncAdminProductPreviewImages(imageUrl) {
  const form = document.querySelector("[data-admin-product-form]");
  const nextImageUrl = String(imageUrl ?? form?.elements.imageUrl.value ?? "").trim() || "assets/tteok-hero.png";
  document.querySelectorAll("[data-admin-product-preview]").forEach((preview) => {
    preview.setAttribute("src", nextImageUrl);
    preview.alt = `${String(form?.elements.name.value || "상품").trim()} 이미지 미리보기`;
  });
}

function syncAdminProductPreview() {
  const form = document.querySelector("[data-admin-product-form]");
  const previews = [...document.querySelectorAll("[data-admin-product-preview]")];
  if (!form || !previews.length) return;
  syncAdminProductPreviewImages();
  const name = String(form.elements.name.value || "").trim();
  const category = String(form.elements.category.value || "").trim();
  const description = String(form.elements.description.value || "").trim();
  const isConsultation = form.elements.purchaseType.value === "consultation";
  const price = Number(form.elements.price.value || 0);
  const nameElements = document.querySelectorAll("[data-admin-product-preview-name]");
  const categoryElement = document.querySelector("[data-admin-product-preview-category]");
  const descriptionElements = document.querySelectorAll("[data-admin-product-preview-description]");
  const priceElements = document.querySelectorAll("[data-admin-product-preview-price]");
  const countElement = document.querySelector("[data-admin-product-description-count]");
  nameElements.forEach((element) => { element.textContent = name || "메뉴명 미리보기"; });
  if (categoryElement) categoryElement.textContent = category || "카테고리";
  descriptionElements.forEach((element) => { element.textContent = description || "입력한 설명이 고객 화면에 이렇게 표시됩니다."; });
  priceElements.forEach((element) => { element.textContent = isConsultation ? "상담 후 안내" : (price > 0 ? formatWon(price) : "가격 미입력"); });
  const unitPrices = document.querySelector("[data-admin-product-preview-unit-prices]");
  if (unitPrices) unitPrices.innerHTML = isConsultation ? "" : [["팩", form.elements.price.value], ["반말", form.elements.halfMalPrice.value], ["한말", form.elements.malPrice.value]].map(([label, value]) => `<span><small>${label}</small><b>${Number(value) > 0 ? formatWon(Number(value)) : "미입력"}</b></span>`).join("");
  const origins = form.elements.originItemsText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const originPreview = document.querySelector("[data-admin-product-preview-origins]");
  if (originPreview) {
    originPreview.classList.toggle("is-empty", origins.length === 0);
    originPreview.innerHTML = origins.length
      ? origins.map((line) => { const index = line.indexOf(":"); return `<span><b>${escapeHtml(index >= 0 ? line.slice(0, index).trim() : line)}</b><em>${escapeHtml(index >= 0 ? line.slice(index + 1).trim() : "원산지 미입력")}</em></span>`; }).join("")
      : `<div class="admin-product-origin-empty"><span aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M9 13h30v26H9zM15 9h18v8H15zM16 25h16M16 31h10"/></svg></span><div><b>원재료·원산지 정보를 입력해 주세요</b><p>입력한 항목은 실제 메뉴 상세 페이지 표에 순서대로 표시됩니다.</p></div><button type="button" data-admin-product-origin-edit>원산지 입력하기</button></div>`;
  }
  const detailPreview = document.querySelector("[data-admin-product-preview-detail-images]");
  if (detailPreview) { const images = getAdminProductDetailImages(); detailPreview.innerHTML = images.length ? images.map((url, index) => `<img src="${escapeHtml(url)}" alt="상세 이미지 ${index + 1}" />`).join("") : "<p>등록된 상세 이미지가 없습니다.</p>"; }
  if (countElement) countElement.textContent = `${description.length} / 500`;
}

function getAdminProductOriginRows() {
  return [...document.querySelectorAll("[data-admin-product-origin-row]")].map((row) => ({
    ingredient: String(row.querySelector("[data-admin-product-origin-ingredient]")?.value || "").trim(),
    origin: String(row.querySelector("[data-admin-product-origin-value]")?.value || "").trim(),
  })).filter((item) => item.ingredient || item.origin);
}

function syncAdminProductOriginRows() {
  const form = document.querySelector("[data-admin-product-form]");
  if (!form) return;
  form.elements.originItemsText.value = getAdminProductOriginRows().map((item) => `${item.ingredient}: ${item.origin}`).join("\n");
  syncAdminProductPreview();
}

function createAdminProductOriginRowMarkup(item = {}, index = 0) {
  return `<div data-admin-product-origin-row><label><span class="sr-only">원재료 ${index + 1}</span><input type="text" maxlength="50" value="${escapeHtml(item.ingredient || "")}" placeholder="원재료명 (예: 멥쌀)" data-admin-product-origin-ingredient /></label><label><span class="sr-only">원산지 ${index + 1}</span><input type="text" maxlength="80" value="${escapeHtml(item.origin || "")}" placeholder="원산지 (예: 국내산)" data-admin-product-origin-value /></label><button type="button" aria-label="${index + 1}번째 원재료 삭제" data-admin-product-origin-remove>×</button></div>`;
}

function renderAdminProductOriginRows(items = []) {
  const root = document.querySelector("[data-admin-product-origin-rows]");
  if (!root) return;
  const rows = items.length ? items : [{ ingredient: "", origin: "" }, { ingredient: "", origin: "" }, { ingredient: "", origin: "" }];
  root.innerHTML = rows.map(createAdminProductOriginRowMarkup).join("");
  syncAdminProductOriginRows();
}

function setAdminProductEditorTab(tab) {
  const grid = document.querySelector(".admin-product-form-grid");
  const preview = document.querySelector("[data-admin-product-full-preview]");
  if (!grid || !preview) return;
  const isPreview = tab === "preview";
  grid.classList.toggle("is-preview", isPreview);
  preview.hidden = !isPreview;
  grid.scrollTop = 0;
  document.querySelectorAll("[data-admin-product-editor-tab]").forEach((button) => {
    const active = button.dataset.adminProductEditorTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  if (isPreview) syncAdminProductPreview();
}

function openAdminProductForm(product = null) {
  if (!hasAdminPermission("inventory:write")) return setAdminFeedback("메뉴를 변경할 권한이 없습니다.");
  const dialog = document.querySelector("[data-admin-product-dialog]");
  const form = document.querySelector("[data-admin-product-form]");
  if (!dialog || !form) return;
  form.reset();
  editingAdminProductId = product?.id || "";
  form.elements.id.value = product?.id || createAdminProductId();
  form.elements.id.disabled = false;
  form.elements.id.readOnly = true;
  form.elements.name.value = product?.name || "";
  form.elements.category.value = product?.category || "";
  form.elements.purchaseType.value = product?.purchaseType || "direct";
  form.elements.price.value = product?.price ?? "";
  form.elements.halfMalPrice.value = product?.halfMalPrice ?? "";
  form.elements.malPrice.value = product?.malPrice ?? "";
  form.elements.unitWeightGrams.value = product?.unitWeightGrams ?? 250;
  form.elements.halfMalWeightGrams.value = product?.halfMalWeightGrams ?? "";
  form.elements.malWeightGrams.value = product?.malWeightGrams ?? "";
  form.elements.displayOrder.value = product?.displayOrder ?? Math.max(0, ...adminProducts.map((item) => Number(item.displayOrder || 0))) + 1;
  form.elements.status.value = product?.status || "active";
  form.elements.imageUrl.value = product?.imageUrl || "";
  renderAdminProductDetailPreviews(Array.isArray(product?.detailImages) ? product.detailImages : []);
  form.elements.description.value = product?.description || "";
  renderAdminProductOriginRows(product?.originItems || []);
  document.querySelector("[data-admin-product-dialog-title]").textContent = product ? "메뉴 수정" : "메뉴 추가";
  document.querySelector("[data-admin-product-submit]").textContent = product ? "수정 저장" : "메뉴 등록";
  document.querySelector("[data-admin-product-form-status]").textContent = "";
  const mainFileStatus = document.querySelector("[data-admin-product-main-file-status]");
  if (mainFileStatus) mainFileStatus.textContent = "PNG, JPG, WEBP, GIF · 최대 12MB · 자동 최적화";
  syncAdminProductPriceField();
  const categoryShell = form.elements.category.closest(".admin-product-select-shell");
  if (categoryShell) categoryShell.dataset.value = form.elements.category.value ? "selected" : "";
  syncAdminProductPreview();
  setAdminProductEditorTab("edit");
  dialog.showModal();
  requestAnimationFrame(() => form.elements.name.focus());
}

function closeAdminProductForm() {
  editingAdminProductId = "";
  document.querySelector("[data-admin-product-dialog]")?.close();
}

document.querySelector("[data-admin-product-create]")?.addEventListener("click", () => openAdminProductForm());
document.querySelector("[data-admin-product-search]")?.addEventListener("input", renderAdminProducts);
document.querySelector("[data-admin-product-retry]")?.addEventListener("click", loadAdminProducts);
document.querySelector("[data-admin-product-view-filter]")?.addEventListener("change", renderAdminProducts);
window.addEventListener("resize", fitAdminProductTableHeight);
document.querySelectorAll("[data-admin-product-close]").forEach((button) => button.addEventListener("click", closeAdminProductForm));
document.querySelector("[data-admin-product-form]")?.elements.purchaseType.addEventListener("change", syncAdminProductPriceField);
document.querySelector("[data-admin-product-form]")?.elements.category.addEventListener("change", (event) => {
  const shell = event.currentTarget.closest(".admin-product-select-shell");
  if (shell) shell.dataset.value = event.currentTarget.value ? "selected" : "";
  syncAdminProductPreview();
});
document.querySelector("[data-admin-product-form]")?.elements.imageUrl.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-main-file]")?.addEventListener("change", async (event) => {
  const status = document.querySelector("[data-admin-product-form-status]");
  const fileStatus = document.querySelector("[data-admin-product-main-file-status]");
  const file = event.currentTarget.files?.[0];
  const imageField = event.currentTarget.form.elements.imageUrl;
  const previousImageUrl = imageField.value;
  let temporaryPreviewUrl = "";
  try {
    if (!file) throw new Error("선택된 이미지가 없습니다.");
    temporaryPreviewUrl = URL.createObjectURL(file);
    syncAdminProductPreviewImages(temporaryPreviewUrl);
    if (fileStatus) fileStatus.textContent = file.size > ADMIN_PRODUCT_TARGET_IMAGE_BYTES
      ? "미리보기 적용 완료 · 저장용 이미지를 최적화하는 중입니다…"
      : "이미지를 적용하는 중입니다…";
    const imageUrl = await readAdminProductImage(file);
    imageField.value = imageUrl;
    syncAdminProductPreviewImages(imageUrl);
    imageField.dispatchEvent(new Event("input", { bubbles: true }));
    if (fileStatus) fileStatus.textContent = "대표 이미지가 적용되었습니다.";
    if (status) status.textContent = "대표 이미지를 첨부했습니다.";
  } catch (error) {
    event.currentTarget.value = "";
    imageField.value = previousImageUrl;
    syncAdminProductPreviewImages(previousImageUrl);
    if (fileStatus) fileStatus.textContent = error.message;
    if (status) status.textContent = error.message;
  } finally {
    if (temporaryPreviewUrl) URL.revokeObjectURL(temporaryPreviewUrl);
  }
});
document.querySelector("[data-admin-product-detail-files]")?.addEventListener("change", async (event) => {
  const status = document.querySelector("[data-admin-product-form-status]");
  const files = [...(event.currentTarget.files || [])];
  try {
    if (files.length > 4) throw new Error("상세 이미지는 최대 4장까지 첨부할 수 있습니다.");
    const images = await Promise.all(files.map(readAdminProductImage));
    renderAdminProductDetailPreviews(images);
    if (status) status.textContent = `상세 이미지 ${images.length}장을 첨부했습니다.`;
  } catch (error) {
    event.currentTarget.value = "";
    if (status) status.textContent = error.message;
  }
});
document.querySelector("[data-admin-product-detail-previews]")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-admin-product-detail-remove]");
  if (!button) return;
  const images = getAdminProductDetailImages();
  images.splice(Number(button.dataset.adminProductDetailRemove), 1);
  renderAdminProductDetailPreviews(images);
});
document.querySelector("[data-admin-product-form]")?.elements.name.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-form]")?.elements.category.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-form]")?.elements.price.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-form]")?.elements.halfMalPrice.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-form]")?.elements.malPrice.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-form]")?.elements.unitWeightGrams.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-form]")?.elements.halfMalWeightGrams.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-form]")?.elements.malWeightGrams.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-form]")?.elements.description.addEventListener("input", syncAdminProductPreview);
document.querySelector("[data-admin-product-origin-rows]")?.addEventListener("input", syncAdminProductOriginRows);
document.querySelector("[data-admin-product-origin-rows]")?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-admin-product-origin-remove]")) return;
  event.target.closest("[data-admin-product-origin-row]")?.remove();
  if (!document.querySelector("[data-admin-product-origin-row]")) renderAdminProductOriginRows();
  else syncAdminProductOriginRows();
});
document.querySelector("[data-admin-product-origin-add]")?.addEventListener("click", () => {
  const root = document.querySelector("[data-admin-product-origin-rows]");
  if (!root || root.children.length >= 12) return;
  root.insertAdjacentHTML("beforeend", createAdminProductOriginRowMarkup({}, root.children.length));
  syncAdminProductOriginRows();
  root.querySelector("[data-admin-product-origin-row]:last-child input")?.focus();
});
document.querySelectorAll("[data-admin-product-editor-tab]").forEach((button) => button.addEventListener("click", () => setAdminProductEditorTab(button.dataset.adminProductEditorTab)));
document.querySelector("[data-admin-product-preview-origins]")?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-admin-product-origin-edit]")) return;
  setAdminProductEditorTab("edit");
  requestAnimationFrame(() => document.querySelector("[data-admin-product-origin-ingredient]")?.focus());
});
document.querySelectorAll("[data-admin-product-preview]").forEach((preview) => preview.addEventListener("error", (event) => {
  event.currentTarget.src = "assets/tteok-hero.png";
}));

document.querySelector("[data-admin-product-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setAdminProductEditorTab("edit");
  if (!form.reportValidity()) return;
  const status = document.querySelector("[data-admin-product-form-status]");
  const submit = document.querySelector("[data-admin-product-submit]");
  const originRows = getAdminProductOriginRows();
  const invalidOriginRow = [...document.querySelectorAll("[data-admin-product-origin-row]")].find((row) => {
    const ingredient = row.querySelector("[data-admin-product-origin-ingredient]")?.value.trim();
    const origin = row.querySelector("[data-admin-product-origin-value]")?.value.trim();
    return (ingredient || origin) && (!ingredient || !origin);
  });
  if (invalidOriginRow) {
    status.textContent = "원재료명과 원산지를 한 쌍으로 입력해 주세요.";
    const ingredient = invalidOriginRow.querySelector("[data-admin-product-origin-ingredient]");
    const origin = invalidOriginRow.querySelector("[data-admin-product-origin-value]");
    (ingredient.value.trim() ? origin : ingredient).focus();
    return;
  }
  const body = {
    id: editingAdminProductId || form.elements.id.value.trim(),
    name: form.elements.name.value.trim(),
    category: form.elements.category.value.trim(),
    purchaseType: form.elements.purchaseType.value,
    price: form.elements.purchaseType.value === "direct" ? Number(form.elements.price.value) : null,
    halfMalPrice: form.elements.purchaseType.value === "direct" ? Number(form.elements.halfMalPrice.value) : null,
    malPrice: form.elements.purchaseType.value === "direct" ? Number(form.elements.malPrice.value) : null,
    unitWeightGrams: form.elements.purchaseType.value === "direct" ? Number(form.elements.unitWeightGrams.value) : null,
    halfMalWeightGrams: form.elements.purchaseType.value === "direct" && form.elements.halfMalWeightGrams.value ? Number(form.elements.halfMalWeightGrams.value) : null,
    malWeightGrams: form.elements.purchaseType.value === "direct" && form.elements.malWeightGrams.value ? Number(form.elements.malWeightGrams.value) : null,
    displayOrder: Number(form.elements.displayOrder.value),
    status: form.elements.status.value,
    imageUrl: form.elements.imageUrl.value.trim(),
    detailImages: getAdminProductDetailImages(),
    description: form.elements.description.value.trim(),
    originItems: originRows,
  };
  submit.disabled = true;
  status.textContent = "저장하고 있습니다.";
  const path = editingAdminProductId ? `/products/admin/${encodeURIComponent(editingAdminProductId)}` : "/products/admin";
  const wasEditing = Boolean(editingAdminProductId);
  const result = await apiFetchResult(path, { method: editingAdminProductId ? "PUT" : "POST", body });
  submit.disabled = false;
  if (!result.ok) return status.textContent = result.error;
  closeAdminProductForm();
  await loadAdminProducts();
  setAdminFeedback(wasEditing ? "메뉴 정보를 수정했습니다." : "새 메뉴를 등록했습니다.");
});

async function saveAdminProductOrder(ids) {
  const result = await apiFetchResult("/products/admin/reorder", { method: "PUT", body: { ids } });
  if (!result.ok) return setAdminFeedback(result.error);
  const positions = new Map(ids.map((id, index) => [id, index + 1]));
  adminProducts.sort((a, b) => positions.get(a.id) - positions.get(b.id));
  adminProducts.forEach((product) => { product.displayOrder = positions.get(product.id); });
  renderAdminProducts();
  setAdminFeedback("메뉴 노출 순서를 변경했습니다.");
}

let draggedAdminProductId = "";
document.querySelector("[data-admin-product-list]")?.addEventListener("dragstart", (event) => {
  const row = event.target.closest("tr[data-admin-product-id]");
  if (!row || !hasAdminPermission("inventory:write")) return event.preventDefault();
  draggedAdminProductId = row.dataset.adminProductId;
  row.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
});
document.querySelector("[data-admin-product-list]")?.addEventListener("dragover", (event) => {
  if (!draggedAdminProductId) return;
  event.preventDefault();
  event.target.closest("tr[data-admin-product-id]")?.classList.add("is-drag-target");
});
document.querySelector("[data-admin-product-list]")?.addEventListener("dragleave", (event) => event.target.closest("tr")?.classList.remove("is-drag-target"));
document.querySelector("[data-admin-product-list]")?.addEventListener("drop", async (event) => {
  event.preventDefault();
  const targetId = event.target.closest("tr[data-admin-product-id]")?.dataset.adminProductId;
  document.querySelectorAll(".admin-product-table tr").forEach((row) => row.classList.remove("is-dragging", "is-drag-target"));
  if (!targetId || targetId === draggedAdminProductId) return draggedAdminProductId = "";
  const ids = adminProducts.map((product) => product.id);
  const from = ids.indexOf(draggedAdminProductId);
  const to = ids.indexOf(targetId);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  draggedAdminProductId = "";
  await saveAdminProductOrder(ids);
});
document.querySelector("[data-admin-product-list]")?.addEventListener("dragend", () => {
  draggedAdminProductId = "";
  document.querySelectorAll(".admin-product-table tr").forEach((row) => row.classList.remove("is-dragging", "is-drag-target"));
});

document.querySelector("[data-admin-product-list]")?.addEventListener("click", async (event) => {
  const row = event.target.closest("tr[data-admin-product-id]");
  if (!row) return;
  const product = adminProducts.find((item) => item.id === row.dataset.adminProductId);
  if (!product) return;
  const move = event.target.closest("[data-admin-product-move]");
  if (move) {
    const ids = adminProducts.map((item) => item.id);
    const index = ids.indexOf(product.id);
    const nextIndex = move.dataset.adminProductMove === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= ids.length) return;
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    return saveAdminProductOrder(ids);
  }
  if (event.target.closest("[data-admin-product-edit]")) return openAdminProductForm(product);
  if (!hasAdminPermission("inventory:write")) return setAdminFeedback("메뉴를 변경할 권한이 없습니다.");
  if (event.target.closest("[data-admin-product-toggle]")) {
    const nextStatus = product.status === "active" ? "inactive" : "active";
    if (nextStatus === "inactive" && !await AppUI.confirm(`'${product.name}' 판매를 중지할까요?\n고객 메뉴와 상품 상세에서 즉시 숨겨집니다.`)) return;
    const result = await apiFetchResult(`/products/admin/${encodeURIComponent(product.id)}`, {
      method: "PUT", body: { ...product, status: nextStatus },
    });
    if (!result.ok) return setAdminFeedback(result.error);
    await loadAdminProducts();
    return setAdminFeedback(nextStatus === "active" ? "메뉴 판매를 시작했습니다." : "메뉴 판매를 중지했습니다.");
  }
  if (event.target.closest("[data-admin-product-delete]")) {
    if (!await AppUI.confirm(`'${product.name}' 메뉴를 삭제할까요?\n이력이 있으면 삭제되지 않으며 판매 중지를 사용해야 합니다.`)) return;
    const result = await apiFetchResult(`/products/admin/${encodeURIComponent(product.id)}`, { method: "DELETE" });
    if (!result.ok) return setAdminFeedback(result.error);
    await loadAdminProducts();
    setAdminFeedback("사용 이력이 없는 메뉴를 삭제했습니다.");
  }
});
