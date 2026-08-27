import { createHash } from "node:crypto";

export const HWIL_FRAME_FLAGS = Object.freeze({
  compressed: 0x01,
  request: 0x02,
  success: 0x04,
  failure: 0x08,
  event: 0x10,
});

export const HWIL_RPC_METHODS = Object.freeze({
  0: "registration",
  1: "auth",
  2: "sync",
  3: "save",
  5: "gen_auth_token",
  6: "forget_me",
  73: "get_time",
  102: "offline_start_race",
  103: "offline_end_race",
  128: "get_config",
  153: "get_profile",
});

const COMPACT_TYPE = Object.freeze({
  stop: 0,
  booleanTrue: 1,
  booleanFalse: 2,
  byte: 3,
  int16: 4,
  int32: 5,
  int64: 6,
  double: 7,
  binary: 8,
  list: 9,
  set: 10,
  map: 11,
  struct: 12,
});

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

function writeVarint(input) {
  let value = BigInt(input);
  if (value < 0n) throw new RangeError("Varint cannot be negative");
  const bytes = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function writeCompactFieldHeader(fieldId, previousFieldId, type) {
  const delta = fieldId - previousFieldId;
  if (delta > 0 && delta <= 15) return Buffer.from([(delta << 4) | type]);
  return Buffer.concat([
    Buffer.from([type]),
    writeVarint(BigInt(fieldId) << 1n),
  ]);
}

function writeCompactBinaryField(fieldId, previousFieldId, input) {
  const value = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return Buffer.concat([
    writeCompactFieldHeader(fieldId, previousFieldId, COMPACT_TYPE.binary),
    writeVarint(value.length),
    value,
  ]);
}

function writeCompactInt64Field(fieldId, previousFieldId, input) {
  const value = BigInt(input);
  const zigzag = value >= 0n ? value << 1n : ((-value) << 1n) - 1n;
  return Buffer.concat([
    writeCompactFieldHeader(fieldId, previousFieldId, COMPACT_TYPE.int64),
    writeVarint(zigzag),
  ]);
}

export function parseHwilFrame(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 5) throw new Error("HWIL frame is shorter than its five-byte header");
  const flags = buffer[0];
  const method = buffer.readUInt16LE(1);
  const sequence = buffer.readUInt16LE(3);
  return {
    flags,
    compressed: Boolean(flags & HWIL_FRAME_FLAGS.compressed),
    request: Boolean(flags & HWIL_FRAME_FLAGS.request),
    method,
    methodName: HWIL_RPC_METHODS[method] ?? `unknown_${method}`,
    sequence,
    payload: buffer.subarray(5),
  };
}

export function buildHwilFrame({
  flags = HWIL_FRAME_FLAGS.success,
  method,
  sequence,
  payload = Buffer.from([COMPACT_TYPE.stop]),
}) {
  const header = Buffer.allocUnsafe(5);
  header[0] = flags;
  header.writeUInt16LE(method, 1);
  header.writeUInt16LE(sequence, 3);
  return Buffer.concat([header, payload]);
}

export function buildRegistrationResponse(profileId, profileSecret) {
  return Buffer.concat([
    writeCompactBinaryField(1, 0, profileId),
    writeCompactBinaryField(2, 1, profileSecret),
    Buffer.from([COMPACT_TYPE.stop]),
  ]);
}

export function buildTimeResponse(epochMilli = Date.now()) {
  return Buffer.concat([
    writeCompactInt64Field(1, 0, epochMilli),
    Buffer.from([COMPACT_TYPE.stop]),
  ]);
}

export function buildHwilSuccessResponse(frame, options = {}) {
  let payload = Buffer.from([COMPACT_TYPE.stop]);
  if (frame.method === 0) {
    payload = buildRegistrationResponse(options.profileId, options.profileSecret);
  } else if (frame.method === 73) {
    payload = buildTimeResponse(options.epochMilli ?? Date.now());
  }
  return buildHwilFrame({ method: frame.method, sequence: frame.sequence, payload });
}

export function inspectBinaryFrame(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const result = {
    byteLength: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    hexPrefix: buffer.subarray(0, 24).toString("hex"),
    protocol: "unknown-binary",
  };

  if (buffer.length >= 5 && [2, 3, 4, 5, 8, 9, 16, 17].includes(buffer[0])) {
    try {
      const frame = parseHwilFrame(buffer);
      return {
        ...result,
        protocol: "hwil-rpc",
        flags: frame.flags,
        compressed: frame.compressed,
        request: frame.request,
        method: frame.method,
        methodName: frame.methodName,
        sequenceId: frame.sequence,
        payloadByteLength: frame.payload.length,
      };
    } catch (error) {
      return { ...result, protocol: "malformed-hwil-rpc", error: error.message };
    }
  }

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
