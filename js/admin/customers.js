let adminMemberDirectory = [];
let adminMemberDirectoryLoaded = false;
let adminMemberDirectoryLoading = false;

function normalizeAdminCustomerPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function findAdminMember(customer) {
  if (customer.userId) return adminMemberDirectory.find((member) => member.id === customer.userId) || null;
  const phone = normalizeAdminCustomerPhone(customer.phone);
  return phone ? adminMemberDirectory.find((member) => normalizeAdminCustomerPhone(member.phone) === phone && member.status === "active") || null : null;
}

async function loadAdminMemberDirectory() {
  if (adminMemberDirectoryLoaded || adminMemberDirectoryLoading || !getApiToken()) return;
  adminMemberDirectoryLoading = true;
  const result = await apiFetch("/users/admin/directory");
  adminMemberDirectoryLoading = false;
  if (!result?.users) return;
  adminMemberDirectory = result.users;
  adminMemberDirectoryLoaded = true;
  renderAdminCustomers();
}

function buildAdminCustomers(orders) {
  const notes = readCustomerNotes();
  const savedCustomers = readCustomers();
  const customers = new Map();

  savedCustomers.forEach((customer) => {
    const key = customer.phone || customer.id || customer.name;
    if (!key) return;
    customers.set(key, {
      id: key,
      savedId: customer.id || key,
      isSaved: true,
      name: customer.name || "-",
      phone: customer.phone || "-",
      type: customer.type || "일반",
      userId: customer.userId || "",
      isMember: Boolean(customer.userId),
      orderCount: 0,
      quantity: 0,
      revenue: 0,
      lastDate: "",
      lastProduct: "",
      note: customer.memo || notes[key] || "",
    });
  });

  orders.forEach((order) => {
    const key = order.phone || order.id;
    const saved = customers.get(key) || {
      id: key,
      savedId: "",
      isSaved: false,
      name: order.customer || "-",
      phone: order.phone || "-",
      type: "주문고객",
      userId: order.userId || "",
      isMember: Boolean(order.userId),
      orderCount: 0,
      quantity: 0,
      revenue: 0,
      lastDate: "",
      lastProduct: "",
      note: notes[key] || "",
    };

    const createdAt = order.createdAt || "";
    saved.orderCount += 1;
    saved.quantity += Number(order.quantity || 0);
    saved.isMember = saved.isMember || Boolean(order.userId);
    if (order.userId) saved.userId = order.userId;
    const isPaid = ["결제완료", "부분환불"].includes(order.paymentStatus);
    const isCancelled = ["취소", "주문취소"].includes(order.status) || order.paymentStatus === "결제취소";
    if (isPaid && !isCancelled) saved.revenue += Math.max(0, Number(order.revenue || 0) - Number(order.refundAmount || 0));

    if (!saved.lastDate || new Date(createdAt) > new Date(saved.lastDate)) {
      saved.lastDate = createdAt;
      saved.lastProduct = order.product || "-";
      saved.name = order.customer || saved.name;
      saved.phone = order.phone || saved.phone;
    }

    customers.set(key, saved);
  });

  return [...customers.values()].map((customer) => {
    const member = findAdminMember(customer);
    return member ? { ...customer, userId: member.id, isMember: member.status === "active", isSuspended: member.suspended } : customer;
  }).sort((a, b) => {
    const dateDiff = new Date(b.lastDate || 0) - new Date(a.lastDate || 0);
    if (dateDiff) return dateDiff;
    return String(a.name).localeCompare(String(b.name), "ko-KR");
  });
}

function renderAdminCustomers() {
  const customerList = document.querySelector(".admin-customer-list");
  if (!customerList) return;
  loadAdminMemberDirectory();

  const customers = buildAdminCustomers(readOrders());
  const searchTerm = String(document.querySelector(".admin-customer-search-input")?.value || "").trim().toLowerCase();
  const typeFilter = document.querySelector(".admin-customer-type-filter")?.value || "all";
  const filteredCustomers = customers.filter((customer) => {
    const membership = customer.isMember ? "회원" : "비회원";
    const matchesType = typeFilter === "all" || membership === typeFilter;
    const searchable = [customer.name, customer.phone, membership, customer.note, customer.lastProduct].join(" ").toLowerCase();
    return matchesType && (!searchTerm || searchable.includes(searchTerm));
  });
  const empty = document.querySelector(".admin-customer-empty");
  const total = document.querySelector("[data-admin-customer-total]");
  const tabCount = document.querySelector('[data-admin-tab-count="customers"]');

  if (total) total.textContent = String(filteredCustomers.length);
  if (tabCount) tabCount.textContent = String(customers.length);
  if (empty) {
    const isFiltered = customers.length > 0 && filteredCustomers.length === 0;
    empty.querySelector(".admin-empty-title").textContent = isFiltered ? "조건에 맞는 고객이 없습니다." : "아직 고객 데이터가 없습니다.";
    empty.querySelector(".admin-empty-desc").textContent = isFiltered ? "검색어나 고객 구분을 변경해 보세요." : "주문 요청이 접수되면 자동으로 정리됩니다.";
    empty.hidden = filteredCustomers.length > 0;
  }

  customerList.innerHTML = filteredCustomers
    .map((customer) => {
      const lastDate = customer.lastDate ? new Date(customer.lastDate).toLocaleDateString("ko-KR") : "-";
      return `
        <tr data-customer-id="${escapeHtml(customer.id)}" data-saved-customer-id="${escapeHtml(customer.savedId || "")}">
          <td><strong>${escapeHtml(customer.name)}</strong></td>
          <td>${escapeHtml(customer.phone)}</td>
          <td><span class="admin-customer-type ${customer.isMember ? "is-member" : "is-guest"}">${customer.isMember ? "회원" : "비회원"}</span></td>
          <td>${customer.orderCount}</td>
          <td><strong>${escapeHtml(customer.lastProduct || "-")}</strong></td>
          <td>${lastDate}</td>
          <td><textarea class="admin-note" rows="1" placeholder="고객 메모">${escapeHtml(customer.note || "")}</textarea></td>
          <td class="admin-row-actions">
            <button class="admin-customer-orders" type="button">주문 보기</button>
            <button class="admin-customer-edit" type="button">수정</button>
            <button class="admin-customer-suspend" type="button" data-user-id="${escapeHtml(customer.userId || "")}" data-suspended="${customer.isSuspended ? "true" : "false"}" ${customer.isMember ? "" : "disabled title=\"회원 계정에만 사용할 수 있습니다.\""}>${customer.isSuspended ? "정지 해제" : "정지"}</button>
            <button class="admin-customer-withdraw" type="button" data-user-id="${escapeHtml(customer.userId || "")}" ${customer.isMember ? "" : "disabled title=\"회원 계정에만 사용할 수 있습니다.\""}>탈퇴</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function resetAdminCustomerForm() {
  if (!adminCustomerForm) return;
  adminCustomerForm.reset();
  adminCustomerForm.elements.namedItem("id").value = "";
  if (adminCustomerSubmit) adminCustomerSubmit.textContent = "고객 저장";
  if (adminCustomerCancel) adminCustomerCancel.hidden = true;
}

function saveAdminCustomer(formData) {
  const id = String(formData.get("id") || "").trim();
  const phone = String(formData.get("phone") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const customers = readCustomers();
  const existingCustomer = id
    ? customers.find((customer) => customer.id === id)
    : phone
      ? customers.find((customer) => customer.phone === phone)
      : customers.find((customer) => customer.name === name);
  const nextCustomer = {
    id: id || existingCustomer?.id || phone || `customer-${Date.now()}`,
    name,
    phone,
    type: String(formData.get("type") || "일반").trim(),
    memo: String(formData.get("memo") || "").trim(),
    updatedAt: new Date().toISOString(),
  };

  if (!nextCustomer.name) {
    setAdminFeedback("고객명은 필수입니다.");
    return;
  }

  const exists = Boolean(existingCustomer);
  const nextCustomers = exists
    ? customers.map((customer) => (customer.id === nextCustomer.id ? { ...customer, ...nextCustomer } : customer))
    : [{ ...nextCustomer, createdAt: new Date().toISOString() }, ...customers];

  writeCustomers(nextCustomers);
  resetAdminCustomerForm();
  closeAdminFormDrawer("customer");
  renderAdminDashboard();
  setAdminFeedback(exists ? "고객 정보를 수정했습니다." : "고객을 등록했습니다.");
}

function editAdminCustomer(customerId) {
  if (!adminCustomerForm || !customerId) return;
  const customer = buildAdminCustomers(readOrders()).find((item) => item.id === customerId || item.savedId === customerId);
  if (!customer) return;

  adminCustomerForm.elements.namedItem("id").value = customer.savedId || customer.id;
  adminCustomerForm.elements.namedItem("name").value = customer.name === "-" ? "" : customer.name;
  adminCustomerForm.elements.namedItem("phone").value = customer.phone === "-" ? "" : customer.phone;
  adminCustomerForm.elements.namedItem("memo").value = customer.note || "";
  if (adminCustomerSubmit) adminCustomerSubmit.textContent = "수정 저장";
  if (adminCustomerCancel) adminCustomerCancel.hidden = false;
  openAdminFormDrawer("customer", { editing: true });
}

function deleteAdminCustomer(customerId) {
  if (!customerId) return;
  const customers = readCustomers();
  const target = customers.find((customer) => customer.id === customerId);
  writeCustomers(customers.filter((customer) => customer.id !== customerId));

  const noteKey = target?.phone || target?.id || target?.name;
  if (noteKey) {
    const notes = readCustomerNotes();
    delete notes[noteKey];
    writeCustomerNotes(notes);
  }

  resetAdminCustomerForm();
  renderAdminDashboard();
  setAdminFeedback("직접 등록한 고객을 삭제했습니다.");
}
