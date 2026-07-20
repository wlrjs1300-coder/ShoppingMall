const inquiryForm = document.querySelector("[data-inquiry-form]");
if (inquiryForm) {
  const status = inquiryForm.querySelector("[data-inquiry-message]");
  const submitButton = inquiryForm.querySelector('[type="submit"]');
  const desiredDate = inquiryForm.elements.desiredDate;
  const quantityInput = inquiryForm.elements.quantity;
  const datePicker = inquiryForm.querySelector("[data-date-picker]");
  const dateTrigger = inquiryForm.querySelector("[data-date-trigger]");
  const dateDisplay = inquiryForm.querySelector("[data-date-display]");
  const calendar = inquiryForm.querySelector("[data-calendar]");
  const calendarTitle = inquiryForm.querySelector("[data-calendar-title]");
  const calendarDays = inquiryForm.querySelector("[data-calendar-days]");
  const productId = new URLSearchParams(window.location.search).get("product") || "";
  const formatLocalDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const updateDateDisplay = () => {
    if (!desiredDate.value) {
      dateDisplay.textContent = "날짜를 선택해 주세요";
      dateTrigger.classList.remove("has-value");
      return;
    }
    const [year, month, day] = desiredDate.value.split("-");
    dateDisplay.textContent = `${year}년 ${Number(month)}월 ${Number(day)}일`;
    dateTrigger.classList.add("has-value");
  };

  const closeCalendar = () => {
    calendar.hidden = true;
    dateTrigger.setAttribute("aria-expanded", "false");
  };

  const selectDate = (date) => {
    desiredDate.value = formatLocalDate(date);
    calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    updateDateDisplay();
    closeCalendar();
  };

  const renderCalendar = () => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();
    calendarTitle.textContent = `${year}년 ${month + 1}월`;
    calendarDays.innerHTML = "";
    for (let index = 0; index < firstDay; index += 1) calendarDays.insertAdjacentHTML("beforeend", '<span class="is-empty"></span>');
    for (let day = 1; day <= lastDate; day += 1) {
      const date = new Date(year, month, day);
      const value = formatLocalDate(date);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = String(day);
      button.dataset.calendarDate = value;
      button.disabled = date < today;
      button.classList.toggle("is-today", value === formatLocalDate(today));
      button.classList.toggle("is-selected", value === desiredDate.value);
      button.setAttribute("aria-label", `${year}년 ${month + 1}월 ${day}일`);
      calendarDays.append(button);
    }
  };

  const setQuantity = (value) => {
    quantityInput.value = String(Math.min(9999, Math.max(1, Number(value) || 1)));
    inquiryForm.querySelectorAll("[data-quantity-value]").forEach((button) => {
      button.classList.toggle("is-selected", Number(button.dataset.quantityValue) === Number(quantityInput.value));
    });
  };

  inquiryForm.addEventListener("click", (event) => {
    const quantityStep = event.target.closest("[data-quantity-step]");
    const quantityPreset = event.target.closest("[data-quantity-value]");
    const datePreset = event.target.closest("[data-date-offset]");
    if (quantityStep) setQuantity(Number(quantityInput.value) + Number(quantityStep.dataset.quantityStep));
    if (quantityPreset) setQuantity(quantityPreset.dataset.quantityValue);
    if (datePreset) {
      const date = new Date();
      date.setDate(date.getDate() + Number(datePreset.dataset.dateOffset));
      selectDate(date);
    }
    const calendarDate = event.target.closest("[data-calendar-date]");
    if (calendarDate) selectDate(new Date(`${calendarDate.dataset.calendarDate}T00:00:00`));
    if (event.target.closest("[data-calendar-prev]")) {
      calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
      renderCalendar();
    }
    if (event.target.closest("[data-calendar-next]")) {
      calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
      renderCalendar();
    }
    if (event.target.closest("[data-calendar-today]")) selectDate(today);
    if (event.target.closest("[data-date-clear]")) {
      desiredDate.value = "";
      updateDateDisplay();
      closeCalendar();
    }
  });
  dateTrigger.addEventListener("click", () => {
    const willOpen = calendar.hidden;
    calendar.hidden = !willOpen;
    dateTrigger.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) renderCalendar();
  });
  document.addEventListener("click", (event) => {
    if (!datePicker.contains(event.target)) closeCalendar();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !calendar.hidden) {
      closeCalendar();
      dateTrigger.focus();
    }
  });
  quantityInput.addEventListener("change", () => setQuantity(quantityInput.value));
  setQuantity(quantityInput.value);
  updateDateDisplay();

  fetch(`${API_BASE}/products/${encodeURIComponent(productId)}`)
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then(({ product }) => {
      inquiryForm.elements.productId.value = product.id;
      inquiryForm.elements.productName.value = product.name;
    })
    .catch(() => {
      status.textContent = "문의할 상품을 찾지 못했습니다. 메뉴에서 다시 선택해 주세요.";
      submitButton.disabled = true;
    });

  inquiryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.classList.remove("is-success");
    status.textContent = "";
    if (!inquiryForm.checkValidity()) return inquiryForm.reportValidity();
    const data = Object.fromEntries(new FormData(inquiryForm));
    try {
      const response = await fetch(`${API_BASE}/inquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      status.classList.add("is-success");
      status.textContent = `문의가 접수되었습니다. 접수번호는 ${body.id}입니다.`;
      submitButton.disabled = true;
    } catch (error) {
      status.textContent = error.message || "문의를 접수하지 못했습니다.";
    }
  });
}
