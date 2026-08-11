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
