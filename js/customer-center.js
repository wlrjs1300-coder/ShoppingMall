(() => {
  const memberArea = document.querySelector("[data-customer-member-inquiries]");
  const list = document.querySelector("[data-customer-inquiry-list]");
  const empty = document.querySelector("[data-customer-inquiry-empty]");
  if (!memberArea) return;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const formatDate = (value) => value ? new Date(value).toLocaleDateString("ko-KR") : "-";
  const render = (inquiries) => {
    const recent = inquiries.slice(0, 3);
    empty.hidden = recent.length > 0;
    list.innerHTML = recent.map((item) => {
      const answered = item.status === "답변완료" && item.adminReply;
      return `<article class="mypage-inquiry-card ${answered && !item.readAt ? "is-unread" : ""}"><header><div><h3>${escapeHtml(item.productName)}</h3><span class="inquiry-member-status ${answered ? "is-answered" : ""}">${escapeHtml(item.status || "접수")}</span></div><time>${formatDate(item.createdAt)}</time></header><p class="mypage-inquiry-question">${escapeHtml(item.message)}</p>${answered ? `<div class="mypage-inquiry-answer"><span>SHOP REPLY</span><p>${escapeHtml(item.adminReply)}</p></div>` : `<p class="mypage-inquiry-waiting">답변을 준비하고 있습니다.</p>`}</article>`;
    }).join("");
  };

  fetch("/api/users/me", { credentials: "same-origin" })
    .then((response) => response.ok ? response.json() : null)
    .then(async (body) => {
      const isMember = Boolean(body?.user && body.user.role !== "admin");
      memberArea.hidden = !isMember;
      if (!isMember) return;
      const response = await fetch("/api/inquiries/mine", { credentials: "same-origin" });
      const data = response.ok ? await response.json() : { inquiries: [] };
      render(data.inquiries || []);
    })
    .catch(() => { memberArea.hidden = true; });
})();
