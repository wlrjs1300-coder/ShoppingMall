function assertNonProductionScript(label = "데모·시드 스크립트") {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`운영 환경에서는 ${label}를 실행할 수 없습니다.`);
  }
}

module.exports = { assertNonProductionScript };
