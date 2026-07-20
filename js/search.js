const headerSearchForm = document.querySelector(".header-search");
const headerSearchInput = headerSearchForm?.querySelector('input[type="search"]');
const RECENT_SEARCH_KEY = "tteokRecentSearches";
const SEARCH_SAVE_ENABLED_KEY = "tteokSearchSaveEnabled";
const recommendedSearches = ["증편", "답례떡", "인절미", "백설기", "꿀떡", "찰떡", "수수팥떡", "앙금설기", "가래떡", "단체주문"];

function readRecentSearches() {
  try {
    const values = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) || "[]");
    return Array.isArray(values) ? values.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(query) {
  if (localStorage.getItem(SEARCH_SAVE_ENABLED_KEY) === "false") return;
  const normalized = String(query || "").trim();
  if (!normalized) return;
  const next = [normalized, ...readRecentSearches().filter((item) => item !== normalized)].slice(0, 6);
  localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
}

if (headerSearchForm && headerSearchInput) {
  const searchPanel = document.createElement("div");
  searchPanel.className = "header-search-panel";
  searchPanel.id = "header-search-panel";
  searchPanel.setAttribute("role", "dialog");
  searchPanel.setAttribute("aria-label", "검색어 선택");
  searchPanel.hidden = true;
  headerSearchInput.setAttribute("aria-controls", searchPanel.id);
  headerSearchInput.setAttribute("aria-expanded", "false");
  headerSearchInput.setAttribute("aria-haspopup", "dialog");
  headerSearchForm.append(searchPanel);

  const closeSearchPanel = (restoreFocus = false) => {
    searchPanel.hidden = true;
    headerSearchInput.setAttribute("aria-expanded", "false");
    if (restoreFocus) headerSearchInput.focus();
  };

  const runHeaderSearch = (query) => {
    const value = String(query || "").trim();
    if (!value) return;
    saveRecentSearch(value);
    closeSearchPanel();
    if (typeof menuItems !== "undefined" && menuItems.length) {
      headerSearchInput.value = value;
      activeMenuPage = 1;
      updateMenuList();
      return;
    }
    window.location.href = `menu.html?q=${encodeURIComponent(value)}`;
  };

  const renderSearchPanel = () => {
    const recent = readRecentSearches();
    const searchSaveEnabled = localStorage.getItem(SEARCH_SAVE_ENABLED_KEY) !== "false";
    searchPanel.innerHTML = `
      <section class="search-panel-section recent-searches">
        <div class="search-panel-heading"><h2>최근 검색어</h2></div>
        ${recent.length
          ? `<div class="recent-search-list">${recent.map((item) => `<div class="recent-search-item"><button type="button" data-search-query="${escapeHtml(item)}"><span>${escapeHtml(item)}</span></button><button class="recent-search-remove" type="button" data-remove-recent="${escapeHtml(item)}" aria-label="${escapeHtml(item)} 최근 검색어 삭제">×</button></div>`).join("")}</div>`
          : `<p class="search-panel-empty">최근 검색어가 없습니다.</p>`}
        <div class="recent-search-controls">
          <button type="button" data-clear-searches ${recent.length ? "" : "disabled"}>전체 삭제</button>
          <button type="button" data-toggle-search-save>${searchSaveEnabled ? "검색어 저장 끄기" : "검색어 저장 켜기"}</button>
        </div>
      </section>
      <section class="search-panel-section popular-searches">
        <div class="search-panel-heading"><h2>추천 검색어</h2><span>따뜻한 떡집 추천</span></div>
        <ol>${recommendedSearches.map((item, index) => `<li><button type="button" data-search-query="${escapeHtml(item)}"><b>${index + 1}</b><span>${escapeHtml(item)}</span></button></li>`).join("")}</ol>
      </section>`;
  };

  const openSearchPanel = () => {
    renderSearchPanel();
    searchPanel.hidden = false;
    headerSearchInput.setAttribute("aria-expanded", "true");
  };

  const movePanelFocus = (direction) => {
    const items = [...searchPanel.querySelectorAll("button:not(:disabled)")];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = direction > 0 ? (current + 1) % items.length : (current <= 0 ? items.length - 1 : current - 1);
    items[next].focus();
  };

  headerSearchInput.addEventListener("focus", openSearchPanel);
  headerSearchInput.addEventListener("click", openSearchPanel);
  headerSearchForm.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !searchPanel.hidden) {
      event.preventDefault();
      closeSearchPanel(true);
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !searchPanel.hidden) {
      event.preventDefault();
      movePanelFocus(event.key === "ArrowDown" ? 1 : -1);
    }
  });
  searchPanel.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-recent]");
    if (removeButton) {
      const next = readRecentSearches().filter((item) => item !== removeButton.dataset.removeRecent);
      localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
      renderSearchPanel();
      headerSearchInput.focus();
      return;
    }
    const queryButton = event.target.closest("[data-search-query]");
    if (queryButton) runHeaderSearch(queryButton.dataset.searchQuery);
    if (event.target.closest("[data-clear-searches]")) {
      localStorage.removeItem(RECENT_SEARCH_KEY);
      renderSearchPanel();
    }
    if (event.target.closest("[data-toggle-search-save]")) {
      const enabled = localStorage.getItem(SEARCH_SAVE_ENABLED_KEY) !== "false";
      localStorage.setItem(SEARCH_SAVE_ENABLED_KEY, String(!enabled));
      renderSearchPanel();
    }
  });
  document.addEventListener("click", (event) => {
    if (!headerSearchForm.contains(event.target)) closeSearchPanel();
  });
  headerSearchForm.addEventListener("submit", () => saveRecentSearch(headerSearchInput.value));
}
