import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompactMessageHeader,
  buildHwilFrame,
  buildHwilSuccessResponse,
  buildOnlineRacesEnabledResponse,
  buildSaveResponse,
  buildStartLeagueRaceResponse,
  inspectBinaryFrame,
  parseHwilFrame,
} from "../src/protocol.js";

test("recognizes an Apache Thrift compact message header", () => {
  const frame = buildCompactMessageHeader("Auth", 37, 1);
  const inspection = inspectBinaryFrame(frame);
  assert.equal(inspection.protocol, "thrift-compact-message");
  assert.equal(inspection.methodName, "Auth");
  assert.equal(inspection.sequenceId, 37);
  assert.equal(inspection.messageType, "call");
  assert.equal(inspection.version, 1);
});

test("offline race start returns the required success result and race id", () => {
  const raceId = "private-offline-race-1";
  const payload = buildStartLeagueRaceResponse(raceId);

  // Compact Thrift fields 1 and 2 are i32 enums with value 1.
  assert.deepEqual(payload.subarray(0, 4), Buffer.from([0x15, 0x02, 0x15, 0x02]));
  assert.ok(payload.includes(Buffer.from(raceId)));
  assert.equal(payload.at(-1), 0x00);

  const response = parseHwilFrame(buildHwilSuccessResponse(
    { method: 102, sequence: 17 },
    { raceId },
  ));
  assert.equal(response.method, 102);
  assert.equal(response.sequence, 17);
  assert.ok(response.payload.includes(Buffer.from(raceId)));
});

test("summarizes unknown binary data without throwing", () => {
  const inspection = inspectBinaryFrame(Buffer.from([1, 2, 3, 4]));
  assert.equal(inspection.protocol, "possible-thrift-struct-or-unknown");
  assert.equal(inspection.byteLength, 4);
  assert.equal(inspection.sha256.length, 64);
});

test("parses the original five-byte HWIL request header", () => {
  const request = buildHwilFrame({ flags: 3, method: 73, sequence: 513, payload: Buffer.from([0xaa, 0xbb]) });
  const parsed = parseHwilFrame(request);
  assert.equal(parsed.request, true);
  assert.equal(parsed.compressed, true);
  assert.equal(parsed.method, 73);
  assert.equal(parsed.methodName, "get_time");
  assert.equal(parsed.sequence, 513);
  assert.equal(parsed.payload.toString("hex"), "aabb");
  assert.equal(inspectBinaryFrame(request).protocol, "hwil-rpc");
});

test("builds registration, auth, sync, and time success frames", () => {
  const profileId = Buffer.alloc(16, 0x11);
  const profileSecret = Buffer.alloc(32, 0x22);

  const registration = parseHwilFrame(buildHwilSuccessResponse(
    { method: 0, sequence: 7 },
    { profileId, profileSecret },
  ));
  assert.equal(registration.flags, 4);
  assert.equal(registration.sequence, 7);
  assert.equal(registration.payload[0], 0x18);
  assert.ok(registration.payload.includes(profileId));
  assert.ok(registration.payload.includes(profileSecret));

  for (const method of [1, 2, 128]) {
    const response = parseHwilFrame(buildHwilSuccessResponse({ method, sequence: 8 }));
    assert.equal(response.payload.toString("hex"), "00");
  }

  const time = parseHwilFrame(buildHwilSuccessResponse({ method: 73, sequence: 9 }, { epochMilli: 1_700_000_000_000 }));
  assert.equal(time.payload[0], 0x16);
  assert.equal(time.payload.at(-1), 0);

  const save = parseHwilFrame(buildHwilSuccessResponse({ method: 3, sequence: 10 }, { epochMilli: 1_700_000_000_001 }));
  assert.deepEqual(save.payload, buildSaveResponse(1_700_000_000_001));

  const onlineRaces = parseHwilFrame(buildHwilSuccessResponse({ method: 119, sequence: 11 }));
  assert.deepEqual(onlineRaces.payload, buildOnlineRacesEnabledResponse(false));
  assert.deepEqual(onlineRaces.payload, Buffer.from([0x12, 0x00]));

  const leagueRace = parseHwilFrame(buildHwilSuccessResponse(
    { method: 120, sequence: 12 },
    { raceId: "private-league-race" },
  ));
  assert.ok(leagueRace.payload.includes(Buffer.from("private-league-race")));
});

test("rejects out-of-range frame headers and overflowing compact varints", () => {
  assert.throws(
    () => buildHwilFrame({ method: -1, sequence: 0 }),
    /unsigned 16-bit integer/,
  );
  assert.throws(
    () => buildHwilFrame({ method: 0, sequence: 65_536 }),
    /unsigned 16-bit integer/,
  );

  const overflow = Buffer.from([0x82, 0x21, 0xff, 0xff, 0xff, 0xff, 0x10]);
  const inspection = inspectBinaryFrame(overflow);
  assert.equal(inspection.protocol, "malformed-thrift-compact");
  assert.match(inspection.error, /32-bit range/);
});
