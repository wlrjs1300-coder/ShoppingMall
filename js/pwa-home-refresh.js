(function initPwaHomeSwipe() {
  const root = document.documentElement;
  const carousel = document.querySelector(".home-page .hero-carousel");
  const previousButton = document.querySelector("[data-hero-prev]");
  const nextButton = document.querySelector("[data-hero-next]");

  if (!carousel || !previousButton || !nextButton) return;
  if (!root.classList.contains("is-pwa") && !root.classList.contains("hide-scrollbars-mobile")) return;

  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;
  let tracking = false;

  carousel.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    currentX = startX;
    currentY = startY;
    tracking = true;
  }, { passive: true });

  carousel.addEventListener("touchmove", (event) => {
    if (!tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    currentX = touch.clientX;
    currentY = touch.clientY;

    const distanceX = currentX - startX;
    const distanceY = currentY - startY;
    if (Math.abs(distanceX) > 12 && Math.abs(distanceX) > Math.abs(distanceY)) {
      event.preventDefault();
    }
  }, { passive: false });

  carousel.addEventListener("touchend", () => {
    if (!tracking) return;
    tracking = false;

    const distanceX = currentX - startX;
    const distanceY = currentY - startY;
    const isHorizontalSwipe = Math.abs(distanceX) >= 48 && Math.abs(distanceX) > Math.abs(distanceY) * 1.25;
    if (!isHorizontalSwipe) return;

    if (distanceX < 0) nextButton.click();
    else previousButton.click();
  }, { passive: true });

  carousel.addEventListener("touchcancel", () => {
    tracking = false;
  }, { passive: true });
})();
