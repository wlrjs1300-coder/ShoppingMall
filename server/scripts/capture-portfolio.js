const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const chrome = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const baseUrl = process.env.CAPTURE_BASE_URL || "http://localhost:3000";
const outputDir = path.resolve(__dirname, "../../docs/images");
const port = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tteokjip-capture-"));
const browser = spawn(chrome, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pageTarget() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await wait(100);
  }
  throw new Error("Chrome 디버깅 연결에 실패했습니다.");
}

async function run() {
  const target = await pageTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36" });
  fs.mkdirSync(outputDir, { recursive: true });
  for (const capture of [{ page: "index.html", file: "mobile-home.png" }, { page: "menu.html", file: "mobile-menu.png" }]) {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
    await send("Page.navigate", { url: `${baseUrl}/${capture.page}?portfolioCapture=${Date.now()}` });
    await wait(1800);
    await send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
    await send("Page.bringToFront");
    await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    await wait(350);
    const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    fs.writeFileSync(path.join(outputDir, capture.file), Buffer.from(result.data, "base64"));
  }
  socket.close();
}

run().then(() => console.log("모바일 포트폴리오 캡처 완료")).catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  browser.kill();
  if (browser.exitCode === null) await Promise.race([once(browser, "exit"), wait(3000)]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await wait(250); }
  }
});
