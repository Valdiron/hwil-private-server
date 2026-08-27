import { WebSocket } from "ws";

const DEFAULT_ROOM_ID = "room_1";

export class RaceProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RaceProtocolError";
    this.code = code;
  }
}

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function normalizeCarId(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new RaceProtocolError("invalid_car", "JOIN_MATCH requires carId");
  }
  const carId = String(value).trim();
  if (!carId || carId.length > 128) {
    throw new RaceProtocolError("invalid_car", "carId must contain 1 to 128 characters");
  }
  return carId;
}

function normalizeVector(value, label, allowW = false) {
  if (Array.isArray(value)) {
    const expectedLengths = allowW ? [3, 4] : [3];
    if (!expectedLengths.includes(value.length) || value.some((entry) => !Number.isFinite(entry))) {
      throw new RaceProtocolError("invalid_movement", `${label} must contain finite coordinates`);
    }
    return [...value];
  }
  if (!value || typeof value !== "object") {
    throw new RaceProtocolError("invalid_movement", `${label} must be an object or array`);
  }
  const normalized = {};
  for (const axis of ["x", "y", "z"]) {
    if (!Number.isFinite(value[axis])) {
      throw new RaceProtocolError("invalid_movement", `${label}.${axis} must be a finite number`);
    }
    normalized[axis] = value[axis];
  }
  if (allowW && value.w !== undefined) {
    if (!Number.isFinite(value.w)) {
      throw new RaceProtocolError("invalid_movement", `${label}.w must be a finite number`);
    }
    normalized.w = value.w;
  }
  return normalized;
}

export class RaceHub {
  constructor(logger, options = {}) {
    this.logger = logger;
    this.roomId = options.roomId ?? DEFAULT_ROOM_ID;
    this.players = new Map();
  }

  get size() {
    return this.players.size;
  }

  handle(socket, playerId, message) {
    if (message.type === "JOIN_MATCH") {
      this.join(socket, playerId, message);
      return true;
    }
    if (message.type === "UPDATE_POSITION") {
      this.updatePosition(socket, playerId, message);
      return true;
    }
    return false;
  }

  join(socket, playerId, message) {
    const carId = normalizeCarId(message.carId);
    const opponents = [...this.players.values()]
      .filter((player) => player.matchId === this.roomId && player.playerId !== playerId)
      .map((player) => ({ id: player.playerId, carId: player.carId }));
    this.players.set(playerId, {
      playerId,
      socket,
      carId,
      matchId: this.roomId,
    });
    sendJson(socket, {
      type: "MATCH_FOUND",
      matchId: this.roomId,
      playerId,
      opponents,
    });
    this.broadcast(this.roomId, socket, {
      type: "PLAYER_JOINED",
      matchId: this.roomId,
      id: playerId,
      carId,
    });
    this.logger.info("race_player_joined", {
      playerId,
      matchId: this.roomId,
      carId,
      playerCount: this.players.size,
    });
  }

  updatePosition(socket, playerId, message) {
    const player = this.players.get(playerId);
    if (!player || player.socket !== socket) {
      throw new RaceProtocolError("not_in_match", "JOIN_MATCH is required before UPDATE_POSITION");
    }
    const position = normalizeVector(message.position, "position");
    const rotation = normalizeVector(message.rotation, "rotation", true);
    const isBoosting = Boolean(message.isBoosting);
    this.broadcast(player.matchId, socket, {
      type: "OPPONENT_MOVE",
      matchId: player.matchId,
      id: playerId,
      position,
      rotation,
      isBoosting,
    });
  }

  disconnect(socket, playerId) {
    const player = this.players.get(playerId);
    if (!player || player.socket !== socket) return;
    this.players.delete(playerId);
    this.broadcast(player.matchId, socket, {
      type: "PLAYER_LEFT",
      matchId: player.matchId,
      id: playerId,
    });
    this.logger.info("race_player_left", {
      playerId,
      matchId: player.matchId,
      playerCount: this.players.size,
    });
  }

  broadcast(matchId, exceptSocket, message) {
    for (const player of this.players.values()) {
      if (player.matchId === matchId && player.socket !== exceptSocket) {
        sendJson(player.socket, message);
      }
    }
  }
}
