async function runFormSubmit(button, busyText, action) {
  if (!button) { await action(); return; }
  const defaultText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  let keepBusy = false;
  try {
    keepBusy = await action();
  } finally {
    if (!keepBusy) {
      button.disabled = false;
      button.textContent = defaultText;
    }
  }
}

function connectAuthDescriptions(root = document) {
  root.querySelectorAll(".auth-field-hint, .auth-field-error").forEach((message, index) => {
    const field = message.closest("label")?.querySelector("input, select, textarea")
      || (message.closest("[data-code-row]") ? root.querySelector("[data-code-input]") : null);
    if (!field) return;
    if (!message.id) message.id = `auth-description-${field.name || "field"}-${index}`;
    const ids = new Set((field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add(message.id);
    field.setAttribute("aria-describedby", [...ids].join(" "));
  });
}

connectAuthDescriptions();

// 회원가입/로그인 응답을 사용자 메시지로 매핑하는 공통 규칙 (400/409/429/500/네트워크 오류)
function describeAuthError(status, body, fallback) {
  if (status === 409) return body?.error || "이미 가입된 이메일입니다.";
  if (status === 429) return body?.error || "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 400 || status === 401) return body?.error || fallback;
  return "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

function showInlineNotice(text, duration = 3500) {
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
    "background:#fff0f3;color:#c0445e;border:1px solid rgba(218,135,155,.5);" +
    "padding:10px 20px;border-radius:10px;font-size:0.84rem;z-index:99999;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.12);white-space:nowrap;";
  notice.textContent = text;
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), duration);
  return notice;
}

// ─── 회원가입 ────────────────────────────────────────────────
const signupForm = document.querySelector("[data-signup-form]");
if (signupForm) {
  const signupMessage = signupForm.querySelector("[data-signup-message]");
  const signupSubmitButton = signupForm.querySelector('[type="submit"]');

  // "전체 동의" 체크박스 ↔ 개별 약관 체크박스 동기화
  const agreeAllCheckbox = signupForm.querySelector("[data-agree-all]");
  const agreeCheckboxes = [
    ...signupForm.querySelectorAll('input[name="agreeTerms"], input[name="agreePrivacy"], input[name="agreeMarketing"]'),
  ];
  agreeAllCheckbox?.addEventListener("change", () => {
    agreeCheckboxes.forEach((checkbox) => { checkbox.checked = agreeAllCheckbox.checked; });
  });
  agreeCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (agreeAllCheckbox) agreeAllCheckbox.checked = agreeCheckboxes.every((c) => c.checked);
    });
  });

  // 다음(카카오) 우편번호 서비스로 주소 검색
  const addressSearchButton = signupForm.querySelector("[data-address-search]");
  const postalCodeInput = signupForm.querySelector('input[name="postalCode"]');
  const addressInput = signupForm.querySelector('input[name="address"]');
  const addressDetailInput = signupForm.querySelector('input[name="addressDetail"]');
  addressSearchButton?.addEventListener("click", () => {
    if (!window.PostcodeModal) {
      signupMessage.textContent = "주소 검색 화면을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.";
      return;
    }
    window.PostcodeModal.open((data) => {
      postalCodeInput.value = data.zonecode;
      addressInput.value = data.address;
      addressDetailInput?.focus();
    });
  });

  // 휴대폰 인증 (회원가입 필수 단계)
  const phoneInput = signupForm.querySelector("[data-phone-input]");
  const sendCodeButton = signupForm.querySelector("[data-send-code-button]");
  const codeRow = signupForm.querySelector("[data-code-row]");
  const codeInput = signupForm.querySelector("[data-code-input]");
  const verifyCodeButton = signupForm.querySelector("[data-verify-code-button]");
  const codeTimer = signupForm.querySelector("[data-code-timer]");
  const devCodeHint = signupForm.querySelector("[data-dev-code-hint]");
  const codeMessage = signupForm.querySelector("[data-code-message]");

  let phoneVerified = false;
  let verifiedPhoneDigits = "";
  let codeCountdownTimer = null;

  function stopCodeCountdown() {
    if (codeCountdownTimer) {
      clearInterval(codeCountdownTimer);
      codeCountdownTimer = null;
    }
  }

  function startCodeCountdown(totalSeconds) {
    let remaining = totalSeconds;
    const render = () => {
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      codeTimer.textContent = `남은 시간 ${m}:${String(s).padStart(2, "0")}`;
    };
    stopCodeCountdown();
    render();
    codeCountdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        stopCodeCountdown();
        codeTimer.textContent = "인증 시간이 만료됐습니다. 인증번호를 다시 받아 주세요.";
        return;
      }
      render();
    }, 1000);
  }

  // 번호를 인증 완료 후 다시 수정하면 인증 상태를 초기화한다
  phoneInput?.addEventListener("input", () => {
    if (!phoneVerified) return;
    phoneVerified = false;
    verifiedPhoneDigits = "";
    stopCodeCountdown();
    codeRow.hidden = true;
    codeInput.value = "";
    codeInput.disabled = false;
    verifyCodeButton.disabled = false;
    sendCodeButton.disabled = false;
    sendCodeButton.textContent = "인증번호 받기";
    codeMessage.classList.remove("is-success");
    codeMessage.textContent = "";
  });

  sendCodeButton?.addEventListener("click", async () => {
    const phoneDigits = String(phoneInput.value || "").replace(/\D/g, "");
    if (!phoneDigits || !/^01[0-9]{8,9}$/.test(phoneDigits)) {
      signupMessage.textContent = "휴대폰 번호 형식을 확인해 주세요.";
      return;
    }

    codeMessage.classList.remove("is-success");
    codeMessage.textContent = "";
    devCodeHint.hidden = true;

    const defaultText = sendCodeButton.textContent;
    sendCodeButton.disabled = true;
    sendCodeButton.textContent = "발송 중...";
    try {
      const res = await fetch("/api/phone/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ phone: phoneDigits }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        codeMessage.textContent = body?.error || "인증번호 발송에 실패했습니다.";
        return;
      }

      codeRow.hidden = false;
      codeInput.disabled = false;
      codeInput.value = "";
      verifyCodeButton.disabled = false;
      startCodeCountdown(body.expiresInSeconds || 300);

      devCodeHint.hidden = true;
      codeInput.focus();
    } catch {
      codeMessage.textContent = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.";
    } finally {
      sendCodeButton.disabled = false;
      sendCodeButton.textContent = defaultText;
    }
  });

  verifyCodeButton?.addEventListener("click", async () => {
    const phoneDigits = String(phoneInput.value || "").replace(/\D/g, "");
    const code = String(codeInput.value || "").trim();
    if (!code) {
      codeMessage.classList.remove("is-success");
      codeMessage.textContent = "인증번호를 입력해 주세요.";
      return;
    }

    const defaultText = verifyCodeButton.textContent;
    verifyCodeButton.disabled = true;
    verifyCodeButton.textContent = "확인 중...";
    let verifiedNow = false;
    try {
      const res = await fetch("/api/phone/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ phone: phoneDigits, code }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok || !body?.verified) {
        codeMessage.classList.remove("is-success");
        codeMessage.textContent = body?.error || "인증번호가 올바르지 않습니다.";
        return;
      }

      verifiedNow = true;
      phoneVerified = true;
      verifiedPhoneDigits = phoneDigits;
      stopCodeCountdown();
      codeTimer.textContent = "";
      devCodeHint.hidden = true;
      codeMessage.classList.add("is-success");
      codeMessage.textContent = "휴대폰 인증이 완료됐습니다.";
      codeInput.disabled = true;
      sendCodeButton.disabled = true;
      sendCodeButton.textContent = "인증 완료";
      phoneInput.readOnly = true;
    } catch {
      codeMessage.classList.remove("is-success");
      codeMessage.textContent = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.";
    } finally {
      if (!verifiedNow) {
        verifyCodeButton.disabled = false;
        verifyCodeButton.textContent = defaultText;
      } else {
        verifyCodeButton.textContent = "완료";
      }
    }
  });

  // 비밀번호 확인란 실시간 일치 여부 안내
  const passwordInput = signupForm.querySelector("[data-password-input]");
  const passwordConfirmInput = signupForm.querySelector("[data-password-confirm-input]");
  const passwordRuleError = signupForm.querySelector("[data-password-rule-error]");
  const passwordMatchError = signupForm.querySelector("[data-password-match-error]");
  const usernameCheckButton = signupForm.querySelector("[data-check-username]");
  const emailCheckButton = signupForm.querySelector("[data-check-email]");
  const usernameCheckMessage = signupForm.querySelector("[data-username-check-message]");
  const emailCheckMessage = signupForm.querySelector("[data-email-check-message]");
  let checkedUsername = "";
  let checkedEmail = "";

  async function checkSignupAvailability(kind) {
    const input = signupForm.elements.namedItem(kind);
    const value = String(input?.value || "").trim().toLowerCase();
    const isUsername = kind === "username";
    const message = isUsername ? usernameCheckMessage : emailCheckMessage;
    const button = isUsername ? usernameCheckButton : emailCheckButton;
    const valid = isUsername ? /^[a-z0-9_]{4,20}$/.test(value) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    message.classList.remove("is-success");
    if (!valid) { message.textContent = isUsername ? "아이디 형식을 먼저 확인해 주세요." : "이메일 형식을 먼저 확인해 주세요."; return; }
    button.disabled = true;
    try {
      const response = await fetch(`/api/users/check-${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [kind]: value }) });
      const body = await response.json();
      if (response.ok && body.available) {
        message.classList.add("is-success"); message.textContent = "사용할 수 있습니다.";
        if (isUsername) checkedUsername = value; else checkedEmail = value;
      } else { message.textContent = isUsername ? "이미 사용 중인 아이디입니다." : "이미 가입된 이메일입니다."; }
    } catch { message.textContent = "중복 확인 중 연결 오류가 발생했습니다."; }
    finally { button.disabled = false; }
  }
  usernameCheckButton?.addEventListener("click", () => checkSignupAvailability("username"));
  emailCheckButton?.addEventListener("click", () => checkSignupAvailability("email"));
  signupForm.elements.namedItem("username")?.addEventListener("input", () => { checkedUsername = ""; usernameCheckMessage.textContent = ""; });
  signupForm.elements.namedItem("email")?.addEventListener("input", () => { checkedEmail = ""; emailCheckMessage.textContent = ""; });
  const checkPasswordRule = () => {
    if (!passwordInput || !passwordRuleError) return true;
    const password = passwordInput.value;
    const passwordBytes = new TextEncoder().encode(password).length;
    const isValid = password.length >= 8 && passwordBytes <= 72;
    passwordRuleError.textContent = isValid
      ? ""
      : password
        ? "비밀번호는 8자 이상, 72바이트 이내로 입력해 주세요."
        : "비밀번호를 입력해 주세요.";
    passwordInput.toggleAttribute("aria-invalid", !isValid);
    return isValid;
  };
  const checkPasswordMatch = () => {
    if (!passwordConfirmInput || !passwordMatchError) return;
    passwordMatchError.textContent =
      !passwordConfirmInput.value || passwordInput.value === passwordConfirmInput.value
        ? ""
        : "비밀번호가 일치하지 않습니다.";
  };
  passwordInput?.addEventListener("blur", checkPasswordRule);
  passwordInput?.addEventListener("input", () => {
    if (passwordRuleError?.textContent) checkPasswordRule();
  });
  passwordInput?.addEventListener("input", checkPasswordMatch);
  passwordConfirmInput?.addEventListener("input", checkPasswordMatch);

  const signupSections = [...signupForm.querySelectorAll("[data-signup-step]")];
  const signupStepIndicators = [...document.querySelectorAll(".signup-recovery-steps li")];
  let activeSignupStep = 0;

  function setSignupStep(nextStep) {
    activeSignupStep = Math.max(0, Math.min(nextStep, signupSections.length - 1));
    signupSections.forEach((section, index) => { section.hidden = index !== activeSignupStep; });
    signupStepIndicators.forEach((indicator, index) => {
      indicator.classList.toggle("is-active", index === activeSignupStep);
      indicator.classList.toggle("is-complete", index < activeSignupStep);
    });
    signupMessage.textContent = "";
    document.querySelector(".signup-recovery-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      signupSections[activeSignupStep]?.querySelector("input:not([type='checkbox']):not([readonly])")?.focus({ preventScroll: true });
    }, 250);
  }

  function validateSignupStep(step) {
    clearSignupFieldErrors();
    const data = new FormData(signupForm);
    if (step === 0) {
      const name = String(data.get("name") || "").trim();
      const username = String(data.get("username") || "").trim().toLowerCase();
      const phoneDigits = String(data.get("phone") || "").replace(/\D/g, "");
      const email = String(data.get("email") || "").trim().toLowerCase();
      if (!name || name.length > 50) {
        showSignupFieldError(signupForm.elements.namedItem("name"), "이름을 입력해 주세요.");
        return false;
      }
      if (!/^[a-z0-9_]{4,20}$/.test(username)) {
        showSignupFieldError(signupForm.elements.namedItem("username"), "아이디는 영문 소문자, 숫자, 밑줄을 사용해 4~20자로 입력해 주세요.");
        return false;
      }
      if (checkedUsername !== username) {
        showSignupFieldError(signupForm.elements.namedItem("username"), "아이디 중복 확인을 완료해 주세요.", { focusTarget: usernameCheckButton });
        return false;
      }
      if (!/^01[0-9]{8,9}$/.test(phoneDigits)) {
        showSignupFieldError(phoneInput, "올바른 휴대폰 번호를 입력해 주세요.");
        return false;
      }
      if (!phoneVerified || phoneDigits !== verifiedPhoneDigits) {
        showSignupFieldError(phoneInput, "휴대폰 인증을 완료해 주세요.", { focusTarget: sendCodeButton });
        return false;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showSignupFieldError(signupForm.elements.namedItem("email"), "올바른 이메일 주소를 입력해 주세요.");
        return false;
      }
      if (checkedEmail !== email) {
        showSignupFieldError(signupForm.elements.namedItem("email"), "이메일 중복 확인을 완료해 주세요.", { focusTarget: emailCheckButton });
        return false;
      }
      return true;
    }
    if (step === 1) {
      const address = String(data.get("address") || "").trim();
      const addressDetail = String(data.get("addressDetail") || "").trim();
      const password = String(data.get("password") || "");
      const passwordConfirm = String(data.get("passwordConfirm") || "");
      const passwordBytes = new TextEncoder().encode(password).length;
      if (!address) {
        showSignupFieldError(addressInput, "주소 검색을 눌러 배송지 주소를 입력해 주세요.", { focusTarget: addressSearchButton });
        return false;
      }
      if (addressDetail.length > 200) {
        showSignupFieldError(addressDetailInput, "상세 주소는 200자 이내로 입력해 주세요.");
        return false;
      }
      if (password.length < 8 || passwordBytes > 72) {
        showSignupFieldError(passwordInput, "비밀번호는 8자 이상, 72바이트 이내로 입력해 주세요.");
        return false;
      }
      if (password !== passwordConfirm) {
        showSignupFieldError(passwordConfirmInput, "비밀번호가 일치하지 않습니다.");
        return false;
      }
      return true;
    }
    return true;
  }

  signupForm.querySelectorAll("[data-signup-next]").forEach((button) => {
    button.addEventListener("click", () => {
      if (validateSignupStep(activeSignupStep)) setSignupStep(activeSignupStep + 1);
    });
  });
  signupForm.querySelectorAll("[data-signup-prev]").forEach((button) => {
    button.addEventListener("click", () => setSignupStep(activeSignupStep - 1));
  });
  function clearSignupFieldErrors() {
    signupForm.querySelectorAll(".auth-submit-field-error").forEach((message) => message.remove());
    signupForm.querySelectorAll('[aria-invalid="true"]').forEach((field) => field.removeAttribute("aria-invalid"));
  }

  function showSignupFieldError(field, message, options = {}) {
    const container = options.container || field?.closest("label");
    if (!container) {
      signupMessage.textContent = message;
      return;
    }

    const error = document.createElement("p");
    error.className = "auth-field-error auth-submit-field-error";
    error.setAttribute("role", "alert");
    error.textContent = message;
    error.id = `auth-error-${field?.name || "field"}-${Date.now()}`;
    container.append(error);
    field?.setAttribute("aria-invalid", "true");
    if (field) field.setAttribute("aria-describedby", [field.getAttribute("aria-describedby"), error.id].filter(Boolean).join(" "));

    container.scrollIntoView({ behavior: "smooth", block: "center" });
    const focusTarget = options.focusTarget || field;
    window.setTimeout(() => focusTarget?.focus({ preventScroll: true }), 250);
  }

  ["input", "change"].forEach((eventName) => {
    signupForm.addEventListener(eventName, (event) => {
      const container = event.target.closest("label, .auth-agree-group");
      const submitError = container?.querySelector(".auth-submit-field-error");
      if (submitError) {
        const describedBy = (event.target.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== submitError.id);
        submitError.remove();
        event.target.removeAttribute("aria-invalid");
        if (describedBy.length) event.target.setAttribute("aria-describedby", describedBy.join(" "));
        else event.target.removeAttribute("aria-describedby");
      }
    });
  });

  signupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    signupMessage.classList.remove("is-success");
    signupMessage.textContent = "";
    clearSignupFieldErrors();

    const data = new FormData(signupForm);
    const name = String(data.get("name") || "").trim();
    const username = String(data.get("username") || "").trim().toLowerCase();
    const phoneDigits = String(data.get("phone") || "").replace(/\D/g, "");
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const passwordConfirm = String(data.get("passwordConfirm") || "");
    const postalCode = String(data.get("postalCode") || "").trim();
    const address = String(data.get("address") || "").trim();
    const addressDetail = String(data.get("addressDetail") || "").trim();
    const agreeTerms = Boolean(data.get("agreeTerms"));
    const agreePrivacy = Boolean(data.get("agreePrivacy"));
    const agreeMarketing = Boolean(data.get("agreeMarketing"));

    // 서버(server/utils/normalize.js, server/routes/users.js)와 최대한 동일한 규칙으로 검사
    if (!name || name.length > 50) {
      showSignupFieldError(signupForm.elements.namedItem("name"), "이름을 입력해 주세요.");
      return;
    }
    if (!/^[a-z0-9_]{4,20}$/.test(username)) {
      showSignupFieldError(signupForm.elements.namedItem("username"), "아이디는 영문 소문자, 숫자, 밑줄을 사용해 4~20자로 입력해 주세요.");
      return;
    }
    if (checkedUsername !== username) {
      showSignupFieldError(signupForm.elements.namedItem("username"), "아이디 중복 확인을 완료해 주세요.", { focusTarget: usernameCheckButton });
      return;
    }
    if (!phoneDigits || !/^01[0-9]{8,9}$/.test(phoneDigits)) {
      showSignupFieldError(phoneInput, "올바른 휴대폰 번호를 입력해 주세요.");
      return;
    }
    if (!phoneVerified || phoneDigits !== verifiedPhoneDigits) {
      showSignupFieldError(phoneInput, "인증번호 받기를 눌러 휴대폰 인증을 완료해 주세요.", { focusTarget: sendCodeButton });
      return;
    }
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showSignupFieldError(signupForm.elements.namedItem("email"), "올바른 이메일 주소를 입력해 주세요.");
      return;
    }
    if (checkedEmail !== email.toLowerCase()) {
      showSignupFieldError(signupForm.elements.namedItem("email"), "이메일 중복 확인을 완료해 주세요.", { focusTarget: emailCheckButton });
      return;
    }
    if (!address || address.length > 200) {
      showSignupFieldError(addressInput, "주소 검색을 눌러 배송지 주소를 입력해 주세요.", { focusTarget: addressSearchButton });
      return;
    }
    if (addressDetail.length > 200) {
      showSignupFieldError(addressDetailInput, "상세 주소는 200자 이내로 입력해 주세요.");
      return;
    }
    // bcrypt는 72바이트를 넘는 입력을 조용히 잘라버리므로 문자 길이가 아닌 UTF-8 바이트로 검사한다
    const passwordBytes = new TextEncoder().encode(password).length;
    if (password.length < 8 || passwordBytes > 72) {
      passwordRuleError.textContent = "";
      showSignupFieldError(passwordInput, "비밀번호는 8자 이상, 72바이트 이내로 입력해 주세요.");
      return;
    }
    if (password !== passwordConfirm) {
      passwordMatchError.textContent = "";
      showSignupFieldError(passwordConfirmInput, "비밀번호가 일치하지 않습니다.");
      return;
    }
    if (!agreeTerms || !agreePrivacy) {
      const firstUncheckedAgreement = !agreeTerms
        ? signupForm.elements.namedItem("agreeTerms")
        : signupForm.elements.namedItem("agreePrivacy");
      showSignupFieldError(firstUncheckedAgreement, "필수 약관에 동의해 주세요.", {
        container: signupForm.querySelector(".auth-agree-group"),
      });
      return;
    }

    runFormSubmit(signupSubmitButton, "가입 처리 중...", async () => {
      try {
        // 고객 인증은 HttpOnly Cookie 방식이라 관리자용 apiFetch()(Authorization 헤더/sessionStorage 토큰)를
        // 쓰지 않고 일반 fetch로 호출한다. 같은 오리진이라 credentials는 명시하지 않아도 쿠키가 오가지만
        // 의도를 명확히 하기 위해 "same-origin"을 지정한다.
        const res = await fetch("/api/users/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            username, email, password, name,
            phone: phoneDigits,
            postalCode: postalCode || undefined,
            address,
            addressDetail: addressDetail || undefined,
            agreeTerms, agreePrivacy, agreeMarketing,
          }),
        });

        let body = null;
        try { body = await res.json(); } catch {}

        if (res.ok) {
          signupMessage.classList.add("is-success");
          signupMessage.textContent = "가입이 완료되었습니다. 홈으로 이동합니다.";
          if (signupSubmitButton) signupSubmitButton.textContent = "이동 중...";
          const requestedNext = new URLSearchParams(window.location.search).get("next");
          const safeNext = requestedNext && /^[a-z0-9_-]+\.html(?:[?#].*)?$/i.test(requestedNext) ? requestedNext : "index.html";
          setTimeout(() => { window.location.href = safeNext; }, 900);
          return true; // 리다이렉트 전까지 버튼 비활성 유지
        }

        signupMessage.textContent = describeAuthError(res.status, body, "입력값을 다시 확인해 주세요.");
        return false;
      } catch {
        signupMessage.textContent = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.";
        return false;
      }
    });
  });
}

// 모든 인증 화면의 비밀번호 입력란에 접근 가능한 표시/숨김 버튼을 공통 적용한다.
document.querySelectorAll('input[type="password"]').forEach((input) => {
  if (input.parentElement?.classList.contains("password-visibility-field")) return;
  const wrapper = document.createElement("div");
  wrapper.className = "password-visibility-field";
  input.parentNode.insertBefore(wrapper, input);
  wrapper.append(input);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "password-visibility-button";
  button.textContent = "보기";
  button.setAttribute("aria-label", "비밀번호 표시");
  button.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "숨김" : "보기";
    button.setAttribute("aria-label", show ? "비밀번호 숨기기" : "비밀번호 표시");
  });
  wrapper.append(button);
});

// ─── 비밀번호 찾기 / 재설정 ──────────────────────────────────
const findUsernameForm = document.querySelector("[data-find-username-form]");
if (findUsernameForm) {
  const message = findUsernameForm.querySelector("[data-find-username-message]");
  const result = findUsernameForm.querySelector("[data-find-username-result]");
  const usernameText = findUsernameForm.querySelector("[data-found-username]");
  const phoneInput = findUsernameForm.querySelector("[data-find-phone]");
  const codeInput = findUsernameForm.querySelector("[data-find-code]");
  const codeField = findUsernameForm.querySelector("[data-find-code-field]");
  const codeMessage = findUsernameForm.querySelector("[data-find-code-message]");
  const sendCodeButton = findUsernameForm.querySelector("[data-find-send-code]");
  const verifyCodeButton = findUsernameForm.querySelector("[data-find-verify-code]");
  const submitButton = findUsernameForm.querySelector("[data-find-submit]");
  const steps = [...document.querySelectorAll(".find-username-steps li")];
  let verifiedPhone = "";
  const setFindUsernameStep = (activeIndex) => {
    steps.forEach((step, index) => {
      step.classList.toggle("is-active", index === activeIndex);
      step.classList.toggle("is-complete", index < activeIndex);
    });
  };

  phoneInput.addEventListener("input", () => {
    if (phoneInput.value.replace(/\D/g, "") !== verifiedPhone) {
      verifiedPhone = "";
      submitButton.disabled = true;
    }
  });

  sendCodeButton.addEventListener("click", async () => {
    const phone = phoneInput.value.replace(/\D/g, "");
    codeMessage.textContent = "";
    if (!/^01\d{8,9}$/.test(phone)) {
      codeMessage.textContent = "휴대폰 번호를 정확히 입력해 주세요.";
      return;
    }
    sendCodeButton.disabled = true;
    try {
      const response = await fetch("/api/phone/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "인증번호를 발송하지 못했습니다.");
      codeField.hidden = false;
      codeMessage.textContent = "인증번호를 발송했습니다. 5분 이내에 입력해 주세요.";
      setFindUsernameStep(1);
      codeInput.focus();
    } catch (error) {
      codeMessage.textContent = error.message;
    } finally {
      sendCodeButton.disabled = false;
    }
  });

  verifyCodeButton.addEventListener("click", async () => {
    const phone = phoneInput.value.replace(/\D/g, "");
    const code = codeInput.value.trim();
    codeMessage.textContent = "";
    if (!/^\d{6}$/.test(code)) {
      codeMessage.textContent = "6자리 인증번호를 입력해 주세요.";
      return;
    }
    verifyCodeButton.disabled = true;
    try {
      const response = await fetch("/api/phone/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.verified) throw new Error(payload.error || "인증번호를 확인해 주세요.");
      verifiedPhone = phone;
      phoneInput.readOnly = true;
      codeInput.readOnly = true;
      sendCodeButton.disabled = true;
      submitButton.disabled = false;
      codeMessage.textContent = "휴대폰 인증이 완료되었습니다.";
      setFindUsernameStep(2);
    } catch (error) {
      codeMessage.textContent = error.message;
    } finally {
      verifyCodeButton.disabled = false;
    }
  });

  findUsernameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(findUsernameForm);
    const name = String(data.get("name") || "").trim();
    const phone = String(data.get("phone") || "").replace(/\D/g, "");
    message.textContent = "";
    result.hidden = true;
    if (!name || phone !== verifiedPhone) {
      message.textContent = "이름을 입력하고 휴대폰 인증을 완료해 주세요.";
      return;
    }
    submitButton.disabled = true;
    try {
      const response = await fetch("/api/users/find-username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "아이디를 찾지 못했습니다.");
      usernameText.textContent = payload.username;
      result.hidden = false;
      setFindUsernameStep(2);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });
}

const passwordResetRequestForm = document.querySelector("[data-password-reset-request-form]");
if (passwordResetRequestForm) {
  const message = passwordResetRequestForm.querySelector("[data-password-reset-request-message]");
  const result = passwordResetRequestForm.querySelector("[data-demo-reset-result]");
  const resetLink = passwordResetRequestForm.querySelector("[data-demo-reset-link]");
  const submitButton = passwordResetRequestForm.querySelector('[type="submit"]');

  passwordResetRequestForm.addEventListener("submit", (event) => {
    event.preventDefault();
    message.classList.remove("is-success");
    message.textContent = "";
    result.hidden = true;
    const identifier = String(new FormData(passwordResetRequestForm).get("identifier") || "").trim();
    if (!identifier) {
      message.textContent = "아이디 또는 이메일을 입력해 주세요.";
      return;
    }

    runFormSubmit(submitButton, "확인 중...", async () => {
      try {
        const response = await fetch("/api/users/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          message.textContent = body?.error || "요청을 처리하지 못했습니다.";
          return false;
        }
        message.classList.add("is-success");
        message.textContent = body.message;
        result.hidden = true;
        return false;
      } catch {
        message.textContent = "서버에 연결할 수 없습니다.";
        return false;
      }
    });
  });
}

const passwordResetConfirmForm = document.querySelector("[data-password-reset-confirm-form]");
if (passwordResetConfirmForm) {
  const message = passwordResetConfirmForm.querySelector("[data-password-reset-confirm-message]");
  const submitButton = passwordResetConfirmForm.querySelector('[type="submit"]');
  const token = new URLSearchParams(window.location.search).get("token") || "";

  fetch(`/api/users/password-reset/validate?token=${encodeURIComponent(token)}`)
    .then((response) => {
      if (response.ok) return;
      submitButton.disabled = true;
      message.textContent = "재설정 링크가 만료되었거나 이미 사용되었습니다.";
    })
    .catch(() => {
      submitButton.disabled = true;
      message.textContent = "재설정 링크를 확인할 수 없습니다.";
    });

  passwordResetConfirmForm.addEventListener("submit", (event) => {
    event.preventDefault();
    message.classList.remove("is-success");
    message.textContent = "";
    const data = new FormData(passwordResetConfirmForm);
    const password = String(data.get("password") || "");
    const passwordConfirm = String(data.get("passwordConfirm") || "");
    if (password.length < 8 || new TextEncoder().encode(password).length > 72) {
      message.textContent = "비밀번호는 8자 이상, 72바이트 이내로 입력해 주세요.";
      return;
    }
    if (password !== passwordConfirm) {
      message.textContent = "비밀번호가 일치하지 않습니다.";
      return;
    }

    runFormSubmit(submitButton, "변경 중...", async () => {
      try {
        const response = await fetch("/api/users/password-reset/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, password }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          message.textContent = body?.error || "비밀번호를 변경하지 못했습니다.";
          return false;
        }
        message.classList.add("is-success");
        message.textContent = "비밀번호가 변경되었습니다. 로그인 페이지로 이동합니다.";
        window.setTimeout(() => { window.location.href = "login.html"; }, 1200);
        return true;
      } catch {
        message.textContent = "서버에 연결할 수 없습니다.";
        return false;
      }
    });
  });
}

// ─── 로그인 ──────────────────────────────────────────────────
const loginForm = document.querySelector("[data-login-form]");
if (loginForm) {
  const safeLoginNext = (() => {
    const next = new URLSearchParams(window.location.search).get("next") || "index.html";
    return /^(?:[a-z0-9-]+\.html)(?:[?#].*)?$/i.test(next) ? next : "index.html";
  })();
  const loginMessage = loginForm.querySelector("[data-login-message]");
  const loginSubmitButton = loginForm.querySelector('[type="submit"]');
  const socialLoginMessage = document.querySelector("[data-social-login-message]");
  const socialError = new URLSearchParams(window.location.search).get("social_error");
  const pendingSocialProvider = new URLSearchParams(window.location.search).get("social_link");
  const socialProviderLabels = { kakao: "카카오", naver: "네이버", google: "Google" };
  if (socialError) {
    socialLoginMessage.textContent = socialError;
    window.history.replaceState({}, "", window.location.pathname);
  } else if (pendingSocialProvider && socialProviderLabels[pendingSocialProvider]) {
    socialLoginMessage.textContent = `${socialProviderLabels[pendingSocialProvider]} 계정을 연결하려면 기존 따뜻한 떡집 아이디와 비밀번호를 입력해 주세요. 최초 1회만 필요합니다.`;
  }

  const socialButtons = [...document.querySelectorAll("[data-social-provider]")];
  fetch("/api/auth/social/providers", { credentials: "same-origin" })
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then((body) => {
      const enabled = new Set(body.providers || []);
      socialButtons.forEach((button) => {
        if (enabled.has(button.dataset.socialProvider)) {
          button.removeAttribute("aria-disabled");
          button.removeAttribute("title");
          return;
        }
        button.setAttribute("aria-disabled", "true");
        button.title = "소셜 로그인 API 키 설정 후 사용할 수 있습니다.";
      });
    })
    .catch(() => {});

  socialButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      if (button.getAttribute("aria-disabled") === "true") {
        event.preventDefault();
        socialLoginMessage.textContent = "해당 소셜 로그인은 API 키 설정 후 사용할 수 있습니다.";
        return;
      }
    });
  });

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loginMessage.classList.remove("is-success");
    loginMessage.textContent = "";

    const data = new FormData(loginForm);
    const identifier = String(data.get("identifier") || "").trim();
    // 비밀번호는 trim하지 않는다 — 앞뒤 공백도 비밀번호의 일부일 수 있음
    const password = String(data.get("password") || "");

    if (!identifier) {
      loginMessage.textContent = "아이디를 입력해 주세요.";
      return;
    }
    if (!password) {
      loginMessage.textContent = "비밀번호를 입력해 주세요.";
      return;
    }
    if (new TextEncoder().encode(password).length > 72) {
      loginMessage.textContent = "비밀번호 길이를 확인해 주세요.";
      return;
    }

    runFormSubmit(loginSubmitButton, "로그인 중...", async () => {
      try {
        const res = await fetch("/api/users/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ identifier, password }),
        });

        let body = null;
        try { body = await res.json(); } catch {}

        if (res.ok) {
          window.PurchaseAccess?.clearGuest();
          loginMessage.classList.add("is-success");
          loginMessage.textContent = body?.socialLinkError
            ? body.socialLinkError
            : body?.socialLinked
              ? `${socialProviderLabels[body.socialLinked] || "소셜"} 계정 연결과 로그인이 완료되었습니다.`
              : "로그인되었습니다. 이전 화면으로 이동합니다.";
          if (loginSubmitButton) loginSubmitButton.textContent = "이동 중...";
          setTimeout(() => { window.location.href = safeLoginNext; }, 1200);
          return true;
        }

        loginMessage.textContent = describeAuthError(res.status, body, "아이디 또는 비밀번호가 올바르지 않습니다.");
        return false;
      } catch {
        loginMessage.textContent = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.";
        return false;
      }
    });
  });

  const guestCheckoutLink = document.querySelector("[data-guest-checkout]");
  if (guestCheckoutLink) guestCheckoutLink.href = `guest-order.html?next=${encodeURIComponent(safeLoginNext)}`;
}

const guestOrderForm = document.querySelector("[data-guest-order-form]");
if (guestOrderForm) {
  const message = guestOrderForm.querySelector("[data-guest-order-message]");
  const phoneInput = guestOrderForm.querySelector("[data-guest-phone]");
  const codeRow = guestOrderForm.querySelector("[data-guest-code-row]");
  const codeInput = guestOrderForm.querySelector("[data-guest-code]");
  const codeMessage = guestOrderForm.querySelector("[data-guest-code-message]");
  let verifiedPhone = "";
  const nextParam = new URLSearchParams(window.location.search).get("next") || "menu.html#menu-list";
  const safeNext = /^(?:[a-z0-9-]+\.html)(?:[?#].*)?$/i.test(nextParam) ? nextParam : "menu.html#menu-list";

  guestOrderForm.querySelector("[data-guest-address-search]")?.addEventListener("click", () => {
    const Postcode = window.kakao?.Postcode || window.daum?.Postcode;
    if (!Postcode) {
      message.textContent = "주소 검색 서비스를 불러오지 못했습니다.";
      return;
    }
    new Postcode({ oncomplete(data) {
      guestOrderForm.elements.postalCode.value = data.zonecode || "";
      guestOrderForm.elements.address.value = data.roadAddress || data.jibunAddress || "";
      guestOrderForm.elements.addressDetail.focus();
    }}).open();
  });

  guestOrderForm.querySelector("[data-guest-send-code]")?.addEventListener("click", async () => {
    codeMessage.textContent = "";
    verifiedPhone = "";
    try {
      const response = await fetch("/api/phone/send-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: phoneInput.value }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      codeRow.hidden = false;
      codeMessage.textContent = "인증번호를 발송했습니다. 5분 이내에 입력해 주세요.";
      codeInput.focus();
    } catch (error) {
      codeMessage.textContent = error.message || "인증번호를 발송하지 못했습니다.";
    }
  });

  guestOrderForm.querySelector("[data-guest-verify-code]")?.addEventListener("click", async () => {
    try {
      const response = await fetch("/api/phone/verify-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: phoneInput.value, code: codeInput.value }) });
      const body = await response.json();
      if (!response.ok || !body.verified) throw new Error(body.error);
      verifiedPhone = phoneInput.value.replace(/\D/g, "");
      codeMessage.classList.add("is-success");
      codeMessage.textContent = "휴대폰 인증이 완료되었습니다.";
    } catch (error) {
      codeMessage.classList.remove("is-success");
      codeMessage.textContent = error.message || "인증번호를 확인해 주세요.";
    }
  });

  phoneInput.addEventListener("input", () => {
    if (verifiedPhone && phoneInput.value.replace(/\D/g, "") !== verifiedPhone) {
      verifiedPhone = "";
      codeMessage.classList.remove("is-success");
      codeMessage.textContent = "번호가 변경되어 다시 인증해야 합니다.";
    }
  });

  guestOrderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    message.textContent = "";
    if (!guestOrderForm.checkValidity()) {
      guestOrderForm.reportValidity();
      return;
    }
    const data = new FormData(guestOrderForm);
    const customer = String(data.get("customer") || "").trim();
    const phone = String(data.get("phone") || "").replace(/\D/g, "");
    const password = String(data.get("guestPassword") || "");
    if (customer.length < 2) {
      message.textContent = "이름을 2자 이상 입력해 주세요.";
      return;
    }
    if (!/^01[016789]\d{7,8}$/.test(phone)) {
      message.textContent = "올바른 휴대폰 번호를 입력해 주세요.";
      return;
    }
    if (verifiedPhone !== phone) {
      message.textContent = "휴대폰 인증을 완료해 주세요.";
      return;
    }
    if (new TextEncoder().encode(password).length < 8 || new TextEncoder().encode(password).length > 72) {
      message.textContent = "비밀번호는 8자 이상 72바이트 이하로 입력해 주세요.";
      return;
    }
    if (password !== String(data.get("guestPasswordConfirm") || "")) {
      message.textContent = "비밀번호 확인이 일치하지 않습니다.";
      return;
    }
    const address = [data.get("address"), data.get("addressDetail")].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
    window.PurchaseAccess?.saveGuest({ customer, phone, postalCode: String(data.get("postalCode") || ""), address, password });
    window.location.href = window.PurchaseAccess?.hasCartItems() ? "checkout.html" : safeNext;
  });
}

const guestOrderLookupForm = document.querySelector("[data-guest-order-lookup-form]");
if (guestOrderLookupForm) {
  const message = guestOrderLookupForm.querySelector("[data-guest-lookup-message]");
  const result = document.querySelector("[data-guest-order-result]");
  guestOrderLookupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    result.hidden = true;
    if (!guestOrderLookupForm.checkValidity()) {
      guestOrderLookupForm.reportValidity();
      return;
    }
    const data = new FormData(guestOrderLookupForm);
    try {
      const response = await fetch("/api/orders/guest/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: data.get("orderId"), phone: data.get("phone"), password: data.get("password") }),
      });
      const order = await response.json();
      if (!response.ok) throw new Error(order.error);
      result.querySelector("[data-guest-result-id]").textContent = order.id || "-";
      result.querySelector("[data-guest-result-product]").textContent = order.product || "-";
      result.querySelector("[data-guest-result-status]").textContent = order.status || "-";
      result.querySelector("[data-guest-result-pickup]").textContent = [order.pickupDate, order.pickupTime].filter(Boolean).join(" ") || "일정 확인 중";
      result.querySelector("[data-guest-result-total]").textContent = `${Number(order.totalAmount || 0).toLocaleString("ko-KR")}원`;
      result.hidden = false;
    } catch (error) {
      message.textContent = error.message || "주문 정보를 확인하지 못했습니다.";
    }
  });
}

// ─── 헤더 로그인 상태 표시 (index/menu/faq/signup/login 공통) ──
const authSignupLink = document.querySelector("[data-auth-signup-link]");
const authLoginLink = document.querySelector("[data-auth-login-link]");
const adminHeaderLink = document.querySelector("[data-admin-link]");
if (authSignupLink && authLoginLink) {
  const applyGuestHeader = () => {
    if (adminHeaderLink) adminHeaderLink.hidden = true;
    authSignupLink.textContent = "회원가입";
    authSignupLink.href = "signup.html";
    authSignupLink.removeAttribute("role");
    authSignupLink.onclick = null;
    authLoginLink.textContent = "로그인";
    authLoginLink.href = "login.html";
    authLoginLink.removeAttribute("role");
    authLoginLink.onclick = null;
    window.dispatchEvent(new CustomEvent("tteok-auth-state", { detail: { authenticated: false } }));
  };

  const applyMemberHeader = (user) => {
    if (adminHeaderLink) adminHeaderLink.hidden = user?.role !== "admin";
    authSignupLink.textContent = "마이페이지";
    authSignupLink.href = "mypage.html";
    authSignupLink.removeAttribute("role");
    authSignupLink.onclick = null;
    authLoginLink.textContent = "로그아웃";
    authLoginLink.href = "#";
    authLoginLink.setAttribute("role", "button");
    window.dispatchEvent(new CustomEvent("tteok-auth-state", { detail: { authenticated: true } }));
    authLoginLink.onclick = (event) => {
      event.preventDefault();
      if (authLoginLink.getAttribute("aria-busy") === "true") return;
      authLoginLink.setAttribute("aria-busy", "true");
      authLoginLink.textContent = "로그아웃 중...";
      const transitionNotice = showInlineNotice("안전하게 로그아웃하고 있습니다...", 2200);
      const minimumDelay = new Promise((resolve) => setTimeout(resolve, 850));
      // 고객 쿠키만 제거한다 — 관리자용 tteokApiToken(sessionStorage)은 손대지 않음
      Promise.all([
        fetch("/api/users/logout", { method: "POST", credentials: "same-origin" }).catch(() => null),
        minimumDelay,
      ])
        .catch(() => {})
        .finally(() => {
          transitionNotice?.remove();
          applyGuestHeader();
          showInlineNotice("로그아웃되었습니다. 다음에 또 만나요!", 2600);
          window.setTimeout(() => {
            window.location.replace("index.html");
          }, 900);
        });
    };
  };

  fetch("/api/users/me", { credentials: "same-origin" })
    .then((res) => (res.status === 200 ? res.json() : null))
    .then((body) => {
      if (body?.user) {
        applyMemberHeader(body.user);
        if (body.user.role !== "admin" && adminHeaderLink) {
          fetch("/api/users/admin-session", { method: "POST", credentials: "same-origin" })
            .then((response) => { if (response.ok) adminHeaderLink.hidden = false; })
            .catch(() => {});
        }
      } else {
        applyGuestHeader();
      }
    })
    .catch(() => {
      // 네트워크 오류 시에도 비로그인 기본 상태(정적 HTML 그대로)를 유지하고 페이지 기능은 막지 않는다
    });
}
