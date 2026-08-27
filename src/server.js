import dgram from "node:dgram";
import fs from "node:fs/promises";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createLogger } from "./logger.js";
import { buildHwilSuccessResponse, inspectBinaryFrame, parseHwilFrame } from "./protocol.js";
import { RaceHub, RaceProtocolError } from "./race.js";
import { PrivateServerService, ServiceError } from "./service.js";
import { JsonStore } from "./store.js";

const SERVER_VERSION = "0.7.0";
const WEBSOCKET_PATHS = Object.freeze(["/api", "/ws", "/rpc", "/race"]);

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function sendWebSocket(socket, payload, logger, context) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(payload, (error) => {
      if (error) logger.warn("websocket_send_failed", { ...context, message: error.message });
    });
    return true;
  } catch (error) {
    logger.warn("websocket_send_failed", { ...context, message: error.message });
    return false;
  }
}

const CONTENT_TYPES = Object.freeze({
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
});

async function sendContentFile(request, response, contentRoot, relativePath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    throw new ServiceError(400, "invalid_content_path", "Content path is invalid");
  }
  if (!decodedPath || decodedPath.includes("\0")) {
    throw new ServiceError(404, "content_not_found", "Content file was not found");
  }

  const root = path.resolve(contentRoot);
  const filename = path.resolve(root, decodedPath);
  if (!filename.startsWith(`${root}${path.sep}`)) {
    throw new ServiceError(403, "content_path_forbidden", "Content path is outside the content root");
  }

  let payload;
  try {
    payload = await fs.readFile(filename);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      throw new ServiceError(404, "content_not_found", "Content file was not found");
    }
    throw error;
  }

  const etag = `"${createHash("sha256").update(payload).digest("hex")}"`;
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { etag, "cache-control": "public, max-age=300" });
    return response.end();
  }
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream",
    "content-length": payload.length,
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
    etag,
  });
  return response.end(payload);
}

async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ServiceError(413, "body_too_large", "Request body is too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function bearerToken(request) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

function requestPath(request) {
  return new URL(request.url ?? "/", "http://private.local").pathname;
}

export async function createPrivateServer(config, options = {}) {
  const logger = options.logger ?? createLogger(config.logLevel);
  const store = options.store ?? new JsonStore(config.dataDir);
  await store.initialize();
  const service = new PrivateServerService(store, config);
  const startedAt = Date.now();
  const compatibilityProfileId = createHash("sha256")
    .update("hwil-private-profile-v1")
    .digest()
    .subarray(0, 16);
  const compatibilityProfileSecret = createHash("sha256")
    .update(`${config.tokenSecret}:hwil-private-secret-v1`)
    .digest();
  const raceHub = new RaceHub(logger);

  const httpServer = http.createServer(async (request, response) => {
    const requestId = randomUUID();
    let pathname = "/";
    try {
      pathname = requestPath(request);
      // The original 1.35.0 client derives this URL from the WebSocket
      // endpoint (wss -> https, api -> status) and treats failures as a
      // lost backend connection.
      if (request.method === "GET" && pathname === "/status") {
        return sendJson(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && pathname === "/health") {
        return sendJson(response, 200, { status: "ok", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
      }
      if (request.method === "GET" && pathname === "/") {
        return sendJson(response, 200, {
          service: "hwil-private-server",
          version: SERVER_VERSION,
          status: "online",
          health: "/health",
          compatibility: "/v1/compatibility",
        });
      }
      if (request.method === "GET" && pathname === "/v1/status") {
        return sendJson(response, 200, {
          service: "hwil-private-server",
          version: SERVER_VERSION,
          clientVersion: config.clientVersion,
          websocketPaths: WEBSOCKET_PATHS,
          racePlayerCount: raceHub.size,
          udpPort: config.udpPort,
          compatibilityPhase: "original-client-bootstrap",
          replacementContentManifest: "/v1/content/manifest",
        });
      }
      if (request.method === "GET" && pathname === "/v1/content/manifest") {
        return await sendContentFile(request, response, config.replacementContentDir, "manifest.json");
      }
      if (request.method === "GET" && pathname.startsWith("/content/")) {
        return await sendContentFile(
          request,
          response,
          config.replacementContentDir,
          pathname.slice("/content/".length),
        );
      }
      if (request.method === "GET" && pathname === "/v1/compatibility") {
        return sendJson(response, 200, service.compatibility());
      }
      if (request.method === "GET" && pathname === "/v1/time") {
        return sendJson(response, 200, service.timeResponse());
      }
      if (request.method === "GET" && pathname === "/v1/config") {
        return sendJson(response, 200, service.configResponse());
      }
      if (request.method === "POST" && pathname === "/v1/auth/bootstrap") {
        return sendJson(response, 201, await service.bootstrap(await readJson(request, config.maxBodyBytes)));
      }
      if (request.method === "POST" && pathname === "/v1/auth/profile") {
        return sendJson(response, 200, service.authenticate(await readJson(request, config.maxBodyBytes)));
      }
      if (request.method === "GET" && pathname === "/v1/profile") {
        return sendJson(response, 200, service.getProfile(bearerToken(request)));
      }
      if (request.method === "PUT" && pathname === "/v1/profile") {
        return sendJson(
          response,
          200,
          await service.saveProfile(bearerToken(request), await readJson(request, config.maxBodyBytes)),
        );
      }
      if (request.method === "POST" && pathname === "/v1/matchmaking") {
        return sendJson(
          response,
          201,
          await service.startMatchmaking(bearerToken(request), await readJson(request, config.maxBodyBytes)),
        );
      }
      if (request.method === "DELETE" && pathname.startsWith("/v1/matchmaking/")) {
        const ticketId = decodeURIComponent(pathname.slice("/v1/matchmaking/".length));
        return sendJson(response, 200, await service.stopMatchmaking(bearerToken(request), ticketId));
      }
      return sendJson(response, 404, { error: { code: "not_found", message: "Route not found" }, requestId });
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 500;
      const code = error instanceof ServiceError ? error.code : "internal_error";
      logger[status >= 500 ? "error" : "warn"]("http_request_failed", {
        requestId,
        method: request.method,
        pathname,
        status,
        code,
      });
      return sendJson(response, status, {
        error: { code, message: status >= 500 ? "Internal server error" : error.message },
        requestId,
      });
    }
  });

  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: config.wsMaxPayloadBytes });
  httpServer.on("upgrade", (request, socket, head) => {
    try {
      const pathname = requestPath(request);
      if (!WEBSOCKET_PATHS.includes(pathname)) return socket.destroy();
      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        webSocketServer.emit("connection", client, request);
      });
    } catch (error) {
      logger.warn("websocket_upgrade_rejected", { message: error.message });
      socket.destroy();
    }
  });

  webSocketServer.on("connection", (socket, request) => {
    const connectionId = randomUUID();
    const playerId = `p_${connectionId.replaceAll("-", "").slice(0, 12)}`;
    const pathname = requestPath(request);
    const originalClient = pathname === "/api";
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    logger.info("websocket_connected", { connectionId, pathname, remoteAddress: request.socket.remoteAddress });
    if (!originalClient) {
      sendWebSocket(socket, JSON.stringify({
        type: "hello",
        service: "hwil-private-server",
        compatibilityPhase: "original-client-bootstrap",
        connectionId,
        playerId,
      }), logger, { connectionId });
    }

    socket.on("message", async (data, isBinary) => {
      if (isBinary) {
        const frame = inspectBinaryFrame(data);
        logger.info("binary_frame_received", { connectionId, ...frame });
        if (config.captureBinaryFrames) {
          try {
            const directory = path.join(config.dataDir, "captures");
            await fs.mkdir(directory, { recursive: true });
            const filename = `${Date.now()}-${frame.sha256.slice(0, 16)}.bin`;
            await fs.writeFile(path.join(directory, filename), data, { mode: 0o600 });
          } catch (error) {
            logger.warn("binary_frame_capture_failed", { connectionId, message: error.message });
          }
        }
        if (originalClient) {
          try {
            const requestFrame = parseHwilFrame(data);
            if (!requestFrame.request) {
              logger.warn("hwil_non_request_frame_ignored", {
                connectionId,
                flags: requestFrame.flags,
                method: requestFrame.method,
                sequence: requestFrame.sequence,
              });
              return;
            }
            sendWebSocket(socket, buildHwilSuccessResponse(requestFrame, {
              profileId: compatibilityProfileId,
              profileSecret: compatibilityProfileSecret,
              raceId: [102, 120].includes(requestFrame.method) ? randomUUID() : undefined,
            }), logger, { connectionId, method: requestFrame.method });
            logger.info("hwil_response_sent", {
              connectionId,
              method: requestFrame.method,
              methodName: requestFrame.methodName,
              sequence: requestFrame.sequence,
            });
          } catch (error) {
            logger.warn("hwil_frame_rejected", { connectionId, message: error.message });
          }
        }
        return;
      }

      let requestMessage;
      try {
        requestMessage = JSON.parse(data.toString("utf8"));
        if (requestMessage && typeof requestMessage.type === "string") {
          if (!raceHub.handle(socket, playerId, requestMessage)) {
            throw new RaceProtocolError(
              "unknown_message_type",
              `Unsupported race message type: ${requestMessage.type}`,
            );
          }
          return;
        }
        if (!requestMessage || typeof requestMessage.method !== "string") {
          throw new ServiceError(400, "invalid_rpc", "RPC request requires a method");
        }
        const result = await service.rpc(
          requestMessage.method,
          requestMessage.params ?? {},
          requestMessage.token,
        );
        sendWebSocket(
          socket,
          JSON.stringify({ id: requestMessage.id ?? null, result }),
          logger,
          { connectionId },
        );
      } catch (error) {
        if (error instanceof RaceProtocolError) {
          sendWebSocket(socket, JSON.stringify({
            type: "ERROR",
            code: error.code,
            message: error.message,
          }), logger, { connectionId });
          return;
        }
        const code = error instanceof ServiceError ? error.code : "invalid_rpc";
        sendWebSocket(socket, JSON.stringify({
          id: requestMessage?.id ?? null,
          error: { code, message: error instanceof ServiceError ? error.message : "Invalid RPC request" },
        }), logger, { connectionId });
      }
    });

    socket.on("close", () => {
      raceHub.disconnect(socket, playerId);
      logger.info("websocket_disconnected", { connectionId, playerId });
    });
    socket.on("error", (error) => logger.warn("websocket_error", { connectionId, message: error.message }));
  });

  const udpServer = dgram.createSocket("udp4");
  udpServer.on("message", (message, remote) => {
    const sha256 = createHash("sha256").update(message).digest("hex");
    logger.info("udp_datagram_received", {
      remoteAddress: remote.address,
      remotePort: remote.port,
      byteLength: message.length,
      sha256,
    });
    if (message.toString("utf8") === "HWIL_DISCOVERY") {
      const response = Buffer.from(JSON.stringify({
        service: "hwil-private-server",
        version: SERVER_VERSION,
        clientVersion: config.clientVersion,
        phase: "original-client-bootstrap",
      }));
      udpServer.send(response, remote.port, remote.address);
    }
  });
  udpServer.on("error", (error) => logger.error("udp_error", { message: error.message }));

  let httpListening = false;
  let udpListening = false;
  let heartbeatTimer = null;

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      for (const client of webSocketServer.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (client.isAlive === false) {
          logger.warn("websocket_heartbeat_timeout");
          client.terminate();
          continue;
        }
        client.isAlive = false;
        try {
          client.ping();
        } catch (error) {
          logger.warn("websocket_ping_failed", { message: error.message });
          client.terminate();
        }
      }
    }, config.wsHeartbeatIntervalMs);
    heartbeatTimer.unref();
  }

  async function start() {
    if (httpListening || udpListening) throw new Error("Server has already been started");
    try {
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(config.port, config.host, resolve);
      });
      httpListening = true;
      await new Promise((resolve, reject) => {
        udpServer.once("error", reject);
        udpServer.bind(config.udpPort, config.udpHost, resolve);
      });
      udpListening = true;
      startHeartbeat();
    } catch (error) {
      if (httpListening) {
        await new Promise((resolve) => httpServer.close(() => resolve()));
        httpListening = false;
      }
      throw error;
    }
    const httpAddress = httpServer.address();
    const udpAddress = udpServer.address();
    logger.info("server_started", {
      http: `${httpAddress.address}:${httpAddress.port}`,
      udp: `${udpAddress.address}:${udpAddress.port}`,
      clientVersion: config.clientVersion,
    });
    return { httpAddress, udpAddress };
  }

  async function stop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const client of webSocketServer.clients) client.terminate();
    webSocketServer.close();
    const closers = [];
    if (httpListening) {
      closers.push(new Promise((resolve) => httpServer.close(() => resolve())));
      httpListening = false;
    }
    if (udpListening) {
      closers.push(new Promise((resolve) => udpServer.close(() => resolve())));
      udpListening = false;
    }
    await Promise.all(closers);
    await store.flush();
  }

  return Object.freeze({ start, stop, service, store, raceHub, httpServer, udpServer, webSocketServer });
}
