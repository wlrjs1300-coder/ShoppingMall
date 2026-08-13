const { test, expect } = require("@playwright/test");

test("모바일에서 다른 페이지를 거쳐 홈으로 돌아와도 PWA 홈 UI를 유지한다", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "모바일 전용 회귀 테스트");

  await page.goto("/index.html?pwa=1");
  await page.goto("/menu.html");
  await page.locator(".brand").click();
  await expect(page).toHaveURL(/index\.html$/);

  await expect(page.locator("html")).toHaveClass(/is-pwa/);
  await expect(page.locator(".category-nav-number").first()).toBeHidden();
  await expect(page.locator(".hero-category-nav a").first()).toContainText("전체 메뉴");

  const bannerHeight = await page.locator(".hero-carousel").evaluate((element) => element.getBoundingClientRect().height);
  expect(bannerHeight).toBeGreaterThan(300);
});
