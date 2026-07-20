const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");

test("menu.html에는 하드코딩 상품 카드가 없고 API 렌더링 컨테이너만 존재한다", () => {
  const html = fs.readFileSync(path.join(projectRoot, "menu.html"), "utf8");
  assert.match(html, /data-products-grid/);
  assert.doesNotMatch(html, /<article class="menu-item/);
  assert.doesNotMatch(html, /data-product-id=/);
});

test("메인 추천 상품도 API 렌더링 컨테이너를 사용한다", () => {
  const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  assert.match(html, /data-home-products="featured"/);
  assert.match(html, /data-home-products="recommended"/);
  assert.doesNotMatch(html, /class="food-card home-best-card"/);
});

test("메인 카테고리는 필터된 메뉴 목록으로 이동하고 제목을 선택 분류로 바꾼다", () => {
  const home = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  const menu = fs.readFileSync(path.join(projectRoot, "menu.html"), "utf8");
  const script = fs.readFileSync(path.join(projectRoot, "js", "menu-order.js"), "utf8");

  assert.match(home, /menu\.html\?filter=송편#menu-list/);
  assert.match(menu, /id="menu-list"/);
  assert.match(menu, /data-menu-list-title/);
  assert.match(script, /menuListTitle\.textContent = listLabel/);
  assert.match(script, /scrollToMenuListFromUrl\(\)/);
});

test("클라이언트는 상품 API와 장바구니 최신화 로직을 사용한다", () => {
  const script = ["cart.js", "menu-order.js"].map((file) => fs.readFileSync(path.join(projectRoot, "js", file), "utf8")).join("\n");
  const cartUtils = fs.readFileSync(path.join(projectRoot, "cart-utils.js"), "utf8");
  assert.match(script, /API_BASE}\/products/);
  assert.match(script, /reconcileProducts/);
  assert.match(cartUtils, /function reconcileProducts/);
});

test("장바구니 주문서가 선택 상품과 성공 후 제거 흐름을 사용한다", () => {
  const checkout = fs.readFileSync(path.join(projectRoot, "checkout.html"), "utf8");
  const script = fs.readFileSync(path.join(projectRoot, "js", "cart.js"), "utf8");
  assert.match(checkout, /data-checkout-form/);
  assert.match(checkout, /data-checkout-fulfillment/);
  assert.match(script, /filter\(\(item\) => item\.selected !== false\)/);
  assert.match(script, /\/orders\/checkout/);
  assert.match(script, /cartUtils\.removeItems/);
});

test("구매는 로그인 또는 비회원 선택을 요구하고 상담은 전화 연결을 유지한다", () => {
  const cart = fs.readFileSync(path.join(projectRoot, "js", "cart.js"), "utf8");
  const auth = fs.readFileSync(path.join(projectRoot, "js", "auth.js"), "utf8");
  const menu = fs.readFileSync(path.join(projectRoot, "js", "menu-order.js"), "utf8");
  const login = fs.readFileSync(path.join(projectRoot, "login.html"), "utf8");
  const guestOrder = fs.readFileSync(path.join(projectRoot, "guest-order.html"), "utf8");
  const guestLookup = fs.readFileSync(path.join(projectRoot, "guest-order-lookup.html"), "utf8");
  const home = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");

  assert.match(cart, /requirePurchaseAccess/);
  assert.match(cart, /hasValidGuestProfile/);
  assert.match(cart, /login\.html\?next=/);
  assert.match(login, /data-guest-checkout/);
  assert.match(login, /guest-order\.html/);
  assert.match(login, /guest-order-lookup\.html/);
  const customerCenter = fs.readFileSync(path.join(projectRoot, "faq.html"), "utf8");
  assert.match(customerCenter, /guest-order-lookup\.html/);
  assert.doesNotMatch(customerCenter, /data-inquiry-lookup-form/);
  assert.match(guestOrder, /data-guest-order-form/);
  assert.match(guestOrder, /name="customer"/);
  assert.match(guestOrder, /name="phone"/);
  assert.match(guestOrder, /data-guest-send-code/);
  assert.match(guestOrder, /data-guest-verify-code/);
  assert.match(guestOrder, /name="postalCode"/);
  assert.match(guestOrder, /name="addressDetail"/);
  assert.match(guestOrder, /name="guestPassword"/);
  assert.match(guestOrder, /name="guestPasswordConfirm"/);
  assert.match(guestLookup, /data-guest-order-lookup-form/);
  assert.match(auth, /\/api\/orders\/guest\/lookup/);
  assert.match(guestOrder, /name="agreePrivacy"/);
  assert.match(auth, /saveGuest\(/);
  assert.match(auth, /hasCartItems\(\)/);
  assert.match(auth, /checkout\.html/);
  assert.match(menu, /inquiry\.html\?product=/);
  assert.equal((home.match(/>전화 상담<\/a>/g) || []).length, 4);
});
