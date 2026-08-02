const { productionConfigErrors } = require("../config");
const { assertProviderDisabled, stagingBaseUrl } = require("./run-staging-smoke");

class StagingRehearsalGuardError extends Error {
  constructor(code) {
    super("Staging rehearsal readiness check failed.");
    this.name = "StagingRehearsalGuardError";
    this.code = code;
  }
}

function fail(code) {
  throw new StagingRehearsalGuardError(code);
}

function checkStagingRehearsal(env = process.env) {
  if (env.NODE_ENV !== "production") fail("STAGING_RUNTIME_REQUIRED");
  if (String(env.APP_ENV || "").trim().toLowerCase() !== "staging") fail("STAGING_APP_ENV_REQUIRED");

  if (productionConfigErrors(env).length) fail("STAGING_CONFIGURATION_INVALID");
  try {
    assertProviderDisabled(env);
  } catch {
    fail("STAGING_PROVIDERS_NOT_DISABLED");
  }
  try {
    const baseUrl = stagingBaseUrl(env);
    const labels = new URL(baseUrl).hostname.toLowerCase().split(".");
    if (labels.some((label) => ["prod", "production"].includes(label))) throw new Error();
  } catch {
    fail("STAGING_BASE_URL_INVALID");
  }

  return Object.freeze({
    appEnvironment: "staging",
    databaseIdentity: "staging",
    backupIdentity: "external",
    providers: "disabled",
    baseUrlStatus: "matched",
    ready: true,
  });
}

function main() {
  require("dotenv").config();
  try {
    const result = checkStagingRehearsal(process.env);
    console.log(Object.entries(result).map(([key, value]) => `${key}=${value}`).join(" "));
  } catch (error) {
    const code = error instanceof StagingRehearsalGuardError
      ? error.code : "STAGING_REHEARSAL_CHECK_FAILED";
    console.error(`staging rehearsal check failed: safeCategory=${code}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { StagingRehearsalGuardError, checkStagingRehearsal };
