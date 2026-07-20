(async function initPostcodePopup() {
  const root = document.getElementById("postcode-root");
  const postcodeApi = window.daum?.Postcode || window.kakao?.Postcode;
  if (!postcodeApi) {
    // 이전 서비스 워커가 외부 Daum 스크립트를 가로챈 경우 한 번만 정리하고 재시도한다.
    const retryKey = "tteok-postcode-sw-retry";
    if ("serviceWorker" in navigator && !sessionStorage.getItem(retryKey)) {
      sessionStorage.setItem(retryKey, "1");
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      window.location.reload();
      return;
    }
    root.innerHTML = '<div class="postcode-error">주소 검색 서비스를 불러오지 못했습니다.<br />창을 닫고 다시 시도해 주세요.</div>';
    return;
  }
  sessionStorage.removeItem("tteok-postcode-sw-retry");
  root.innerHTML = "";
  new postcodeApi({
    oncomplete(data) {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({
          type: "tteok-postcode-selected",
          zonecode: data.zonecode || "",
          address: data.roadAddress || data.jibunAddress || data.address || "",
        }, window.location.origin);
      }
      window.close();
    },
    width: "100%",
    height: "100%",
  }).embed(root);
})();
