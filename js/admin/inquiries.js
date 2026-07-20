let adminInquiries = [];
let adminInquiriesLoaded = false;
let activeAdminInquiryId = "";

function escapeInquiryHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatInquiryDate(value, withTime = false) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ko-KR", withTime
    ? { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatInquiryPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{4})(\d{4})$/, "$1-$2-$3");
  if (digits.length === 10) return digits.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");
  return value || "-";
}

function shortInquiryId(id) {
  const tail = String(id || "").replace(/^(demo-)?inquiry-/, "").slice(0, 8).toUpperCase();
  return `INQ-${tail || "-"}`;
}

function getInquiryTone(status) {
  return status === "답변완료" ? "answered" : "received";
}

function syncInquirySummary() {
  window.adminInquirySummary = {
    total: adminInquiries.length,
    received: adminInquiries.filter((item) => item.status === "접수").length,
    answered: adminInquiries.filter((item) => item.status === "답변완료").length,
  };
  document.querySelectorAll('[data-admin-tab-count="inquiries"]').forEach((node) => {
    node.textContent = String(window.adminInquirySummary.received);
  });
}

function getVisibleAdminInquiries() {
  const status = document.querySelector("[data-admin-inquiry-status]")?.value || "";
  const query = document.querySelector("[data-admin-inquiry-search]")?.value.trim().toLowerCase() || "";
  return adminInquiries.filter((item) => {
    if (status && item.status !== status) return false;
    if (!query) return true;
    return [item.customer_name, item.customer_phone, item.product_name, item.message, item.id]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function renderAdminInquiries() {
  const list = document.querySelector("[data-admin-inquiry-list]");
  if (!list) return;
  syncInquirySummary();
  const visible = getVisibleAdminInquiries();
  list.innerHTML = visible.map((item) => `
    <tr data-inquiry-id="${escapeInquiryHtml(item.id)}" tabindex="0" aria-label="${escapeInquiryHtml(item.customer_name)} 문의 상세 열기">
      <td><span class="admin-inquiry-number">${shortInquiryId(item.id)}</span></td>
      <td>${formatInquiryDate(item.created_at)}</td>
      <td><strong>${escapeInquiryHtml(item.customer_name)}</strong></td>
      <td>${escapeInquiryHtml(formatInquiryPhone(item.customer_phone))}</td>
      <td><strong>${escapeInquiryHtml(item.product_name)}</strong></td>
      <td>${Number(item.quantity || 0).toLocaleString("ko-KR")}개</td>
      <td>${item.desired_date ? escapeInquiryHtml(item.desired_date) : "미정"}</td>
      <td><span class="admin-inquiry-status" data-tone="${getInquiryTone(item.status)}">${escapeInquiryHtml(item.status || "접수")}</span></td>
      <td class="admin-row-chevron" aria-hidden="true">›</td>
    </tr>`).join("");
  const total = document.querySelector("[data-admin-inquiry-total]");
  if (total) total.textContent = String(visible.length);
  const empty = document.querySelector("[data-admin-inquiry-empty]");
  if (empty) empty.hidden = visible.length > 0;
}

async function loadAdminInquiries({ force = false } = {}) {
  if (adminInquiriesLoaded && !force) return renderAdminInquiries();
  const result = await apiFetch("/inquiries");
  if (!result || !Array.isArray(result.inquiries)) {
    adminInquiriesLoaded = false;
    return renderAdminInquiries();
  }
  adminInquiries = result.inquiries;
  adminInquiriesLoaded = true;
  renderAdminInquiries();
  if (document.querySelector('[data-admin-tab="inquiries"]')?.classList.contains("is-active")) updateAdminSummaryCards("inquiries");
}

function openAdminInquiryDetail(id) {
  const item = adminInquiries.find((inquiry) => inquiry.id === id);
  const dialog = document.querySelector("[data-admin-inquiry-dialog]");
  const body = document.querySelector("[data-admin-inquiry-detail]");
  const headerStatus = document.querySelector("[data-admin-inquiry-header-status]");
  if (!item || !dialog || !body) return;
  activeAdminInquiryId = id;
  if (headerStatus) {
    headerStatus.textContent = item.status || "접수";
    headerStatus.dataset.tone = getInquiryTone(item.status);
  }
  body.innerHTML = `
    <section class="admin-inquiry-hero">
      <div class="admin-inquiry-hero-customer"><span class="admin-inquiry-eyebrow">CUSTOMER</span><strong>${escapeInquiryHtml(item.customer_name)}</strong><p>${escapeInquiryHtml(formatInquiryPhone(item.customer_phone))}</p></div>
      <div class="admin-inquiry-hero-facts"><div><span>문의 상품</span><strong>${escapeInquiryHtml(item.product_name)}</strong></div><div><span>예상 수량</span><strong>${Number(item.quantity || 0).toLocaleString("ko-KR")}개</strong></div><div><span>희망 날짜</span><strong>${item.desired_date ? escapeInquiryHtml(item.desired_date) : "미정"}</strong></div><div><span>접수 일시</span><strong>${formatInquiryDate(item.created_at, true)}</strong></div></div>
    </section>
    <section class="admin-inquiry-message"><div><span class="admin-inquiry-eyebrow">CUSTOMER MESSAGE</span><h3>문의 내용</h3><small>고객이 남긴 문의를 확인해 주세요.</small></div><p><span aria-hidden="true">“</span>${escapeInquiryHtml(item.message).replaceAll("\n", "<br>")}<span aria-hidden="true">”</span></p></section>
    <section class="admin-inquiry-response">
      <div class="admin-inquiry-response-head"><div><span class="admin-inquiry-eyebrow">RESPONSE</span><h3>답변 작성</h3><p>저장하면 문의 상태가 자동으로 답변완료로 변경됩니다.</p></div></div>
      <div class="admin-inquiry-response-grid"><label class="admin-inquiry-field"><span>고객 답변</span><textarea name="adminReply" rows="6" maxlength="2000" placeholder="문의에 대한 답변을 입력해 주세요.">${escapeInquiryHtml(item.admin_reply || "")}</textarea></label><label class="admin-inquiry-field admin-inquiry-memo-field"><span>관리 메모 <small>고객에게 공개되지 않습니다.</small></span><textarea name="adminMemo" rows="6" maxlength="500" placeholder="통화 내용이나 확인할 사항을 기록해 주세요.">${escapeInquiryHtml(item.admin_memo || "")}</textarea></label></div>
      <div class="admin-inquiry-actions"><button type="button" data-admin-inquiry-close>닫기</button><button class="is-primary" type="submit">저장</button></div>
    </section>`;
  dialog.showModal();
  dialog.scrollTop = 0;
}

function closeAdminInquiryDetail() {
  const dialog = document.querySelector("[data-admin-inquiry-dialog]");
  if (dialog?.open) dialog.close();
  activeAdminInquiryId = "";
}

document.querySelector("[data-admin-inquiry-status]")?.addEventListener("change", renderAdminInquiries);
document.querySelector("[data-admin-inquiry-search]")?.addEventListener("input", renderAdminInquiries);
document.querySelector("[data-admin-inquiry-list]")?.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-inquiry-id]");
  if (row) openAdminInquiryDetail(row.dataset.inquiryId);
});
document.querySelector("[data-admin-inquiry-list]")?.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const row = event.target.closest("tr[data-inquiry-id]");
  if (!row) return;
  event.preventDefault();
  openAdminInquiryDetail(row.dataset.inquiryId);
});
document.querySelector("[data-admin-inquiry-dialog]")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget || event.target.closest("[data-admin-inquiry-close]")) closeAdminInquiryDetail();
});
document.querySelector("[data-admin-inquiry-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const result = await apiFetchResult(`/inquiries/${encodeURIComponent(activeAdminInquiryId)}`, {
    method: "PATCH",
    body: { status: "답변완료", adminReply: form.adminReply.value, adminMemo: form.adminMemo.value },
  });
  if (!result.ok) return AppUI.alert(result.error || "문의 내용을 저장하지 못했습니다.");
  const index = adminInquiries.findIndex((item) => item.id === activeAdminInquiryId);
  if (index >= 0) adminInquiries[index] = result.data.inquiry;
  renderAdminInquiries();
  updateAdminSummaryCards("inquiries");
  closeAdminInquiryDetail();
  if (typeof setAdminFeedback === "function") setAdminFeedback("문의 답변과 처리 상태를 저장했습니다.");
});

window.loadAdminInquiries = loadAdminInquiries;
window.renderAdminInquiries = renderAdminInquiries;
