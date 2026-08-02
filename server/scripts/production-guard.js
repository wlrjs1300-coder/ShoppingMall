function assertNonProductionScript(label = "데모·시드 스크립트") {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`운영 환경에서는 ${label}를 실행할 수 없습니다.`);
  }
}

function assertStagingScript(label = "staging 스크립트", env = process.env) {
  if (env.NODE_ENV !== "production" || String(env.APP_ENV || "").trim().toLowerCase() !== "staging") {
    throw new Error(`${label}는 승인된 staging 환경에서만 실행할 수 있습니다.`);
  }
}

module.exports = { assertNonProductionScript, assertStagingScript };
