const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createNaverOrderPollScheduler,
} = require("../services/naver-order-poll-scheduler");

test("disabled poller does not schedule provider work", () => {
  let scheduled = 0;
  const poller = createNaverOrderPollScheduler({
    service: {}, enabled: false, setTimer: () => { scheduled += 1; },
  });
  assert.equal(poller.start(), false);
  assert.equal(scheduled, 0);
});

test("poller imports from the initial lookback and schedules its next run", async () => {
  const timers = [];
  const calls = [];
  const logs = [];
  const poller = createNaverOrderPollScheduler({
    service: {
      pullOrderImports: async (input) => {
        calls.push(input);
        return { status: "SUCCEEDED", importedCount: 2, failedCount: 0 };
      },
    },
    enabled: true,
    intervalMs: 120000,
    initialLookbackMinutes: 10,
    startupDelayMs: 5000,
    now: () => new Date("2026-08-04T03:00:00.000Z"),
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return { unref() {} };
    },
    clearTimer() {},
    logger: { info: (line) => logs.push(JSON.parse(line)), error() {} },
  });
  assert.equal(poller.start(), true);
  assert.equal(timers[0].delay, 5000);
  await timers[0].callback();
  assert.deepEqual(calls, [{
    initialLastChangedFrom: "2026-08-04T02:50:00.000Z",
    actor: "system:naver-order-poller",
  }]);
  assert.equal(timers[1].delay, 120000);
  assert.equal(logs[0].event, "naver_order_poll_completed");
});

test("poller logs only a safe code after failure and continues", async () => {
  const timers = [];
  const logs = [];
  const poller = createNaverOrderPollScheduler({
    service: { pullOrderImports: async () => {
      const error = new Error("customer secret must not be logged");
      error.code = "NAVER_TIMEOUT";
      throw error;
    } },
    enabled: true,
    startupDelayMs: 0,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return { unref() {} };
    },
    clearTimer() {},
    logger: { info() {}, error: (line) => logs.push(line) },
  });
  poller.start();
  await timers[0].callback();
  assert.match(logs[0], /NAVER_TIMEOUT/);
  assert.doesNotMatch(logs[0], /customer secret/);
  assert.equal(timers.length, 2);
});
