(() => {
  const form = document.querySelector("[data-inquiry-lookup-form]");
  const result = document.querySelector("[data-inquiry-lookup-result]");
  const message = document.querySelector("[data-inquiry-lookup-message]");
  if (!form || !result || !message) return;
  const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const formatDate = (value) => value ? new Date(value).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" }) : "-";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    result.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    try {
      const response = await fetch("/api/inquiries/guest/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      const item = body.inquiry;
      const answered = item.status === "답변완료" && item.adminReply;
      result.innerHTML = `<header><div><span>문의 상품</span><h2>${escape(item.productName)}</h2></div><b class="${answered ? "is-answered" : ""}">${escape(item.status || "접수")}</b></header><dl><div><dt>접수 일시</dt><dd>${formatDate(item.createdAt)}</dd></div><div><dt>희망 날짜</dt><dd>${escape(item.desiredDate || "미정")}</dd></div><div><dt>예상 수량</dt><dd>${Number(item.quantity || 0).toLocaleString("ko-KR")}개</dd></div></dl><section><span>내 문의</span><p>${escape(item.message)}</p></section>${answered ? `<section class="guest-inquiry-answer"><span>떡집 답변</span><p>${escape(item.adminReply)}</p><small>${formatDate(item.respondedAt)}</small></section>` : `<p class="guest-inquiry-pending">답변을 준비하고 있습니다. 잠시 후 다시 확인해 주세요.</p>`}`;
      result.hidden = false;
    } catch (error) {
      message.textContent = error.message || "문의 내역을 조회하지 못했습니다.";
    }
  });
})();
