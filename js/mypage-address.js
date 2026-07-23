(function initMyPageAddressSearch() {
  const searchButton = document.querySelector("[data-mypage-address-search]");
  const form = document.querySelector("[data-address-form]");
  const message = document.querySelector("[data-address-message]");
  if (!searchButton || !form || !message) return;

  searchButton.addEventListener("click", () => {
    message.classList.remove("is-success");
    if (!window.PostcodeModal) {
      message.textContent = "주소 검색 화면을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.";
      return;
    }
    window.PostcodeModal.open((data) => {
      form.elements.postalCode.value = data.zonecode;
      form.elements.address.value = data.address;
      message.classList.add("is-success");
      message.textContent = "주소가 입력되었습니다. 상세 주소를 확인해 주세요.";
      form.elements.addressDetail.focus();
    });
  });
})();
