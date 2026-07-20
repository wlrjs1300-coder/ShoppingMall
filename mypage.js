(function initMyPage() {
  const api = async (path, options = {}) => {
    const response = await fetch(`/api/users${path}`, {
      method: options.method || "GET", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (response.status === 401) { location.replace(`login.html?next=${encodeURIComponent("mypage.html")}`); throw new Error("로그인이 필요합니다."); }
    if (!response.ok) throw new Error(body?.error || "요청을 처리하지 못했습니다.");
    return body;
  };
  const won = (value) => `${Number(value || 0).toLocaleString("ko-KR")}원`;
  const date = (value) => value ? new Date(value).toLocaleDateString("ko-KR") : "-";
  const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const message = (selector, text, success = false) => { const el = document.querySelector(selector); el.textContent = text; el.classList.toggle("is-success", success); };
  const inquiryApi = async (path, options = {}) => {
    const response = await fetch(`/api/inquiries${path}`, { method: options.method || "GET", credentials: "same-origin", headers: { "Content-Type": "application/json" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "문의 내역을 불러오지 못했습니다.");
    return body;
  };
  let memberInquiries = [];

  function renderInquiries(inquiries) {
    const list = document.querySelector("[data-member-inquiries]");
    const empty = document.querySelector("[data-inquiries-empty]");
    if (!list || !empty) return;
    empty.hidden = inquiries.length > 0;
    list.innerHTML = inquiries.map((item) => {
      const answered = item.status === "답변완료" && item.adminReply;
      const unread = answered && !item.readAt;
      return `<article class="mypage-inquiry-card ${unread ? "is-unread" : ""}"><header><div><h3>${escape(item.productName)}</h3><span class="inquiry-member-status ${answered ? "is-answered" : ""}">${escape(item.status || "접수")}</span></div><time>${date(item.createdAt)}</time></header><p class="mypage-inquiry-question">${escape(item.message)}</p>${answered ? `<div class="mypage-inquiry-answer"><span>SHOP REPLY</span><p>${escape(item.adminReply)}</p></div>` : `<p class="mypage-inquiry-waiting">답변을 준비하고 있습니다.</p>`}</article>`;
    }).join("");
    const count = inquiries.filter((item) => item.status === "답변완료" && item.adminReply && !item.readAt).length;
    const badge = document.querySelector("[data-mypage-inquiry-count]");
    if (badge) { badge.textContent = String(count); badge.hidden = !count; }
  }

  const mypageTabs = [...document.querySelectorAll("[data-mypage-tab]")];
  const mypagePanels = [...document.querySelectorAll("[data-mypage-panel]")];
  const activateMyPageTab = (tabName, updateUrl = true) => {
    const selectedTab = mypageTabs.find((tab) => tab.dataset.mypageTab === tabName) || mypageTabs[0];
    if (!selectedTab) return;
    mypageTabs.forEach((tab) => {
      const active = tab === selectedTab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    mypagePanels.forEach((panel) => { panel.hidden = panel.dataset.mypagePanel !== selectedTab.dataset.mypageTab; });
    if (updateUrl) history.replaceState(null, "", `#${selectedTab.dataset.mypageTab}`);
    if (selectedTab.dataset.mypageTab === "inquiries" && memberInquiries.some((item) => item.status === "답변완료" && item.adminReply && !item.readAt)) {
      inquiryApi("/mine/read", { method: "POST" }).then(() => {
        memberInquiries = memberInquiries.map((item) => ({ ...item, readAt: item.status === "답변완료" && item.adminReply ? new Date().toISOString() : item.readAt }));
        renderInquiries(memberInquiries);
        document.querySelectorAll("[data-inquiry-unread]").forEach((node) => { node.hidden = true; });
      }).catch(() => {});
    }
  };
  document.querySelector(".mypage-nav")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-mypage-tab]");
    if (tab) activateMyPageTab(tab.dataset.mypageTab);
  });
  document.querySelector(".mypage-nav")?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, mypageTabs.indexOf(document.activeElement));
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? mypageTabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + mypageTabs.length) % mypageTabs.length;
    mypageTabs[nextIndex].focus();
    activateMyPageTab(mypageTabs[nextIndex].dataset.mypageTab);
  });
  activateMyPageTab(location.hash.slice(1), false);

  function renderOrders(orders) {
    const list = document.querySelector("[data-member-orders]");
    document.querySelector("[data-orders-empty]").hidden = orders.length > 0;
    list.innerHTML = orders.map((order) => `<article class="member-order-card" data-order-id="${escape(order.id)}">
      <div class="member-order-meta"><span>${date(order.createdAt)}</span><b class="order-status">${escape(order.status)}</b></div>
      <div class="member-order-main"><div><strong>${escape(order.productSummary)}</strong><span>${order.items.reduce((sum, item) => sum + item.quantity, 0)}개 · ${order.fulfillmentType === "delivery" ? "배송" : "픽업"}</span></div><b>${won(order.totalAmount)}</b></div>
      <div class="member-order-actions"><button type="button" data-order-detail-button>상세 보기</button>${order.cancelable ? `<button class="is-danger" type="button" data-order-cancel-button>주문 취소</button>` : ""}</div>
    </article>`).join("");
  }

  async function loadOrders() { const body = await api("/me/orders"); renderOrders(body.orders); }

  document.querySelector("[data-member-orders]").addEventListener("click", async (event) => {
    const card = event.target.closest("[data-order-id]"); if (!card) return;
    if (event.target.closest("[data-order-detail-button]")) {
      try {
        const { order } = await api(`/me/orders/${encodeURIComponent(card.dataset.orderId)}`);
        document.querySelector("[data-order-detail]").innerHTML = `<span class="dialog-eyebrow">ORDER DETAIL</span><h2>${escape(order.productSummary)}</h2><dl class="order-detail-list"><div><dt>주문 상태</dt><dd>${escape(order.status)}</dd></div><div><dt>수령 예정</dt><dd>${escape([order.pickupDate, order.pickupTime].filter(Boolean).join(" ") || "-")}</dd></div><div><dt>수령 방식</dt><dd>${order.fulfillmentType === "delivery" ? "배송" : "픽업"}</dd></div>${order.deliveryAddress ? `<div><dt>배송지</dt><dd>${escape(order.deliveryAddress)}</dd></div>` : ""}</dl><ul class="order-detail-items">${order.items.map((item) => `<li><span>${escape(item.productName)} × ${item.quantity}</span><b>${won(item.lineTotal)}</b></li>`).join("")}</ul><div class="order-detail-total"><span>총 결제 금액</span><b>${won(order.totalAmount)}</b></div>`;
        document.querySelector("[data-order-dialog]").showModal();
      } catch (error) { AppUI.alert(error.message); }
    }
    if (event.target.closest("[data-order-cancel-button]") && await AppUI.confirm("이 주문을 취소할까요? 취소 후 되돌릴 수 없습니다.")) {
      try { await api(`/me/orders/${encodeURIComponent(card.dataset.orderId)}/cancel`, { method: "POST" }); await loadOrders(); }
      catch (error) { AppUI.alert(error.message); }
    }
  });
  document.querySelector("[data-dialog-close]").addEventListener("click", () => document.querySelector("[data-order-dialog]").close());

  document.querySelector("[data-profile-form]").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    try { await api("/me/profile", { method: "PATCH", body: { name: form.name.value, phone: form.phone.value, marketingConsent: form.marketingConsent.checked } }); message("[data-profile-message]", "회원 정보가 저장되었습니다.", true); document.querySelector("[data-member-name]").textContent = form.name.value.trim(); }
    catch (error) { message("[data-profile-message]", error.message); }
  });
  document.querySelector("[data-address-form]").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form));
    try { await api("/me/address", { method: "PATCH", body }); message("[data-address-message]", "기본 배송지가 저장되었습니다.", true); }
    catch (error) { message("[data-address-message]", error.message); }
  });
  document.querySelector("[data-password-form]").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    if (form.newPassword.value !== form.confirmPassword.value) return message("[data-password-message]", "새 비밀번호가 일치하지 않습니다.");
    try { await api("/me/password", { method: "POST", body: { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value } }); form.reset(); message("[data-password-message]", "비밀번호가 변경되었습니다.", true); }
    catch (error) { message("[data-password-message]", error.message); }
  });
  document.querySelector("[data-withdraw-button]").addEventListener("click", async () => {
    const password = prompt("탈퇴하려면 현재 비밀번호를 입력해 주세요."); if (!password) return;
    if (!await AppUI.confirm("정말 회원 탈퇴하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) return;
    try { await api("/me", { method: "DELETE", body: { password } }); location.replace("index.html?withdrawn=1"); }
    catch (error) { AppUI.alert(error.message); }
  });

  Promise.all([api("/me"), api("/me/address"), api("/me/orders"), api("/me/social-identities"), inquiryApi("/mine")]).then(([me, addressBody, orderBody, socialBody, inquiryBody]) => {
    const user = me.user; const profile = document.querySelector("[data-profile-form]");
    document.querySelector("[data-member-name]").textContent = user.name;
    document.querySelector("[data-member-since]").textContent = date(user.createdAt);
    const adminLink = document.querySelector("[data-mypage-admin-link]");
    if (adminLink) {
      adminLink.hidden = user.role !== "admin";
      if (adminLink.hidden) fetch("/api/users/admin-session", { method: "POST", credentials: "same-origin" })
        .then((response) => { if (response.ok) adminLink.hidden = false; })
        .catch(() => {});
    }
    profile.username.value = user.username || ""; profile.email.value = user.email; profile.name.value = user.name; profile.phone.value = user.phone; profile.marketingConsent.checked = user.marketingConsent;
    const address = addressBody.address; if (address) { const form = document.querySelector("[data-address-form]"); Object.entries(address).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value || ""; }); }
    renderOrders(orderBody.orders);
    memberInquiries = inquiryBody.inquiries || [];
    renderInquiries(memberInquiries);
    if (location.hash.slice(1) === "inquiries") activateMyPageTab("inquiries", false);
    const labels = { kakao: "카카오", naver: "네이버", google: "Google" };
    const icons = {
      kakao: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 5C8.8 5 3 9.5 3 15c0 3.6 2.5 6.8 6.3 8.5l-1.2 4.2c-.1.4.4.7.7.5l5.1-3.4c.7.1 1.4.2 2.1.2 7.2 0 13-4.5 13-10S23.2 5 16 5Z"/></svg>',
      naver: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 7h6.4l5.2 7.6V7H25v18h-6.4l-5.2-7.6V25H7V7Z"/></svg>',
      google: '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#4285F4" d="M27.6 16.3c0-.9-.1-1.7-.2-2.5H16v4.7h6.5a5.6 5.6 0 0 1-2.4 3.6v3.1H24c2.3-2.1 3.6-5.2 3.6-8.9Z"/><path fill="#34A853" d="M16 28c3.2 0 5.9-1.1 7.9-2.8L20 22.1c-1.1.7-2.5 1.2-4 1.2-3.1 0-5.8-2.1-6.7-5H5.2v3.2A12 12 0 0 0 16 28Z"/><path fill="#FBBC05" d="M9.3 18.3A7.2 7.2 0 0 1 9 16c0-.8.1-1.6.4-2.3v-3.2H5.2A12 12 0 0 0 4 16c0 2 .5 3.9 1.3 5.5l4-3.2Z"/><path fill="#EA4335" d="M16 8.7c1.8 0 3.4.6 4.7 1.8L24.2 7A11.8 11.8 0 0 0 16 4 12 12 0 0 0 5.2 10.5l4.1 3.2c1-2.9 3.6-5 6.7-5Z"/></svg>',
    };
    document.querySelector("[data-social-identities]").innerHTML = socialBody.providers.map((item) => `<li class="is-${item.provider}"><b><i class="social-brand-icon">${icons[item.provider]}</i>${labels[item.provider]}</b><span class="${item.connected ? "is-connected" : ""}">${item.connected ? "연결됨" : "연결 안 됨"}</span></li>`).join("");
    document.querySelector("[data-mypage-loading]").hidden = true; document.querySelector("[data-mypage-shell]").hidden = false;
  }).catch((error) => { if (!String(error.message).includes("로그인")) document.querySelector("[data-mypage-loading]").textContent = error.message; });
})();
