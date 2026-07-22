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
  const productSelect = inquiryForm.elements.productId;
  const productNameInput = inquiryForm.elements.productName;
  const productPicker = inquiryForm.querySelector("[data-product-picker]");
  const productTrigger = inquiryForm.querySelector("[data-product-trigger]");
  const productOptions = inquiryForm.querySelector("[data-product-options]");
  const productLabel = inquiryForm.querySelector("[data-product-label]");
  const productCategory = inquiryForm.querySelector("[data-product-category]");
  const photoInput = inquiryForm.querySelector("[data-inquiry-photo-input]");
  const photoPreview = inquiryForm.querySelector("[data-inquiry-photo-preview]");
  let inquiryPhotos = [];
  const renderPhotoPreview = () => {
    if (!photoPreview) return;
    photoPreview.innerHTML = inquiryPhotos.map((photo, index) => `<div class="inquiry-photo-item"><img src="${photo}" alt="문의 첨부 사진 ${index + 1}" /><button type="button" data-inquiry-photo-remove="${index}" aria-label="첨부 사진 ${index + 1} 삭제">×</button></div>`).join("");
  };
  const compressPhoto = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("사진을 불러오지 못했습니다."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("지원하지 않는 사진 파일입니다."));
      image.onload = () => {
        const scale = Math.min(1, 960 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/webp", 0.75));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  const formatLocalDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  photoInput?.addEventListener("change", async () => {
    status.textContent = "";
    const available = 3 - inquiryPhotos.length;
    const files = [...(photoInput.files || [])].slice(0, Math.max(available, 0));
    if (!files.length && available <= 0) status.textContent = "사진은 최대 3장까지 첨부할 수 있습니다.";
    for (const file of files) {
      if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
        status.textContent = "사진은 JPG, PNG, WEBP 형식의 5MB 이하 파일만 첨부할 수 있습니다.";
        continue;
      }
      try { inquiryPhotos.push(await compressPhoto(file)); }
      catch (error) { status.textContent = error.message; }
    }
    photoInput.value = "";
    renderPhotoPreview();
  });
  photoPreview?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-inquiry-photo-remove]");
    if (!button) return;
    inquiryPhotos.splice(Number(button.dataset.inquiryPhotoRemove), 1);
    renderPhotoPreview();
  });

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

  const syncSelectedProduct = () => {
    const option = productSelect.selectedOptions[0];
    productNameInput.value = option?.dataset.productName || "";
    productLabel.textContent = option?.dataset.productName || "문의할 상품을 선택해 주세요.";
    productCategory.textContent = option?.dataset.category || "상품 선택";
    productOptions.querySelectorAll("[data-product-id]").forEach((button) => {
      const selected = button.dataset.productId === productSelect.value;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-selected", String(selected));
    });
  };

  const closeProductPicker = () => {
    productOptions.hidden = true;
    productTrigger.setAttribute("aria-expanded", "false");
  };

  productTrigger.addEventListener("click", () => {
    const willOpen = productOptions.hidden;
    productOptions.hidden = !willOpen;
    productTrigger.setAttribute("aria-expanded", String(willOpen));
  });
  productOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-product-id]");
    if (!button) return;
    productSelect.value = button.dataset.productId;
    syncSelectedProduct();
    closeProductPicker();
    productTrigger.focus();
  });
  document.addEventListener("click", (event) => {
    if (!productPicker.contains(event.target)) closeProductPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !productOptions.hidden) {
      closeProductPicker();
      productTrigger.focus();
    }
  });

  productSelect.addEventListener("change", syncSelectedProduct);
  fetch(`${API_BASE}/products`, { cache: "no-store" })
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then(({ products }) => {
      const items = Array.isArray(products) ? products : [];
      productSelect.innerHTML = `<option value="">문의할 상품을 선택해 주세요.</option>${items.map((product) => `<option value="${escapeHtml(product.id)}" data-product-name="${escapeHtml(product.name)}" data-category="${escapeHtml(product.category || "기타")}">${escapeHtml(product.name)}</option>`).join("")}`;
      productOptions.innerHTML = items.map((product) => `<button class="inquiry-product-option" type="button" role="option" aria-selected="false" data-product-id="${escapeHtml(product.id)}"><span><small>${escapeHtml(product.category || "기타")}</small><strong>${escapeHtml(product.name)}</strong></span><b aria-hidden="true">✓</b></button>`).join("");
      productSelect.disabled = false;
      productTrigger.disabled = false;
      if (productId && items.some((product) => product.id === productId)) productSelect.value = productId;
      syncSelectedProduct();
    })
    .catch(() => {
      productSelect.innerHTML = '<option value="">상품 목록을 불러오지 못했습니다.</option>';
      productLabel.textContent = "상품 목록을 불러오지 못했습니다.";
      status.textContent = "상품 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
      submitButton.disabled = true;
    });

  inquiryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.classList.remove("is-success");
    status.textContent = "";
    if (!productSelect.value) {
      status.textContent = "문의할 상품을 먼저 선택해 주세요.";
      productTrigger.focus();
      return;
    }
    if (!inquiryForm.checkValidity()) return inquiryForm.reportValidity();
    const data = Object.fromEntries(new FormData(inquiryForm));
    data.photos = [...inquiryPhotos];
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
