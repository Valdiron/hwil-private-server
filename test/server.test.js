import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { buildHwilFrame, parseHwilFrame } from "../src/protocol.js";
import { createPrivateServer } from "../src/server.js";

const silentLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hwil-private-server-"));
  const config = loadConfig({
    host: "127.0.0.1",
    port: 0,
    udpHost: "127.0.0.1",
    udpPort: 0,
    publicHost: "127.0.0.1",
    tokenSecret: "test-secret-that-is-long-enough",
    dataDir,
    logLevel: "error",
  });
  const server = await createPrivateServer(config, { logger: silentLogger });
  const addresses = await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return {
    server,
    addresses,
    baseUrl: `http://127.0.0.1:${addresses.httpAddress.port}`,
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function openJsonSocket(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function waitForMessage(messages, predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("WebSocket message timed out");
}

test("health, profile auth, save, and matchmaking flow", async (t) => {
  const { baseUrl } = await fixture(t);

  const health = await jsonRequest(`${baseUrl}/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "ok");

  const originalClientStatus = await jsonRequest(`${baseUrl}/status`);
  assert.equal(originalClientStatus.response.status, 200);
  assert.equal(originalClientStatus.body.status, "ok");

  const root = await jsonRequest(`${baseUrl}/`);
  assert.equal(root.response.status, 200);
  assert.equal(root.body.version, "0.7.0");

  const contentManifest = await jsonRequest(`${baseUrl}/v1/content/manifest`);
  assert.equal(contentManifest.response.status, 200);
  assert.equal(contentManifest.body.packId, "hwil-private-clean-room");
  assert.equal(contentManifest.body.originalClientCompatible, false);

  const networkSettings = await jsonRequest(`${baseUrl}/content/config/networksettings.json`);
  assert.equal(networkSettings.response.status, 200);
  assert.equal(networkSettings.body.schema, "hwil.private.NetworkSettings/1");

  const bootstrap = await jsonRequest(`${baseUrl}/v1/auth/bootstrap`, {
    method: "POST",
    body: JSON.stringify({ displayName: "Junior" }),
  });
  assert.equal(bootstrap.response.status, 201);
  assert.ok(bootstrap.body.profileId);
  assert.ok(bootstrap.body.profileSecret);

  const auth = await jsonRequest(`${baseUrl}/v1/auth/profile`, {
    method: "POST",
    body: JSON.stringify({
      profileId: bootstrap.body.profileId,
      profileSecret: bootstrap.body.profileSecret,
    }),
  });
  assert.equal(auth.response.status, 200);
  assert.ok(auth.body.authenticationToken);

  const token = auth.body.authenticationToken;
  const saved = await jsonRequest(`${baseUrl}/v1/profile`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientProfile: { tutorialComplete: true } }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.clientProfile.tutorialComplete, true);

  const matchmaking = await jsonRequest(`${baseUrl}/v1/matchmaking`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ teamMode: false }),
  });
  assert.equal(matchmaking.response.status, 201);
  assert.equal(matchmaking.body.status, "diagnostic-local-match");
  assert.equal(matchmaking.body.endpoint.protocol, "udp");
});

test("WebSocket exposes clean-room RPC", async (t) => {
  const { addresses } = await fixture(t);
  const socket = new WebSocket(`ws://127.0.0.1:${addresses.httpAddress.port}/rpc`);
  t.after(() => socket.close());

  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (messages.some((message) => message.type === "hello")) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });

  socket.send(JSON.stringify({ id: 9, method: "time", params: {} }));
  const reply = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const found = messages.find((message) => message.id === 9);
      if (found) {
        clearInterval(timer);
        resolve(found);
      }
    }, 5);
  });
  assert.equal(typeof reply.result.epochMilli, "number");
});

test("race WebSocket matches players and relays movement only to opponents", async (t) => {
  const { addresses, baseUrl } = await fixture(t);
  const endpoint = `ws://127.0.0.1:${addresses.httpAddress.port}/race`;
  const first = await openJsonSocket(endpoint);
  const second = await openJsonSocket(endpoint);
  t.after(() => {
    if (first.socket.readyState < WebSocket.CLOSING) first.socket.close();
    if (second.socket.readyState < WebSocket.CLOSING) second.socket.close();
  });

  await Promise.all([
    waitForMessage(first.messages, (message) => message.type === "hello"),
    waitForMessage(second.messages, (message) => message.type === "hello"),
  ]);

  first.socket.send(JSON.stringify({ type: "JOIN_MATCH", carId: "car_twin_mill" }));
  const firstMatch = await waitForMessage(
    first.messages,
    (message) => message.type === "MATCH_FOUND",
  );
  assert.equal(firstMatch.matchId, "room_1");
  assert.match(firstMatch.playerId, /^p_[a-f0-9]{12}$/);

  second.socket.send(JSON.stringify({ type: "JOIN_MATCH", carId: "car_bone_shaker" }));
  const secondMatch = await waitForMessage(
    second.messages,
    (message) => message.type === "MATCH_FOUND",
  );
  assert.deepEqual(secondMatch.opponents, [{ id: firstMatch.playerId, carId: "car_twin_mill" }]);
  const secondJoined = await waitForMessage(
    first.messages,
    (message) => message.type === "PLAYER_JOINED",
  );

  const position = { x: 10.5, y: 0.25, z: -4 };
  const rotation = { x: 0, y: 0.5, z: 0, w: 0.5 };
  first.socket.send(JSON.stringify({
    type: "UPDATE_POSITION",
    position,
    rotation,
    isBoosting: true,
  }));
  const movement = await waitForMessage(
    second.messages,
    (message) => message.type === "OPPONENT_MOVE",
  );
  assert.equal(movement.id, firstMatch.playerId);
  assert.deepEqual(movement.position, position);
  assert.deepEqual(movement.rotation, rotation);
  assert.equal(movement.isBoosting, true);
  assert.equal(secondJoined.id, secondMatch.playerId);
  assert.equal(first.messages.some((message) => message.type === "OPPONENT_MOVE"), false);

  const movementCount = second.messages.filter((message) => message.type === "OPPONENT_MOVE").length;
  first.socket.send(JSON.stringify({
    type: "UPDATE_POSITION",
    position,
    rotation,
    isBoosting: "false",
  }));
  const invalidBoost = await waitForMessage(
    first.messages,
    (message) => message.type === "ERROR" && message.code === "invalid_boost",
  );
  assert.equal(invalidBoost.code, "invalid_boost");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    second.messages.filter((message) => message.type === "OPPONENT_MOVE").length,
    movementCount,
  );

  first.socket.send(JSON.stringify({ type: "JOIN_MATCH", carId: "car_twin_mill" }));
  const duplicateJoin = await waitForMessage(
    first.messages,
    (message) => message.type === "ERROR" && message.code === "already_in_match",
  );
  assert.equal(duplicateJoin.code, "already_in_match");

  const status = await jsonRequest(`${baseUrl}/v1/status`);
  assert.equal(status.body.racePlayerCount, 2);

  first.socket.close();
  const left = await waitForMessage(
    second.messages,
    (message) => message.type === "PLAYER_LEFT",
  );
  assert.equal(left.id, firstMatch.playerId);
});

test("original /api WebSocket completes bootstrap RPCs without a JSON greeting", async (t) => {
  const { addresses } = await fixture(t);
  const socket = new WebSocket(`ws://127.0.0.1:${addresses.httpAddress.port}/api`);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (data, isBinary) => messages.push({ data: Buffer.from(data), isBinary }));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.length, 0);

  for (const [index, method] of [0, 1, 2, 3, 73, 102, 119, 120].entries()) {
    const sequence = index + 40;
    socket.send(buildHwilFrame({ flags: 3, method, sequence, payload: Buffer.from([0xde, 0xad]) }));
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("HWIL response timed out")), 1000);
      const check = () => {
        const found = messages
          .filter((message) => message.isBinary)
          .map((message) => parseHwilFrame(message.data))
          .find((frame) => frame.sequence === sequence);
        if (found) {
          clearTimeout(timeout);
          resolve(found);
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });
    assert.equal(response.flags, 4);
    assert.equal(response.method, method);
    if ([102, 120].includes(method)) assert.ok(response.payload.length > 20);
    if (method === 3) assert.equal(response.payload[0], 0x16);
    if (method === 119) assert.deepEqual(response.payload, Buffer.from([0x12, 0x00]));
  }
});

test("UDP discovery replies, while unknown datagrams are not reflected", async (t) => {
  const { addresses } = await fixture(t);
  const socket = dgram.createSocket("udp4");
  t.after(() => socket.close());

  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("UDP discovery timed out")), 1000);
    socket.once("message", (message) => {
      clearTimeout(timeout);
      resolve(JSON.parse(message.toString("utf8")));
    });
  });
  socket.send("HWIL_DISCOVERY", addresses.udpAddress.port, "127.0.0.1");
  assert.equal((await response).service, "hwil-private-server");
});

test("failed UDP startup rolls back the HTTP listener", async (t) => {
  const blocker = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.bind(0, "127.0.0.1", resolve);
  });
  t.after(() => blocker.close());

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hwil-private-server-startup-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    host: "127.0.0.1",
    port: 0,
    udpHost: "127.0.0.1",
    udpPort: blocker.address().port,
    tokenSecret: "test-secret-that-is-long-enough",
    dataDir,
    logLevel: "error",
  });
  const server = await createPrivateServer(config, { logger: silentLogger });
  await assert.rejects(server.start(), /EADDRINUSE/);
  assert.equal(server.httpServer.listening, false);
  await server.stop();
});
