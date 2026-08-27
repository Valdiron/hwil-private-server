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
  10: "league_status",
  11: "start_race_search",
  12: "stop_race_search",
  13: "end_race",
  14: "start_matching",
  25: "get_gamelift_endpoints",
  73: "get_time",
  100: "end_tutorial_race",
  102: "offline_start_race",
  103: "offline_end_race",
  118: "timeout_offline_start_race",
  119: "online_races_enabled",
  120: "start_league_race",
  128: "get_config",
  153: "get_profile",
  181: "get_profile_preview",
  2000: "test_websocket_events",
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
  let offset = start;
  for (let index = 0; index < 5 && offset < buffer.length; index += 1) {
    const byte = buffer[offset];
    if (index === 4 && (byte & 0xf0) !== 0) {
      throw new Error("Varint exceeds the unsigned 32-bit range");
    }
    value += (byte & 0x7f) * (2 ** (index * 7));
    offset += 1;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
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

function writeCompactInt32Field(fieldId, previousFieldId, input) {
  const value = BigInt(input);
  const zigzag = value >= 0n ? value << 1n : ((-value) << 1n) - 1n;
  return Buffer.concat([
    writeCompactFieldHeader(fieldId, previousFieldId, COMPACT_TYPE.int32),
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
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new RangeError("HWIL flags must be an unsigned byte");
  }
  if (!Number.isInteger(method) || method < 0 || method > 0xffff) {
    throw new RangeError("HWIL method must be an unsigned 16-bit integer");
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff) {
    throw new RangeError("HWIL sequence must be an unsigned 16-bit integer");
  }
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

export function buildSaveResponse(epochMilli = Date.now()) {
  return buildTimeResponse(epochMilli);
}

export function buildOnlineRacesEnabledResponse(enabled = false) {
  return Buffer.from([
    (1 << 4) | (enabled ? COMPACT_TYPE.booleanTrue : COMPACT_TYPE.booleanFalse),
    COMPACT_TYPE.stop,
  ]);
}

export function buildStartLeagueRaceResponse(raceId, ticketId = raceId) {
  if (typeof raceId !== "string" || raceId.length === 0) {
    throw new TypeError("raceId is required for an offline race response");
  }
  return Buffer.concat([
    // TStartLeagueResult.success
    writeCompactInt32Field(1, 0, 1),
    // TStartLeagueRaceType.offline
    writeCompactInt32Field(2, 1, 1),
    writeCompactBinaryField(3, 2, raceId),
    writeCompactBinaryField(4, 3, ticketId),
    writeCompactInt32Field(5, 4, 0),
    Buffer.from([COMPACT_TYPE.stop]),
  ]);
}

export function buildHwilSuccessResponse(frame, options = {}) {
  let payload = Buffer.from([COMPACT_TYPE.stop]);
  if (frame.method === 0) {
    payload = buildRegistrationResponse(options.profileId, options.profileSecret);
  } else if (frame.method === 3) {
    payload = buildSaveResponse(options.epochMilli ?? Date.now());
  } else if (frame.method === 73) {
    payload = buildTimeResponse(options.epochMilli ?? Date.now());
  } else if (frame.method === 102 || frame.method === 120) {
    payload = buildStartLeagueRaceResponse(options.raceId, options.ticketId);
  } else if (frame.method === 119) {
    payload = buildOnlineRacesEnabledResponse(false);
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

  const frameTypeFlags =
    HWIL_FRAME_FLAGS.request |
    HWIL_FRAME_FLAGS.success |
    HWIL_FRAME_FLAGS.failure |
    HWIL_FRAME_FLAGS.event;
  if (
    buffer.length >= 5 &&
    (buffer[0] & ~0x1f) === 0 &&
    (buffer[0] & frameTypeFlags) !== 0
  ) {
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
