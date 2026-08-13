const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("PWA 전용 스타일은 전역 진입점에서 별도 모듈로 불러온다", () => {
  const entry = read("styles.css");
  const pwa = read("css", "pwa-global.css");
  assert.match(entry, /@import url\("css\/pwa-global\.css\?v=1"\)/);
  assert.match(pwa, /\.is-pwa/);
  assert.match(pwa, /\.home-page \.home-hero/);
});

test("서비스 워커는 캐시에 없는 자산의 네트워크 실패에도 Response를 반환한다", () => {
  const worker = read("sw.js");
  assert.match(worker, /cached \|\| Response\.error\(\)/);
  assert.doesNotMatch(worker, /\.catch\(\(\) => cached\);/);
});

test("최종 PWA 화면은 갱신된 자산 URL과 서비스 워커 캐시를 사용한다", () => {
  const home = read("index.html");
  const admin = read("admin.html");
  const product = read("product.html");
  const worker = read("sw.js");

  assert.match(home, /data-pwa-mode-bootstrap/);
  assert.match(home, /matchMedia\("\(max-width: 820px\)"\)/);
  assert.match(home, /pwa-home-refresh\.css\?v=3/);
  assert.match(home, /pwa-home-refresh\.js\?v=3/);
  assert.match(admin, /pwa-admin-refresh\.css\?v=3/);
  assert.match(product, /pwa-product-refresh\.css\?v=4/);
  assert.match(worker, /CACHE_NAME = "tteokjip-v71"/);
});
