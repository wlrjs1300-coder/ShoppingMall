const copyAddressButton = document.querySelector(".copy-address");
const addressCopyStatus = document.querySelector(".address-copy-status");

copyAddressButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(siteInfo.address);
    if (addressCopyStatus) addressCopyStatus.textContent = "주소를 복사했습니다.";
  } catch {
    if (addressCopyStatus) addressCopyStatus.textContent = siteInfo.address;
  }
});

const heroSlides = [...document.querySelectorAll(".hero-slide")];
const heroDotsContainer = document.querySelector("[data-hero-dots]");
const heroPosition = document.querySelector("[data-hero-position]");
const heroPrev = document.querySelector("[data-hero-prev]");
const heroNext = document.querySelector("[data-hero-next]");
const heroToggle = document.querySelector("[data-hero-toggle]");
const heroToggleIcon = document.querySelector("[data-hero-toggle-icon]");
let heroIndex = 0;
let heroTimer = null;
const heroIntervalMs = 5000;

if (heroSlides.length > 1) {
  heroDotsContainer?.append(
    ...heroSlides.map((_, index) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.setAttribute("aria-label", `${index + 1}번 배너로 이동`);
      if (index === 0) dot.classList.add("is-active");
      dot.addEventListener("click", () => goToHeroSlide(index));
      return dot;
    })
  );

  function renderHeroSlide() {
    heroSlides.forEach((slide, index) => slide.classList.toggle("is-active", index === heroIndex));
    heroDotsContainer?.querySelectorAll("button").forEach((dot, index) => dot.classList.toggle("is-active", index === heroIndex));
    if (heroPosition) heroPosition.textContent = `${heroIndex + 1} / ${heroSlides.length}`;
  }

  function goToHeroSlide(index) {
    heroIndex = (index + heroSlides.length) % heroSlides.length;
    renderHeroSlide();
  }

  function startHeroAutoplay() {
    stopHeroAutoplay();
    heroTimer = setInterval(() => goToHeroSlide(heroIndex + 1), heroIntervalMs);
  }

  function stopHeroAutoplay() {
    if (heroTimer) clearInterval(heroTimer);
    heroTimer = null;
  }

  heroPrev?.addEventListener("click", () => goToHeroSlide(heroIndex - 1));
  heroNext?.addEventListener("click", () => goToHeroSlide(heroIndex + 1));

  heroToggle?.addEventListener("click", () => {
    const isPlaying = heroToggle.dataset.playing === "true";
    if (isPlaying) {
      stopHeroAutoplay();
      heroToggle.dataset.playing = "false";
      heroToggle.setAttribute("aria-label", "배너 자동재생 시작");
      if (heroToggleIcon) heroToggleIcon.textContent = "▶";
    } else {
      startHeroAutoplay();
      heroToggle.dataset.playing = "true";
      heroToggle.setAttribute("aria-label", "배너 자동재생 일시정지");
      if (heroToggleIcon) heroToggleIcon.textContent = "❚❚";
    }
  });

  renderHeroSlide();
  startHeroAutoplay();
}

const menuSearch = document.querySelector("#menuSearch");
