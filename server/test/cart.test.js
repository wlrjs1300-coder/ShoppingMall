const test = require("node:test");
const assert = require("node:assert/strict");
const cart = require("../../cart-utils");

const product = { id: "injeolmi", name: "인절미", price: 12000 };
const secondProduct = { id: "songpyeon", name: "송편", price: 15000 };

test("장바구니를 문자열로 저장하고 다시 안전하게 불러온다", () => {
  const stored = cart.serializeCart([{ ...product, quantity: 2 }]);
  assert.deepEqual(cart.parseCart(stored), [{ ...product, quantity: 2, quantityUnit: "pack" }]);
  assert.deepEqual(cart.parseCart("잘못된 JSON"), []);
});

test("같은 상품을 다시 담으면 수량이 증가하고 최대 99개로 제한된다", () => {
  assert.equal(cart.addItem([product], product)[0].quantity, 2);
  assert.equal(cart.addItem([{ ...product, quantity: 99 }], product)[0].quantity, 99);
  assert.equal(cart.setQuantity([product], product.id, 0)[0].quantity, 1);
});

test("상품 개별 선택과 전체 선택 상태를 변경한다", () => {
  const items = [product, secondProduct];
  const partlySelected = cart.setSelected(items, product.id, false);
  assert.equal(partlySelected[0].selected, false);
  assert.equal(partlySelected[1].selected, undefined);
  assert.ok(cart.selectAll(items, false).every((item) => item.selected === false));
});

test("개별 삭제와 선택 상품 삭제가 동작한다", () => {
  const items = [{ ...product, selected: true }, { ...secondProduct, selected: false }];
  assert.deepEqual(cart.removeItem(items, product.id).map((item) => item.id), [secondProduct.id]);
  assert.deepEqual(cart.removeSelected(items).map((item) => item.id), [secondProduct.id]);
});

test("주문 성공 상품만 장바구니에서 제거하고 미선택 상품은 유지한다", () => {
  const items = [{ ...product, selected: true }, { ...secondProduct, selected: false }];
  assert.deepEqual(cart.removeItems(items, [product.id]).map((item) => item.id), [secondProduct.id]);
});

test("선택 상품의 수량과 합계만 계산한다", () => {
  const summary = cart.summarize([
    { ...product, quantity: 2, selected: true },
    { ...secondProduct, quantity: 3, selected: false },
  ]);
  assert.deepEqual(summary, {
    itemCount: 2,
    selectedItemCount: 1,
    selectedQuantity: 2,
    selectedMalQuantity: 0,
    selectedPackQuantity: 2,
    selectedPrice: 24000,
  });
});

test("서버 상품 기준으로 가격을 갱신하고 판매중지 상품을 제거한다", () => {
  const result = cart.reconcileProducts(
    [
      { ...product, quantity: 2, price: 1 },
      { ...secondProduct, quantity: 1 },
    ],
    [
      { id: product.id, name: "새 인절미", category: "인절미", purchaseType: "direct", price: 13000, imageUrl: "new.jpg" },
    ],
  );
  assert.equal(result.removedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.deepEqual(result.cart, [{ id: product.id, name: "새 인절미", price: 13000, quantity: 2, quantityUnit: "pack", category: "인절미", imageUrl: "new.jpg" }]);
});

test("상담 전용 상품은 장바구니에서 주문 가능한 상품으로 유지하지 않는다", () => {
  const result = cart.reconcileProducts([product], [{ ...product, purchaseType: "consultation", price: null }]);
  assert.deepEqual(result.cart, []);
  assert.equal(result.removedCount, 1);
});
