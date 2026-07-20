(() => {
  const form = document.querySelector("[data-social-consent-form]");
  if (!form) return;
  const all = form.querySelector("[data-consent-all]");
  const checks = [...form.querySelectorAll('input[name^="agree"]')];
  const message = form.querySelector("[data-social-consent-message]");
  const submit = form.querySelector('[type="submit"]');
  const providerLabel = { kakao: "카카오", naver: "네이버", google: "Google" };

  fetch("/api/auth/social/signup-session", { credentials: "same-origin", cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "소셜 인증 정보가 만료되었습니다.");
      document.querySelector("[data-social-consent-provider]").textContent = providerLabel[body.provider] || "소셜";
    })
    .catch((error) => {
      message.textContent = error.message;
      submit.disabled = true;
    });

  all.addEventListener("change", () => checks.forEach((check) => { check.checked = all.checked; }));
  checks.forEach((check) => check.addEventListener("change", () => {
    all.checked = checks.every((item) => item.checked);
    all.indeterminate = !all.checked && checks.some((item) => item.checked);
  }));

  form.querySelectorAll("[data-consent-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = form.querySelector(`[data-consent-panel="${button.dataset.consentDetail}"]`);
      panel.hidden = !panel.hidden;
      button.innerHTML = panel.hidden ? '보기 <span aria-hidden="true">⌄</span>' : '접기 <span aria-hidden="true">⌃</span>';
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const agreeTerms = form.elements.agreeTerms.checked;
    const agreePrivacy = form.elements.agreePrivacy.checked;
    if (!agreeTerms || !agreePrivacy) {
      message.textContent = "필수 약관에 모두 동의해 주세요.";
      return;
    }
    message.textContent = "";
    submit.disabled = true;
    submit.textContent = "계정을 만들고 있어요...";
    try {
      const response = await fetch("/api/auth/social/signup-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ agreeTerms, agreePrivacy, agreeMarketing: form.elements.agreeMarketing.checked }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "계정을 만들지 못했습니다.");
      submit.textContent = "로그인 완료! 잠시만 기다려 주세요";
      message.classList.add("is-success");
      message.textContent = "따뜻한 떡집으로 이동합니다.";
      setTimeout(() => window.location.replace("/index.html"), 1000);
    } catch (error) {
      message.textContent = error.message;
      submit.disabled = false;
      submit.textContent = "동의하고 시작하기";
    }
  });
})();
