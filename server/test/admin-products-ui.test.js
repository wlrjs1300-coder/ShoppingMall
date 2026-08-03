const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const productUi = fs.readFileSync(path.join(root, "js/admin/products.js"), "utf8");
const productRoute = fs.readFileSync(path.join(root, "server/routes/products.js"), "utf8");
const apiUi = fs.readFileSync(path.join(root, "js/api.js"), "utf8");
const securityMiddleware = fs.readFileSync(path.join(root, "server/middleware/security.js"), "utf8");

test("관리자 메뉴 탭은 목록, 검색, 상태 필터와 추가·수정 폼을 제공한다", () => {
  for (const contract of [
    'data-admin-tab="products"', "admin-product-panel", "data-admin-product-search",
    "data-admin-product-view-filter", "data-admin-product-create", "data-admin-product-list",
    "data-admin-product-load-state", "data-admin-product-retry", "admin-product-toolbar",
    "data-admin-product-form", 'name="purchaseType"', 'name="price"', 'name="imageUrl"',
    "data-admin-product-main-file", "data-admin-product-detail-files", 'name="detailImages"',
    'name="description"', 'name="displayOrder"', 'name="status"',
  ]) assert.match(adminHtml, new RegExp(contract));
  assert.match(adminHtml, /js\/admin\/products\.js/);
});

test("메뉴 UI는 관리자 API로 등록·수정·판매 상태 변경·삭제를 요청한다", () => {
  assert.match(productUi, /apiFetchResult\("\/products\/admin"\)/);
  assert.match(productUi, /method: editingAdminProductId \? "PUT" : "POST"/);
  assert.match(productUi, /data-admin-product-toggle/);
  assert.match(productUi, /method: "DELETE"/);
  assert.match(productUi, /실행 중인 서버에 메뉴관리 API가 없습니다/);
  assert.match(productUi, /setAdminProductLoadState\("error"/);
});

test("대표 이미지 파일 선택은 전체 미리보기의 두 이미지를 즉시 갱신한다", () => {
  assert.equal((adminHtml.match(/data-admin-product-preview/g) || []).length >= 2, true);
  assert.match(productUi, /function syncAdminProductPreviewImages\(imageUrl\)/);
  assert.match(productUi, /querySelectorAll\("\[data-admin-product-preview\]"\)/);
  assert.match(productUi, /syncAdminProductPreviewImages\(imageUrl\)/);
  assert.match(productUi, /dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
  assert.match(adminHtml, /data-admin-product-main-file-status/);
  assert.match(adminHtml, /최대 12MB · 자동 최적화/);
  assert.match(productUi, /optimizeAdminProductImage/);
  assert.match(productUi, /ADMIN_PRODUCT_TARGET_IMAGE_BYTES = 750_000/);
  assert.match(productUi, /withAdminProductImageTimeout/);
  assert.match(productUi, /URL\.createObjectURL\(file\)/);
  assert.match(productUi, /미리보기 적용 완료 · 저장용 이미지를 최적화하는 중입니다/);
  assert.match(productUi, /URL\.revokeObjectURL\(temporaryPreviewUrl\)/);
  assert.match(productUi, /canvasToAdminProductBlob\(canvas, 0\.72\)/);
  assert.match(productUi, /canvasToAdminProductBlob\(compactCanvas, 0\.6\)/);
  assert.doesNotMatch(productUi, /for \(const quality of/);
  assert.match(securityMiddleware, /img-src 'self' data: blob: https:/);
});

test("상세 이미지 파일은 전체 미리보기에 실제 상세 페이지 규격으로 즉시 반영된다", () => {
  const refinements = fs.readFileSync(path.join(root, "css/refinements.css"), "utf8");
  assert.match(productUi, /renderAdminProductDetailPreviews[\s\S]*syncAdminProductPreview\(\)/);
  assert.match(refinements, /\.admin-product-preview-detail-images \{ grid-template-columns:1fr; \}/);
  assert.match(refinements, /\.admin-product-preview-detail-images img[^}]*height:auto/);
  assert.match(refinements, /\.admin-product-preview-detail-images img[^}]*object-fit:contain/);
});

test("사이드바 메뉴관리 숫자는 판매 상태와 관계없이 전체 등록 메뉴 수를 사용한다", () => {
  assert.match(productUi, /tabCount\.textContent = String\(adminProducts\.length\)/);
  assert.doesNotMatch(productUi, /tabCount\.textContent = String\(adminProducts\.filter/);
  assert.match(productUi, /등록 메뉴 \$\{adminProducts\.length\}개/);
  assert.match(apiUi, /typeof loadAdminProducts === "function"/);
  assert.match(apiUi, /await loadAdminProducts\(\)/);
  assert.match(productUi, /adminProductsLoadPromise/);
});

test("상품 삭제는 기본 상품과 주문·문의·배합 이력을 보호한다", () => {
  assert.match(productRoute, /SEEDED_PRODUCT_IDS/);
  assert.match(productRoute, /order_items/);
  assert.match(productRoute, /product_inquiries/);
  assert.match(productRoute, /recipes/);
  assert.match(productRoute, /PRODUCT_HISTORY_EXISTS/);
});
