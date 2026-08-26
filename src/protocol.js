import { createHash } from "node:crypto";

const MESSAGE_TYPES = Object.freeze({ 1: "call", 2: "reply", 3: "exception", 4: "oneway" });

function readVarint(buffer, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length && shift <= 35) {
    const byte = buffer[offset];
    value |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("Invalid or truncated varint");
}

export function inspectBinaryFrame(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const result = {
    byteLength: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    hexPrefix: buffer.subarray(0, 24).toString("hex"),
    protocol: "unknown-binary",
  };

  if (buffer.length < 2 || buffer[0] !== 0x82) {
    if (buffer.length > 0) result.protocol = "possible-thrift-struct-or-unknown";
    return result;
  }

  try {
    const versionAndType = buffer[1];
    const version = versionAndType & 0x1f;
    const messageTypeId = (versionAndType >> 5) & 0x07;
    const sequence = readVarint(buffer, 2);
    const nameLength = readVarint(buffer, sequence.offset);
    const end = nameLength.offset + nameLength.value;
    if (end > buffer.length || nameLength.value > 1024) throw new Error("Invalid method name");
    const methodName = buffer.subarray(nameLength.offset, end).toString("utf8");
    return {
      ...result,
      protocol: "thrift-compact-message",
      version,
      messageType: MESSAGE_TYPES[messageTypeId] ?? `unknown-${messageTypeId}`,
      sequenceId: sequence.value,
      methodName,
    };
  } catch (error) {
    return { ...result, protocol: "malformed-thrift-compact", error: error.message };
  }
}

export function buildCompactMessageHeader(methodName, sequenceId = 0, messageType = 1) {
  const name = Buffer.from(methodName, "utf8");
  const varint = (number) => {
    const bytes = [];
    let value = number >>> 0;
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value) byte |= 0x80;
      bytes.push(byte);
    } while (value);
    return Buffer.from(bytes);
  };
  return Buffer.concat([
    Buffer.from([0x82, ((messageType & 0x07) << 5) | 0x01]),
    varint(sequenceId),
    varint(name.length),
    name,
  ]);
}
