const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");

const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("단일 script.js와 styles.css 대신 역할별 모듈을 사용한다", () => {
  assert.ok(fs.statSync(path.join(root, "script.js")).size < 500);
  assert.ok(fs.statSync(path.join(root, "styles.css")).size < 1000);
  for (const file of ["api.js", "state.js", "utils.js", "search.js", "cart.js", "menu-order.js", "auth.js", "ui.js", "components.js"]) {
    assert.ok(fs.existsSync(path.join(root, "js", file)), `${file} 누락`);
  }
  for (const file of ["dashboard.js", "orders.js", "customers.js", "inventory.js", "suppliers.js", "accounting.js", "events.js"]) {
    assert.ok(fs.existsSync(path.join(root, "js", "admin", file)), `admin/${file} 누락`);
  }
});

test("일반 페이지는 관리자 모듈을 로드하지 않는다", () => {
  for (const file of ["index.html", "menu.html", "cart.html", "login.html", "guest-order.html", "guest-order-lookup.html", "inquiry.html", "signup.html", "mypage.html"]) {
    assert.doesNotMatch(read(file), /js\/admin\//, file);
  }
  assert.match(read("admin.html"), /js\/admin\/dashboard\.js/);
});

test("헤더·이벤트바·푸터는 공통 컴포넌트 자리표시자를 사용한다", () => {
  for (const file of ["index.html", "menu.html", "cart.html", "login.html", "guest-order.html", "guest-order-lookup.html", "inquiry.html", "signup.html", "faq.html", "mypage.html"]) {
    const html = read(file);
    assert.match(html, /data-shared-header/, file);
    assert.match(html, /data-shared-footer/, file);
    assert.doesNotMatch(html, /<footer class="site-footer">[\s\S]+?<strong>/, file);
  }
});

test("전역 제목 규칙과 브라우저 기본 alert·confirm 호출을 사용하지 않는다", () => {
  const css = fs.readdirSync(path.join(root, "css")).filter((file) => file.endsWith(".css")).map((file) => read("css", file)).join("\n");
  assert.doesNotMatch(css, /(?:^|\})\s*h1\s*\{/m);
  const sourceFiles = ["mypage.js", ...fs.readdirSync(path.join(root, "js")).filter((file) => file.endsWith(".js") && file !== "ui.js").map((file) => `js/${file}`),
    ...fs.readdirSync(path.join(root, "js", "admin")).map((file) => `js/admin/${file}`)];
  const source = sourceFiles.map((file) => read(...file.split("/"))).join("\n");
  assert.doesNotMatch(source, /(?<!AppUI\.)(?:window\.)?confirm\s*\(/);
  assert.doesNotMatch(source, /(?<!AppUI\.)alert\s*\(/);
});
