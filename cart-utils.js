(function exposeCartUtils(root, factory) {
  const utils = factory();
  if (typeof module === "object" && module.exports) module.exports = utils;
  if (root) root.CartUtils = utils;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCartUtils() {
  const MAX_QUANTITY = 99;
  const MAL_STEP = 0.5;
  const PACK_STEP = 1;
  const DEFAULT_UNIT = "pack";

  function parseQuantityUnit(value, quantity) {
    if (value === "mal" || value === "pack") return value;
    const numericQuantity = Number(quantity);
    if (Number.isFinite(numericQuantity) && numericQuantity % 1 !== 0) return "mal";
    return DEFAULT_UNIT;
  }

  function getStep(quantityUnit) {
    return quantityUnit === "pack" ? PACK_STEP : MAL_STEP;
  }

  function getMin(quantityUnit) {
    return quantityUnit === "pack" ? 1 : MAL_STEP;
  }

  function normalizeQuantity(value, quantityUnit = DEFAULT_UNIT) {
    const quantity = Number(value);
    const step = getStep(quantityUnit);
    const minQuantity = getMin(quantityUnit);
    if (!Number.isFinite(quantity)) return minQuantity;
    const snapped = Math.round(quantity / step) * step;
    return Math.min(MAX_QUANTITY, Math.max(minQuantity, snapped));
  }

  function parseCart(value) {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item) => item && typeof item.id === "string" && item.id.trim())
        .map((item) => ({
          ...item,
          quantityUnit: parseQuantityUnit(item.quantityUnit, item.quantity),
          quantity: normalizeQuantity(item.quantity, parseQuantityUnit(item.quantityUnit, item.quantity)),
        }));
    } catch {
      return [];
    }
  }

  function serializeCart(cart) {
    return JSON.stringify(parseCart(cart));
  }

  function addItem(cart, item) {
    const next = parseCart(cart);
    const quantityUnit = parseQuantityUnit(item?.quantityUnit, item?.quantity);
    if (!item?.id || !Number.isFinite(item.price) || item.price <= 0) return next;
    const existing = next.find((entry) => entry.id === item.id && entry.quantityUnit === quantityUnit);
    if (existing) {
      existing.quantity = normalizeQuantity(existing.quantity + getStep(quantityUnit), quantityUnit);
      if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
    } else {
      next.push({
        ...item,
        quantityUnit,
        quantity: getMin(quantityUnit),
      });
    }
    return next;
  }

  function setQuantity(cart, id, quantity, quantityUnit = DEFAULT_UNIT) {
    const normalizedUnit = parseQuantityUnit(quantityUnit);
    return parseCart(cart).map((item) => (item.id === id && item.quantityUnit === normalizedUnit
      ? { ...item, quantity: normalizeQuantity(quantity, normalizedUnit) }
      : item));
  }

  function setSelected(cart, id, selected) {
    return parseCart(cart).map((item) => (item.id === id
      ? { ...item, selected: Boolean(selected) }
      : item));
  }

  function selectAll(cart, selected) {
    return parseCart(cart).map((item) => ({ ...item, selected: Boolean(selected) }));
  }

  function removeItem(cart, id, quantityUnit = null) {
    return parseCart(cart).filter((item) => !(item.id === id && (quantityUnit ? item.quantityUnit === parseQuantityUnit(quantityUnit) : true)));
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
    const selectedTotalsByUnit = selectedItems.reduce((acc, item) => {
    const unit = parseQuantityUnit(item.quantityUnit, item.quantity);
      acc[unit] = (acc[unit] || 0) + Number(item.quantity || 0);
      return acc;
    }, {});
    return {
      itemCount: items.length,
      selectedItemCount: selectedItems.length,
      selectedQuantity: selectedItems.reduce((sum, item) => sum + item.quantity, 0),
      selectedMalQuantity: selectedTotalsByUnit.mal || 0,
      selectedPackQuantity: selectedTotalsByUnit.pack || 0,
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
        price: item.quantityUnit === "mal"
          ? Math.round(Number(product.price) * (8000 / Number(product.unitWeightGrams || 250)))
          : Number(product.price),
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
