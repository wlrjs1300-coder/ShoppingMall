(function createAppUI(global) {
  const enhancedDialogs = new WeakSet();

  function enhanceDialog(dialog) {
    if (!dialog || enhancedDialogs.has(dialog)) return dialog;
    enhancedDialogs.add(dialog);
    let returnFocus = null;
    const originalShowModal = dialog.showModal.bind(dialog);
    dialog.showModal = () => {
      returnFocus = document.activeElement;
      originalShowModal();
      document.body.classList.add("has-open-dialog");
      requestAnimationFrame(() => dialog.querySelector("[autofocus], button, input, select, textarea, a[href]")?.focus());
    };
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    dialog.addEventListener("close", () => {
      if (!document.querySelector("dialog[open]")) document.body.classList.remove("has-open-dialog");
      if (returnFocus?.isConnected) returnFocus.focus();
    });
    return dialog;
  }

  function ensureRoot() {
    let root = document.querySelector("[data-app-ui-root]");
    if (root) return root;
    root = document.createElement("div");
    root.dataset.appUiRoot = "";
    root.innerHTML = `<div class="app-toast-region" aria-live="polite" aria-atomic="true"></div><dialog class="app-confirm-dialog" aria-modal="true"><form method="dialog"><h2 data-dialog-title>확인</h2><p data-dialog-message></p><div><button value="cancel" class="is-muted">취소</button><button value="confirm" class="is-primary">확인</button></div></form></dialog>`;
    document.body.append(root);
    enhanceDialog(root.querySelector("dialog"));
    return root;
  }

  function toast(message, type = "info", options = {}) {
    if (typeof type === "object") { options = type; type = options.type || "info"; }
    const region = ensureRoot().querySelector(".app-toast-region");
    const item = document.createElement("div");
    item.className = `app-toast is-${type}`;
    const label = document.createElement("span");
    label.textContent = String(message);
    item.append(label);
    if (options.actionLabel && typeof options.onAction === "function") {
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = options.actionLabel;
      action.addEventListener("click", () => { options.onAction(); item.remove(); }, { once: true });
      item.append(action);
    }
    region.append(item);
    requestAnimationFrame(() => item.classList.add("is-visible"));
    const timer = setTimeout(() => { item.classList.remove("is-visible"); setTimeout(() => item.remove(), 220); }, options.duration || 5000);
    item.addEventListener("click", (event) => { if (event.target.matches("button")) clearTimeout(timer); });
  }

  function alert(message) { toast(message, "error"); }
  function confirm(message, options = {}) {
    const dialog = enhanceDialog(ensureRoot().querySelector(".app-confirm-dialog"));
    dialog.querySelector("[data-dialog-title]").textContent = options.title || "확인해 주세요";
    dialog.querySelector("[data-dialog-message]").textContent = String(message);
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
  }

  document.querySelectorAll("dialog").forEach(enhanceDialog);
  global.AppUI = { alert, confirm, toast, enhanceDialog };
  global.alert = alert;
})(window);
