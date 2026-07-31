const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class OperationsRunnerError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = "OperationsRunnerError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function makeError(options, code, message, exitCode) {
  return options.errorFactory?.(code, message, exitCode)
    || new OperationsRunnerError(code, message, exitCode);
}

function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runBusyRetry(action, options = {}) {
  const sleep = options.sleep || defaultSleep;
  const retries = options.busyRetries ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      const busy = error?.code === "SQLITE_BUSY" || error?.errcode === 5;
      if (!busy || attempt >= retries) throw error;
      sleep(25 * (2 ** attempt));
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readLock(file, options) {
  let raw;
  let parsed;
  try {
    raw = fs.readFileSync(file, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    throw makeError(options, options.lockConflictCode, "Existing runner lock is unreadable.", 8);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
    || typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt))
    || typeof parsed.mode !== "string" || !parsed.mode
    || typeof parsed.ownerToken !== "string" || !parsed.ownerToken) {
    throw makeError(options, options.lockConflictCode, "Existing runner lock is invalid.", 8);
  }
  return { raw, parsed };
}

function acquireRunnerLock(lockPath, mode, options = {}) {
  const settings = { lockConflictCode: "OPERATIONS_LOCK_CONFLICT", ...options };
  const resolved = path.resolve(lockPath);
  const staleMs = settings.staleMs || 6 * 60 * 60 * 1000;
  const processAlive = settings.isProcessAlive || isProcessAlive;
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    const existing = readLock(resolved, settings);
    if (Date.now() - stat.mtimeMs <= staleMs || processAlive(existing.parsed.pid)) {
      throw makeError(settings, settings.lockConflictCode, "Another runner is active.", 8);
    }
    let current;
    try { current = fs.readFileSync(resolved, "utf8"); } catch {}
    if (current !== existing.raw) {
      throw makeError(settings, settings.lockConflictCode, "Runner lock changed during takeover.", 8);
    }
    try { fs.rmSync(resolved); } catch {
      throw makeError(settings, settings.lockConflictCode, "Stale runner lock could not be replaced.", 8);
    }
  }
  const ownerToken = crypto.randomUUID();
  try {
    fs.writeFileSync(resolved, `${JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), mode, ownerToken,
    })}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    throw makeError(settings, settings.lockConflictCode, "Another runner is active.", 8);
  }
  return () => {
    try {
      const current = readLock(resolved, settings);
      if (current.parsed.ownerToken === ownerToken) fs.rmSync(resolved);
    } catch {}
  };
}

function writeSafeJsonlReport(reportPath, records, allowlist, options = {}) {
  const destination = path.resolve(reportPath);
  if (fs.existsSync(destination)) {
    throw makeError(options, options.reportExistsCode || "OPERATIONS_REPORT_EXISTS",
      "Report path already exists.", 2);
  }
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);
  const safeRecords = records.map((record) => Object.fromEntries(
    allowlist.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]),
  ));
  try {
    fs.writeFileSync(temporary, safeRecords.map(JSON.stringify).join("\n")
      + (safeRecords.length ? "\n" : ""), { encoding: "utf8", flag: "wx" });
    fs.linkSync(temporary, destination);
    fs.rmSync(temporary);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw makeError(options, options.reportFailedCode || "OPERATIONS_REPORT_FAILED",
      "Safe report could not be written.", 6);
  }
  return destination;
}

module.exports = {
  OperationsRunnerError,
  acquireRunnerLock,
  isProcessAlive,
  runBusyRetry,
  writeSafeJsonlReport,
};
