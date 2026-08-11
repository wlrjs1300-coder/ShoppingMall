const { createNaverOrderSyncService } = require("./naver-order-sync-service");

const DEFAULT_INTERVAL_MS = 120000;
const DEFAULT_INITIAL_LOOKBACK_MINUTES = 10;
const DEFAULT_STARTUP_DELAY_MS = 5000;

function createNaverOrderPollScheduler({
  db,
  service = db ? createNaverOrderSyncService({ db }) : null,
  enabled = process.env.NAVER_COMMERCE_SYNC_ENABLED === "true"
    && process.env.NAVER_ORDER_IMPORT_ENABLED === "true",
  intervalMs = Number(process.env.NAVER_ORDER_POLL_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  initialLookbackMinutes = Number(
    process.env.NAVER_ORDER_INITIAL_LOOKBACK_MINUTES || DEFAULT_INITIAL_LOOKBACK_MINUTES,
  ),
  startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  let timer = null;
  let running = false;
  let stopped = false;

  function schedule(delay) {
    if (stopped || !enabled) return;
    timer = setTimer(run, delay);
    timer?.unref?.();
  }

  async function run() {
    if (stopped || !enabled) return;
    if (running) {
      schedule(intervalMs);
      return;
    }
    running = true;
    try {
      const initialLastChangedFrom = new Date(
        now().getTime() - initialLookbackMinutes * 60000,
      ).toISOString();
      const result = await service.pullOrderImports({
        initialLastChangedFrom,
        actor: "system:naver-order-poller",
      });
      logger.info?.(JSON.stringify({
        level: "info",
        event: "naver_order_poll_completed",
        status: result.status,
        importedCount: result.importedCount,
        failedCount: result.failedCount,
      }));
    } catch (error) {
      logger.error?.(JSON.stringify({
        level: "error",
        event: "naver_order_poll_failed",
        code: error?.code || error?.reason || "ORDER_IMPORT_PROVIDER_UNAVAILABLE",
      }));
    } finally {
      running = false;
      schedule(intervalMs);
    }
  }

  function start() {
    if (!enabled || stopped || timer || running) return false;
    schedule(startupDelayMs);
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { isEnabled: () => enabled, isRunning: () => running, run, start, stop };
}

module.exports = {
  DEFAULT_INITIAL_LOOKBACK_MINUTES,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  createNaverOrderPollScheduler,
};
