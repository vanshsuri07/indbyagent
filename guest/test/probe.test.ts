import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { decideProbe } from "./integration/probe.js";

describe("decideProbe pure decision function", () => {
  it("skips on connection error (ECONNREFUSED)", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:3000");
    (err as unknown as { code: string }).code = "ECONNREFUSED";
    assert.equal(decideProbe({ connectionError: err }), "skip");
  });

  it("skips on ENOTFOUND error", () => {
    assert.equal(decideProbe({ connectionError: "ENOTFOUND" }), "skip");
  });

  it("skips on timeout with no response", () => {
    const timeoutErr = new DOMException("The operation was aborted", "TimeoutError");
    assert.equal(decideProbe({ connectionError: timeoutErr }), "skip");
  });

  it("skips on empty input", () => {
    assert.equal(decideProbe({}), "skip");
  });

  it("runs on 200 OK (server is up)", () => {
    assert.equal(decideProbe({ status: 200 }), "run");
  });

  it("runs on 404 Not Found (server is up)", () => {
    assert.equal(decideProbe({ status: 404 }), "run");
  });

  it("runs on 405 Method Not Allowed (server is up)", () => {
    assert.equal(decideProbe({ status: 405 }), "run");
  });

  it("fails on 500 Internal Server Error", () => {
    assert.equal(decideProbe({ status: 500 }), "fail");
  });

  it("fails on 502 Bad Gateway", () => {
    assert.equal(decideProbe({ status: 502 }), "fail");
  });

  it("fails on 503 Service Unavailable", () => {
    assert.equal(decideProbe({ status: 503 }), "fail");
  });

  it("skips if connectionError is present even if status is also passed", () => {
    assert.equal(decideProbe({ connectionError: new Error("fail"), status: 200 }), "skip");
  });
});
