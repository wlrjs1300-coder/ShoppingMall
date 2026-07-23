(function initPostcodeModal() {
  let activeCallback = null;
  let dialog = null;
  let postcodeLoader = null;

  const loadPostcodeApi = () => {
    const existingApi = window.kakao?.Postcode || window.daum?.Postcode;
    if (existingApi) return Promise.resolve(existingApi);
    if (postcodeLoader) return postcodeLoader;
    postcodeLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
      script.async = true;
      script.onload = () => {
        const Postcode = window.kakao?.Postcode || window.daum?.Postcode;
        if (Postcode) resolve(Postcode);
        else reject(new Error("주소 검색 API를 초기화하지 못했습니다."));
      };
      script.onerror = () => reject(new Error("주소 검색 API를 불러오지 못했습니다."));
      document.head.appendChild(script);
    });
    return postcodeLoader;
  };

  const ensureDialog = () => {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.className = "postcode-modal";
    dialog.setAttribute("aria-label", "배송지 주소 검색");
    dialog.innerHTML = `
      <div class="postcode-modal-head">
        <div><small>ADDRESS SEARCH</small><strong>배송지 주소 검색</strong></div>
        <button type="button" data-postcode-modal-close aria-label="주소 검색 닫기">×</button>
      </div>
      <div class="postcode-modal-body" data-postcode-modal-body>
        <div class="postcode-modal-loading">주소 검색을 불러오고 있습니다.</div>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector("[data-postcode-modal-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      activeCallback = null;
      dialog.querySelector("[data-postcode-modal-body]").innerHTML = '<div class="postcode-modal-loading">주소 검색을 불러오고 있습니다.</div>';
      document.documentElement.classList.remove("is-modal-open");
    });
    dialog.addEventListener("cancel", () => document.documentElement.classList.remove("is-modal-open"));
    return dialog;
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== "tteok-postcode-selected") return;
  });

  window.PostcodeModal = {
    async open(oncomplete) {
      const modal = ensureDialog();
      activeCallback = typeof oncomplete === "function" ? oncomplete : null;
      const root = modal.querySelector("[data-postcode-modal-body]");
      document.documentElement.classList.add("is-modal-open");
      if (!modal.open) modal.showModal();
      try {
        const Postcode = await loadPostcodeApi();
        root.innerHTML = "";
        new Postcode({
          oncomplete(data) {
            activeCallback?.({
              zonecode: data.zonecode || "",
              address: data.roadAddress || data.jibunAddress || data.address || "",
            });
            if (modal.open) modal.close();
          },
          width: "100%",
          height: "100%",
        }).embed(root);
      } catch (error) {
        root.innerHTML = `<div class="postcode-modal-error"><strong>주소 검색을 불러오지 못했습니다.</strong><span>${error.message || "잠시 후 다시 시도해 주세요."}</span></div>`;
      }
    },
  };
})();
