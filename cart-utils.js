(function exposeCartUtils(root, factory) {
  const utils = factory();
  if (typeof module === "object" && module.exports) module.exports = utils;
  if (root) root.CartUtils = utils;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCartUtils() {
  const MAX_QUANTITY = 99;

  function normalizeQuantity(value) {
    const quantity = Number.parseInt(value, 10);
    if (!Number.isFinite(quantity)) return 1;
    return Math.min(MAX_QUANTITY, Math.max(1, quantity));
  }

  function parseCart(value) {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item) => item && typeof item.id === "string" && item.id.trim())
        .map((item) => ({ ...item, quantity: normalizeQuantity(item.quantity) }));
    } catch {
      return [];
    }
  }

  function serializeCart(cart) {
    return JSON.stringify(parseCart(cart));
  }

  function addItem(cart, item) {
    const next = parseCart(cart);
    if (!item?.id || !Number.isFinite(item.price) || item.price <= 0) return next;
    const existing = next.find((entry) => entry.id === item.id);
    if (existing) {
      existing.quantity = normalizeQuantity(existing.quantity + 1);
      if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
    } else {
      next.push({ ...item, quantity: 1 });
    }
    return next;
  }

  function setQuantity(cart, id, quantity) {
    return parseCart(cart).map((item) => item.id === id ? { ...item, quantity: normalizeQuantity(quantity) } : item);
  }

  function setSelected(cart, id, selected) {
    return parseCart(cart).map((item) => item.id === id ? { ...item, selected: Boolean(selected) } : item);
  }

  function selectAll(cart, selected) {
    return parseCart(cart).map((item) => ({ ...item, selected: Boolean(selected) }));
  }

  function removeItem(cart, id) {
    return parseCart(cart).filter((item) => item.id !== id);
  }

  function removeItems(cart, ids) {
    const removedIds = new Set(Array.isArray(ids) ? ids : []);
    return parseCart(cart).filter((item) => !removedIds.has(item.id));
  }

  function removeSelected(cart) {
    return parseCart(cart).filter((item) => item.selected === false);
  }

  function summarize(cart) {
    const items = parseCart(cart);
    const selectedItems = items.filter((item) => item.selected !== false);
    return {
      itemCount: items.length,
      selectedItemCount: selectedItems.length,
      selectedQuantity: selectedItems.reduce((sum, item) => sum + item.quantity, 0),
      selectedPrice: selectedItems.reduce((sum, item) => sum + Number(item.price || 0) * item.quantity, 0),
    };
  }

  function reconcileProducts(cart, products) {
    const productMap = new Map(
      (Array.isArray(products) ? products : [])
        .filter((product) => product?.id && product.purchaseType === "direct" && Number(product.price) > 0)
        .map((product) => [product.id, product]),
    );
    let removedCount = 0;
    let updatedCount = 0;
    const nextCart = [];

    for (const item of parseCart(cart)) {
      const product = productMap.get(item.id);
      if (!product) {
        removedCount += 1;
        continue;
      }
      const updated = {
        ...item,
        name: product.name,
        price: Number(product.price),
        category: product.category,
        imageUrl: product.imageUrl,
      };
      if (updated.name !== item.name || updated.price !== Number(item.price) || updated.category !== item.category || updated.imageUrl !== item.imageUrl) {
        updatedCount += 1;
      }
      nextCart.push(updated);
    }
    return { cart: nextCart, removedCount, updatedCount };
  }

  return { addItem, parseCart, reconcileProducts, removeItem, removeItems, removeSelected, selectAll, serializeCart, setQuantity, setSelected, summarize };
});
