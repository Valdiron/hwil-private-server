import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactMessageHeader, inspectBinaryFrame } from "../src/protocol.js";

test("recognizes an Apache Thrift compact message header", () => {
  const frame = buildCompactMessageHeader("Auth", 37, 1);
  const inspection = inspectBinaryFrame(frame);
  assert.equal(inspection.protocol, "thrift-compact-message");
  assert.equal(inspection.methodName, "Auth");
  assert.equal(inspection.sequenceId, 37);
  assert.equal(inspection.messageType, "call");
  assert.equal(inspection.version, 1);
});

test("summarizes unknown binary data without throwing", () => {
  const inspection = inspectBinaryFrame(Buffer.from([1, 2, 3, 4]));
  assert.equal(inspection.protocol, "possible-thrift-struct-or-unknown");
  assert.equal(inspection.byteLength, 4);
  assert.equal(inspection.sha256.length, 64);
});
