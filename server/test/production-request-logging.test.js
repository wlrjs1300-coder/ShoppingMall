const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { requestContext } = require("../middleware/security");

function finishRequest(statusCode) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.setHeader = () => {};
  const request = {
    method: "GET",
    path: statusCode === 200 ? "/api/health" : "/api/example",
    get() { return null; },
  };
  requestContext(request, response, () => {});
  response.emit("finish");
}

test("운영 요청 로그는 정상 응답을 오류로 기록하지 않고 4xx와 5xx를 구분한다", () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors = [];
  const warnings = [];
  console.error = (value) => errors.push(JSON.parse(value));
  console.warn = (value) => warnings.push(JSON.parse(value));

  try {
    finishRequest(200);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);

    finishRequest(404);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, "warn");
    assert.equal(warnings[0].status, 404);

    finishRequest(500);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].level, "error");
    assert.equal(errors[0].status, 500);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});
