const { test, expect } = require("@playwright/test");

const guest = {
  customer: "테스트 고객",
  phone: "01012345678",
  address: "경기도 화성시 테스트로 1",
  password: "test1234",
};

test("반말 장바구니 금액이 주문서까지 동일하게 유지된다", async ({ page }) => {
  await page.addInitScript(({ guestProfile }) => {
    sessionStorage.setItem("tteokGuestCheckout", "true");
    sessionStorage.setItem("tteokGuestCustomer", JSON.stringify(guestProfile));
    localStorage.setItem("tteokShoppingCart", JSON.stringify([{
      id: "white-jeolpyeon",
      name: "흰절편",
      category: "기본떡",
      price: 112000,
      quantity: 0.5,
      quantityUnit: "mal",
      selected: true,
      imageUrl: "assets/products/menu-white-jeolpyeon.png",
    }]));
  }, { guestProfile: guest });

  await page.goto("/cart.html");
  await expect(page.locator("[data-cart-total-price]")).toHaveText("56,000원");
  await expect(page.locator("[data-cart-order-button]")).toHaveText("상품 주문하기");
  await page.locator("[data-cart-order-button]").click();
  await expect(page).toHaveURL(/checkout\.html/);
  await expect(page.locator("[data-checkout-total]")).toHaveText("56,000원");
  await expect(page.locator(".checkout-item")).toContainText("0.5 말");
});

test("사진이 첨부된 비회원 문의를 조회하고 확대할 수 있다", async ({ page }) => {
  await page.goto("/inquiry-lookup.html");
  await page.locator('input[name="id"]').fill("inquiry-demo-guest-20260722");
  await page.locator('input[name="phone"]').fill("01048271635");
  await page.locator('[data-inquiry-lookup-form] button[type="submit"]').click();

  const result = page.locator("[data-inquiry-lookup-result]");
  await expect(result).toBeVisible();
  await expect(result.locator(".guest-inquiry-photos img")).toHaveCount(3);
  await result.locator(".guest-inquiry-photos button").first().click();
  await expect(page.locator(".guest-inquiry-photo-dialog")).toBeVisible();
});

test("고객센터 문의 이동과 상품 배송 절차가 연결되어 있다", async ({ page }) => {
  await page.goto("/faq.html");
  const inquiryButton = page.locator("[data-open-inquiry-tab]").first();
  await expect(inquiryButton).toHaveText("문의하기");
  await inquiryButton.click();
  await expect(page).toHaveURL(/inquiry\.html/);

  await page.goto("/product.html?id=white-jeolpyeon");
  await expect(page.locator(".product-delivery-flow span")).toHaveCount(4);
  await expect(page.locator(".product-delivery-flow")).toContainText("주문 완료");
  await expect(page.locator(".product-delivery-flow")).toContainText("배송 완료");
});
