(function exposeCartUtils(root, factory) {
  const utils = factory();
  if (typeof module === "object" && module.exports) module.exports = utils;
  if (root) root.CartUtils = utils;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCartUtils() {
  const initPwaScrollClass = () => {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const pwaQuery = window.matchMedia("(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)");
    const hasExplicitPwaParam = () => {
      const params = new URLSearchParams(window.location.search);
      const explicit = params.get("pwa");
      const mobile = params.get("mobile") === "1";
      const hideScrollbar = params.get("hide-scrollbar") === "1" || params.get("hide_scrollbar") === "1";
      return explicit === "1" || explicit === "true" || mobile || hideScrollbar;
    };
    const mobileViewport = () => window.matchMedia("(max-width: 820px)").matches;

    const applyPwaClass = () => {
      const isPwa = pwaQuery.matches
        || window.matchMedia("(display-mode: window-controls-overlay)").matches
        || Boolean(window.navigator?.standalone)
        || hasExplicitPwaParam()
        || mobileViewport();
      document.documentElement.classList.toggle("is-pwa", isPwa);
      document.body?.classList.toggle("is-pwa", isPwa);
      document.documentElement.classList.toggle("hide-scrollbars-mobile", isPwa);
      document.body?.classList.toggle("hide-scrollbars-mobile", isPwa);
    };

    applyPwaClass();
    if (pwaQuery.addEventListener) {
      pwaQuery.addEventListener("change", applyPwaClass);
    } else if (pwaQuery.addListener) {
      pwaQuery.addListener(applyPwaClass);
    }
  };

  initPwaScrollClass();

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

  function calculateMalTotal(quantity, halfMalPrice, malPrice) {
    const normalizedQuantity = normalizeQuantity(quantity, "mal");
    const fullMalCount = Math.floor(normalizedQuantity);
    const hasHalfMal = Math.abs(normalizedQuantity - fullMalCount - 0.5) < 1e-8;
    const fullPrice = Number(malPrice || 0);
    const halfPrice = Number(halfMalPrice || 0);
    if (fullPrice <= 0 || halfPrice <= 0) return 0;
    return (fullMalCount * fullPrice) + (hasHalfMal ? halfPrice : 0);
  }

  function calculateItemTotal(item) {
    const unit = parseQuantityUnit(item?.quantityUnit, item?.quantity);
    const quantity = normalizeQuantity(item?.quantity, unit);
    if (unit === "pack") return Math.round(Number(item?.price || 0) * quantity);
    const malPrice = Number(item?.malPrice ?? item?.price ?? 0);
    const halfMalPrice = Number(item?.halfMalPrice ?? (malPrice > 0 ? malPrice / 2 : 0));
    return Math.round(calculateMalTotal(quantity, halfMalPrice, malPrice));
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
      selectedPrice: selectedItems.reduce((sum, item) => sum + calculateItemTotal(item), 0),
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
          ? Number(product.malPrice ?? Math.round(Number(product.price) * (8000 / Number(product.unitWeightGrams || 250))))
          : Number(product.price),
        category: product.category,
        imageUrl: product.imageUrl,
      };
      if (product.unitWeightGrams != null) updated.unitWeightGrams = product.unitWeightGrams;
      if (product.halfMalWeightGrams != null) updated.halfMalWeightGrams = product.halfMalWeightGrams;
      if (product.malWeightGrams != null) updated.malWeightGrams = product.malWeightGrams;
      if (item.quantityUnit === "mal") {
        updated.halfMalPrice = Number(product.halfMalPrice ?? 0);
        updated.malPrice = Number(product.malPrice ?? 0);
      }
      if (updated.name !== item.name || updated.price !== Number(item.price)
        || updated.halfMalPrice !== item.halfMalPrice || updated.malPrice !== item.malPrice
        || updated.unitWeightGrams !== item.unitWeightGrams || updated.halfMalWeightGrams !== item.halfMalWeightGrams
        || updated.malWeightGrams !== item.malWeightGrams
        || updated.category !== item.category || updated.imageUrl !== item.imageUrl) {
        updatedCount += 1;
      }
      nextCart.push(updated);
    }
    return { cart: nextCart, removedCount, updatedCount };
  }

  return { addItem, calculateItemTotal, calculateMalTotal, parseCart, reconcileProducts, removeItem, removeItems, removeSelected, selectAll, serializeCart, setQuantity, setSelected, summarize };
});
