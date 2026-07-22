(() => {
  const form = document.querySelector("[data-inquiry-lookup-form]");
  const result = document.querySelector("[data-inquiry-lookup-result]");
  const message = document.querySelector("[data-inquiry-lookup-message]");
  const submitButton = form?.querySelector('[type="submit"]');
  if (!form || !result || !message) return;
  const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const formatDate = (value) => value ? new Date(value).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" }) : "-";
  const photoDialog = document.createElement("dialog");
  photoDialog.className = "guest-inquiry-photo-dialog";
  photoDialog.innerHTML = `<button type="button" aria-label="사진 닫기">×</button><img alt="확대된 문의 첨부 사진" />`;
  document.body.appendChild(photoDialog);
  photoDialog.querySelector("button").addEventListener("click", () => photoDialog.close());
  photoDialog.addEventListener("click", (event) => { if (event.target === photoDialog) photoDialog.close(); });
  result.addEventListener("click", (event) => {
    const image = event.target.closest(".guest-inquiry-photos img");
    if (!image) return;
    photoDialog.querySelector("img").src = image.src;
    photoDialog.showModal();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    result.hidden = true;
    submitButton.disabled = true;
    submitButton.classList.add("is-loading");
    submitButton.textContent = "조회하고 있습니다...";
    const data = Object.fromEntries(new FormData(form));
    try {
      const response = await fetch("/api/inquiries/guest/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      const item = body.inquiry;
      const answered = item.status === "답변완료" && item.adminReply;
      const photos = Array.isArray(item.photos) ? item.photos.slice(0, 3) : [];
      result.innerHTML = `<header><div><span>문의 상품</span><h2>${escape(item.productName)}</h2></div><b class="${answered ? "is-answered" : ""}">${escape(item.status || "접수")}</b></header><dl><div><dt>접수 일시</dt><dd>${formatDate(item.createdAt)}</dd></div><div><dt>희망 날짜</dt><dd>${escape(item.desiredDate || "미정")}</dd></div><div><dt>예상 수량</dt><dd>${Number(item.quantity || 0).toLocaleString("ko-KR")}개</dd></div></dl><section><span>내 문의</span><p>${escape(item.message)}</p>${photos.length ? `<div class="guest-inquiry-photos">${photos.map((photo, index) => `<button type="button" aria-label="문의 첨부 사진 ${index + 1} 크게 보기"><img src="${escape(photo)}" alt="문의 첨부 사진 ${index + 1}" loading="lazy" /></button>`).join("")}</div>` : ""}</section>${answered ? `<section class="guest-inquiry-answer"><span>떡집 답변</span><p>${escape(item.adminReply)}</p><small>${formatDate(item.respondedAt)}</small></section>` : `<p class="guest-inquiry-pending">답변을 준비하고 있습니다. 잠시 후 다시 확인해 주세요.</p>`}`;
      result.hidden = false;
      result.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
    } catch (error) {
      message.textContent = error.message || "문의 내역을 조회하지 못했습니다.";
    } finally {
      submitButton.disabled = false;
      submitButton.classList.remove("is-loading");
      submitButton.textContent = "문의 조회하기";
    }
  });
})();
