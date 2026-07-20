(function initSharedComponents() {
  const tickerItems = ["🎉 명절 송편 예약, 지금 신청하면 안심입니다 · 수량 한정", "🎁 답례떡·단체주문 상담 시 시식 쿠폰 증정", "👶 백일·돌잡이 떡 상담, 이번 달 예약 마감 임박", "🚚 동탄 지역 당일 픽업 가능 · 전화 상담 환영"];
  document.querySelectorAll(".event-ticker-track").forEach((track) => {
    track.innerHTML = [...tickerItems, ...tickerItems].map((item, index) => `<span ${index >= tickerItems.length ? 'aria-hidden="true"' : ""}>${item}</span>`).join("");
  });
  document.querySelectorAll("[data-shared-ticker]").forEach((ticker) => {
    ticker.innerHTML = `<span class="event-ticker-label">EVENT</span><div class="event-ticker-viewport"><div class="event-ticker-track">${[...tickerItems, ...tickerItems].map((item, index) => `<span ${index >= tickerItems.length ? 'aria-hidden="true"' : ""}>${item}</span>`).join("")}</div></div>`;
  });
  document.querySelectorAll(".site-footer").forEach((footer) => {
    footer.dataset.sharedComponent = "footer";
    footer.innerHTML = `<div><strong class="js-store-name">${siteInfo.name || "따뜻한 떡집"}</strong><span class="js-address-text">${siteInfo.address}</span><span class="footer-policy-links"><a href="terms.html">이용약관</a><a href="privacy.html">개인정보 처리방침</a></span></div><div><span class="js-phone-text">${siteInfo.phone}</span><span class="js-hours-text">${siteInfo.hours}</span><span class="footer-actions"><a class="js-phone-link" href="${phoneHref}">전화 상담</a><a class="js-map-link" href="${mapUrl}" target="_blank" rel="noreferrer">지도 보기</a></span></div>`;
  });
  document.querySelectorAll(".site-header").forEach((header) => {
    header.dataset.sharedComponent = "header";
    const page = location.pathname.split("/").pop() || "index.html";
    header.innerHTML = `<a class="brand" href="index.html" aria-label="따뜻한 떡집 홈"><img class="brand-logo" src="assets/logo.svg" alt="따뜻한 떡집" /></a><button class="mobile-nav-toggle" type="button" aria-expanded="false" aria-controls="site-navigation"><span></span><span></span><span></span><span class="sr-only">메뉴 열기</span></button><form class="header-search" role="search" action="menu.html" method="get"><input type="search" id="menuSearch" name="q" placeholder="메뉴 검색" aria-label="메뉴 검색" autocomplete="off" /><button type="submit" aria-label="검색"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button></form><nav class="header-actions" id="site-navigation" aria-label="주요 메뉴"><a class="header-text-link ${page === "signup.html" || page === "mypage.html" ? "is-current" : ""}" data-auth-signup-link href="signup.html">회원가입</a><a class="header-text-link ${page === "login.html" ? "is-current" : ""}" data-auth-login-link href="login.html">로그인</a><a class="header-text-link ${page === "admin.html" ? "is-current" : ""}" data-admin-link href="admin.html" hidden>관리자</a><a class="header-text-link ${page === "faq.html" ? "is-current" : ""}" href="faq.html">고객센터</a><a class="header-text-link ${page === "cart.html" ? "is-current" : ""}" href="cart.html">장바구니</a></nav>`;

    const toggle = header.querySelector(".mobile-nav-toggle");
    const navigation = header.querySelector(".header-actions");
    const adminLink = navigation.querySelector("[data-admin-link]");
    const memberLink = navigation.querySelector("[data-auth-signup-link]");
    if (adminLink && memberLink) {
      adminLink.textContent = "관리자 페이지";
      navigation.insertBefore(adminLink, memberLink);
    }
    const closeNavigation = () => {
      toggle.setAttribute("aria-expanded", "false");
      toggle.querySelector(".sr-only").textContent = "메뉴 열기";
      navigation.classList.remove("is-open");
    };
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector(".sr-only").textContent = open ? "메뉴 닫기" : "메뉴 열기";
      navigation.classList.toggle("is-open", open);
      if (open) navigation.querySelector("a")?.focus();
    });
    navigation.addEventListener("click", (event) => { if (event.target.closest("a")) closeNavigation(); });
    header.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeNavigation(); toggle.focus(); } });
    document.addEventListener("click", (event) => { if (!header.contains(event.target)) closeNavigation(); });
  });
  applySiteInfo();
})();
