(() => {
  const headerSearchForm = document.querySelector(".header-search");
  const headerSearchInput = headerSearchForm?.querySelector('input[type="search"]');
  if (!headerSearchForm || !headerSearchInput) return;

  const RECENT_SEARCH_KEY = "tteokRecentSearches";
  const SEARCH_SAVE_ENABLED_KEY = "tteokSearchSaveEnabled";
  const MAX_RECOMMENDED_SEARCHES = 7;
  const recommendedSearches = ["따뜻한 떡집", "인절미", "송편", "백설기", "단팥밤", "수수팥", "모둠찰떡", "약식"].slice(0, MAX_RECOMMENDED_SEARCHES);

  const html = (value) =>
    typeof escapeHtml === "function"
      ? escapeHtml(String(value ?? ""))
      : String(value ?? "").replace(/[&<>'"]/g, (character) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        })[character]);

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

  const isMenuSearchContext = () => typeof menuItems !== "undefined" && Array.isArray(menuItems) && menuItems.length > 0;

  const getMenuSearchSuggestions = (query, maxCount = 8) => {
    const q = String(query || "").trim().toLowerCase();
    if (!q || !isMenuSearchContext()) return [];

    const startMatches = [];
    const includeMatches = [];
    const seen = new Set();

    menuItems.forEach((item) => {
      const name = String(item?.dataset?.name || "").trim();
      if (!name) return;
      const value = name.toLowerCase();
      if (value.startsWith(q)) {
        if (!seen.has(name)) {
          seen.add(name);
          startMatches.push(name);
        }
        return;
      }
      if (value.includes(q) && !seen.has(name)) {
        seen.add(name);
        includeMatches.push(name);
      }
    });

    return [...startMatches, ...includeMatches].slice(0, maxCount);
  };

  const searchPanel = document.createElement("div");
  searchPanel.className = "header-search-panel";
  searchPanel.id = "header-search-panel";
  searchPanel.setAttribute("role", "dialog");
  searchPanel.setAttribute("aria-label", "검색 패널");
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
    if (isMenuSearchContext()) {
      headerSearchInput.value = value;
      activeMenuPage = 1;
      updateMenuList();
      return;
    }
    window.location.href = `menu.html?q=${encodeURIComponent(value)}`;
  };

  const renderStaticSections = (searchSaveEnabled) => {
    const recent = readRecentSearches();
    return `
      <section class="search-panel-section recent-searches">
        <div class="search-panel-heading"><h2>최근 검색어</h2></div>
        ${
          recent.length
            ? `<div class="recent-search-list">${recent
                .map(
                  (item) =>
                    `<div class="recent-search-item"><button type="button" data-search-query="${html(item)}"><span>${html(item)}</span></button><button class="recent-search-remove" type="button" data-remove-recent="${html(item)}" aria-label="${html(item)} 최근 검색어 삭제">×</button></div>`
                )
                .join("")}</div>`
            : `<p class="search-panel-empty">최근 검색어가 없습니다.</p>`
        }
        <div class="recent-search-controls">
          <button type="button" data-clear-searches ${recent.length ? "" : "disabled"}>전체 삭제</button>
          <button type="button" data-toggle-search-save>${searchSaveEnabled ? "검색어 저장 끄기" : "검색어 저장 켜기"}</button>
        </div>
      </section>
      <section class="search-panel-section popular-searches">
        <div class="search-panel-heading"><h2>추천 검색어</h2><span>따뜻한 떡집 추천</span></div>
        <ol>${recommendedSearches.map((item, index) => `<li><button type="button" data-search-query="${html(item)}"><b>${index + 1}</b><span>${html(item)}</span></button></li>`).join("")}</ol>
      </section>`;
  };

  const renderSearchPanel = (query = "") => {
    const queryText = String(query || "").trim();
    const searchSaveEnabled = localStorage.getItem(SEARCH_SAVE_ENABLED_KEY) !== "false";
    const menuSuggestions = isMenuSearchContext() ? getMenuSearchSuggestions(queryText) : [];
    const hasMenuSuggestions = menuSuggestions.length > 0;
    const showMenuSuggestions = isMenuSearchContext() && queryText;

    const menuSection = showMenuSuggestions
      ? `
      <section class="search-panel-section recent-searches">
        <div class="search-panel-heading"><h2>메뉴 자동완성</h2></div>
        <div class="recent-search-list">
          ${menuSuggestions.map((item) => `<div class="recent-search-item"><button type="button" data-search-query="${html(item)}"><span>${html(item)}</span></button></div>`).join("")}
        </div>
      </section>`
      : "";

    const emptySuggestionSection =
      isMenuSearchContext() && queryText && !hasMenuSuggestions
        ? `
      <section class="search-panel-section popular-searches">
        <div class="search-panel-heading"><h2>메뉴 자동완성</h2></div>
        <p class="search-panel-empty">일치하는 메뉴가 없습니다.</p>
      </section>`
        : "";

    const staticSection = isMenuSearchContext() && queryText ? "" : renderStaticSections(searchSaveEnabled);

    searchPanel.innerHTML = `${staticSection}${menuSection}${emptySuggestionSection}`;
  };

  const openSearchPanel = () => {
    renderSearchPanel(headerSearchInput.value || "");
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
  headerSearchInput.addEventListener("input", () => renderSearchPanel(headerSearchInput.value || ""));
  headerSearchForm.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !searchPanel.hidden) {
      event.preventDefault();
      closeSearchPanel(true);
      return;
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
      renderSearchPanel(headerSearchInput.value || "");
      headerSearchInput.focus();
      return;
    }

    const queryButton = event.target.closest("[data-search-query]");
    if (queryButton) {
      runHeaderSearch(queryButton.dataset.searchQuery);
      return;
    }

    if (event.target.closest("[data-clear-searches]")) {
      localStorage.removeItem(RECENT_SEARCH_KEY);
      renderSearchPanel(headerSearchInput.value || "");
    }

    if (event.target.closest("[data-toggle-search-save]")) {
      const enabled = localStorage.getItem(SEARCH_SAVE_ENABLED_KEY) !== "false";
      localStorage.setItem(SEARCH_SAVE_ENABLED_KEY, String(!enabled));
      renderSearchPanel(headerSearchInput.value || "");
    }
  });

  document.addEventListener("click", (event) => {
    if (!headerSearchForm.contains(event.target)) closeSearchPanel();
  });

  headerSearchForm.addEventListener("submit", (event) => {
    const query = headerSearchInput.value;
    if (isMenuSearchContext() && query.trim()) {
      event.preventDefault();
      runHeaderSearch(query);
      return;
    }
    saveRecentSearch(query);
  });

  window.runHeaderSearch = runHeaderSearch;
})();
