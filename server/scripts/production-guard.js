function assertNonProductionScript(label = "데모·시드 스크립트") {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`운영 환경에서는 ${label}를 실행할 수 없습니다.`);
  }
}

function assertStagingScript(label = "staging 스크립트", env = process.env) {
  if (env.NODE_ENV !== "production" || String(env.APP_ENV || "").trim().toLowerCase() !== "staging") {
    throw new Error(`운영 환경에서는 ${label}를 승인된 staging 환경이 아니면 실행할 수 없습니다.`);
  }
}

function assertStagingSeedAllowed(label = "staging synthetic 작업", env = process.env) {
  assertStagingScript(label, env);
  if (env.ALLOW_STAGING_SEED !== "true") {
    throw new Error(`${label}는 명시적인 staging 실행 승인이 필요합니다.`);
  }
}

module.exports = { assertNonProductionScript, assertStagingScript, assertStagingSeedAllowed };
