const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("모바일 헤더는 접근 가능한 토글 메뉴를 제공한다", () => {
  const source = read("js/components.js");
  assert.match(source, /mobile-nav-toggle/);
  assert.match(source, /aria-expanded="false"/);
  assert.match(source, /aria-controls="site-navigation"/);
  assert.match(source, /event\.key === "Escape"/);
});

test("검색 패널은 키보드 이동, ESC, 최근 검색어 개별 삭제를 지원한다", () => {
  const source = read("js/search.js");
  assert.match(source, /ArrowDown/);
  assert.match(source, /ArrowUp/);
  assert.match(source, /Escape/);
  assert.match(source, /data-remove-recent/);
  assert.match(source, /추천 검색어/);
  assert.doesNotMatch(source, /인기 검색어/);
});

test("장바구니 삭제는 실행 취소를 제공한다", () => {
  const source = read("js/cart.js");
  assert.match(source, /offerCartUndo/);
  assert.match(source, /actionLabel: "실행 취소"/);
  assert.match(source, /writeCart\(previousCart\)/);
});

test("폼 오류와 모달에 접근성 포커스 처리가 연결되어 있다", () => {
  const auth = read("js/auth.js");
  const ui = read("js/ui.js");
  assert.match(auth, /aria-describedby/);
  assert.match(auth, /aria-invalid/);
  assert.match(ui, /event\.key !== "Tab"/);
  assert.match(ui, /returnFocus/);
  assert.match(ui, /aria-modal="true"/);
});

test("모바일 주문 버튼과 모션 감소 환경을 지원한다", () => {
  const commerce = read("css/commerce.css");
  const pages = read("css/pages.css");
  assert.match(commerce, /bottom:\s*0/);
  assert.match(commerce, /safe-area-inset-bottom/);
  assert.match(pages, /prefers-reduced-motion:\s*reduce/);
  assert.match(pages, /overflow-x:\s*clip/);
});

test("주요 고객 페이지는 한국어, viewport, 제목을 선언한다", () => {
  ["index.html", "menu.html", "cart.html", "checkout.html", "login.html", "guest-order.html", "guest-order-lookup.html", "inquiry.html", "signup.html", "mypage.html", "faq.html"].forEach((file) => {
    const html = read(file);
    assert.match(html, /<html lang="ko">/, file);
    assert.match(html, /name="viewport"/, file);
    assert.match(html, /<title>[^<]+<\/title>/, file);
  });
});

test("관리자 링크, 장바구니 종류 수, 마이페이지 탭 구조가 연결되어 있다", () => {
  const components = read("js/components.js");
  const auth = read("js/auth.js");
  const cart = read("js/cart.js");
  const mypage = read("mypage.html");
  const mypageScript = read("mypage.js");
  assert.match(components, /data-admin-link/);
  assert.match(components, /관리자 페이지/);
  assert.match(auth, /user\?\.role !== "admin"/);
  assert.match(cart, /new Set\(readCart\(\)\.map/);
  assert.match(cart, /장바구니.*\(\$\{count/);
  assert.equal((mypage.match(/role="tab"/g) || []).length, 5);
  assert.equal((mypage.match(/data-mypage-panel=/g) || []).length, 5);
  assert.match(mypage, /data-mypage-tab="inquiries"/);
  assert.match(mypageScript, /aria-selected/);
  assert.match(mypageScript, /ArrowRight/);
});
