(function initMyPageAddressSearch() {
  const searchButton = document.querySelector("[data-mypage-address-search]");
  const form = document.querySelector("[data-address-form]");
  const message = document.querySelector("[data-address-message]");
  if (!searchButton || !form || !message) return;

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== "tteok-postcode-selected") return;
    form.elements.postalCode.value = event.data.zonecode || "";
    form.elements.address.value = event.data.address || "";
    message.classList.add("is-success");
    message.textContent = "주소가 입력되었습니다. 상세 주소를 확인해 주세요.";
    form.elements.addressDetail.focus();
  });

  searchButton.addEventListener("click", () => {
    message.classList.remove("is-success");
    const width = 500;
    const height = 620;
    const left = Math.max(0, Math.round((screen.width - width) / 2));
    const top = Math.max(0, Math.round((screen.height - height) / 2));
    const popup = window.open("postcode.html", "tteokPostcode", `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no`);
    if (!popup) {
      message.textContent = "주소 검색 팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.";
      return;
    }
    message.textContent = "주소 검색 창을 열었습니다.";
    popup.focus();
  });
})();
