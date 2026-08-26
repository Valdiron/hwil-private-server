import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
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

test("health, profile auth, save, and matchmaking flow", async (t) => {
  const { baseUrl } = await fixture(t);

  const health = await jsonRequest(`${baseUrl}/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "ok");

  const root = await jsonRequest(`${baseUrl}/`);
  assert.equal(root.response.status, 200);
  assert.equal(root.body.version, "0.3.0");

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
