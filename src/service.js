import { randomUUID } from "node:crypto";
import {
  createProfileSecret,
  hashProfileSecret,
  issueToken,
  verifyProfileSecret,
  verifyToken,
} from "./auth.js";

export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function publicProfile(profile) {
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    clientProfile: profile.clientProfile,
    serverProfile: profile.serverProfile,
  };
}

function requireString(value, name, minimum = 1, maximum = 128) {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw new ServiceError(400, "invalid_argument", `${name} is invalid`);
  }
  return value.trim();
}

function requirePlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "invalid_argument", `${name} must be an object`);
  }
  return JSON.parse(JSON.stringify(value));
}

export class PrivateServerService {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  compatibility() {
    return {
      phase: "original-client-bootstrap",
      client: { packageName: "com.mattel.HWInfiniteLoop", version: this.config.clientVersion },
      implemented: [
        "local profile bootstrap and authentication",
        "profile persistence",
        "clean-room JSON RPC",
        "original five-byte WebSocket framing and core RPC method identifiers",
        "WebSocket binary frame inspection",
        "local matchmaking tickets",
        "UDP discovery and diagnostic listener",
        "versioned clean-room replacement content manifest",
      ],
      pendingForOriginalApk: [
        "complete Thrift schemas",
        "Unity UNet race packet compatibility",
        "NetworkSettings and AssetBundles from the external game data package",
      ],
      originalProtocolEvidence: ["WebSocket", "Apache Thrift compact", "Unity UNet", "AWS GameLift"],
      replacementContent: {
        format: "JSON",
        manifestPath: "/v1/content/manifest",
        originalAssetsIncluded: false,
        requiresClientBridge: true,
      },
    };
  }

  async bootstrap(input = {}) {
    if (!this.config.allowRegistration) {
      throw new ServiceError(403, "registration_disabled", "Profile registration is disabled");
    }
    const displayName = input.displayName
      ? requireString(input.displayName, "displayName", 1, 32)
      : `Looper-${randomUUID().slice(0, 8)}`;
    const profileId = randomUUID();
    const profileSecret = createProfileSecret();
    const now = new Date().toISOString();
    const profile = await this.store.putProfile({
      profileId,
      displayName,
      profileSecret: hashProfileSecret(profileSecret),
      createdAt: now,
      updatedAt: now,
      clientProfile: {},
      serverProfile: {
        looperLevel: 1,
        looperPoints: 0,
        trophies: 0,
        softCurrency: 0,
        hardCurrency: 0,
      },
    });
    return {
      profileId,
      profileSecret,
      authenticationToken: issueToken(profileId, this.config.tokenSecret, this.config.tokenTtlSeconds),
      profile: publicProfile(profile),
    };
  }

  authenticate(input = {}) {
    const profileId = requireString(input.profileId, "profileId", 1, 128);
    const profileSecret = requireString(input.profileSecret, "profileSecret", 1, 256);
    const profile = this.store.getProfile(profileId);
    if (!profile || !verifyProfileSecret(profileSecret, profile.profileSecret)) {
      throw new ServiceError(401, "invalid_profile_credentials", "Profile credentials are invalid");
    }
    return {
      authenticationToken: issueToken(profileId, this.config.tokenSecret, this.config.tokenTtlSeconds),
      profile: publicProfile(profile),
    };
  }

  authorize(token) {
    const payload = verifyToken(token, this.config.tokenSecret);
    if (!payload) throw new ServiceError(401, "invalid_token", "Authentication token is invalid or expired");
    const profile = this.store.getProfile(payload.sub);
    if (!profile) throw new ServiceError(401, "profile_not_found", "Profile no longer exists");
    return profile;
  }

  getProfile(token) {
    return publicProfile(this.authorize(token));
  }

  async saveProfile(token, input = {}) {
    const profile = this.authorize(token);
    if (input.displayName !== undefined) {
      profile.displayName = requireString(input.displayName, "displayName", 1, 32);
    }
    if (input.clientProfile !== undefined) {
      profile.clientProfile = requirePlainObject(input.clientProfile, "clientProfile");
    }
    profile.updatedAt = new Date().toISOString();
    return publicProfile(await this.store.putProfile(profile));
  }

  configResponse() {
    return {
      clientVersion: this.config.clientVersion,
      clientConfigId: "private-clean-room-v1",
      configVersion: 1,
      configRevision: 1,
      onlineRacesEnabled: false,
      reason: "Original binary compatibility is still in diagnostic phase",
      replacementContentManifest: "/v1/content/manifest",
      replacementContentBasePath: "/content/",
      originalClientBridgeRequired: true,
    };
  }

  timeResponse() {
    return { epochMilli: Date.now() };
  }

  async startMatchmaking(token, input = {}) {
    const profile = this.authorize(token);
    const ticketId = randomUUID();
    const now = new Date().toISOString();
    const ticket = await this.store.putTicket({
      ticketId,
      profileId: profile.profileId,
      teamMode: Boolean(input.teamMode),
      status: "diagnostic-local-match",
      createdAt: now,
      gameSessionId: randomUUID(),
      playerSessionId: randomUUID(),
      raceToken: randomUUID(),
      endpoint: { host: this.config.publicHost, port: this.config.udpPort, protocol: "udp" },
    });
    return ticket;
  }

  async stopMatchmaking(token, ticketId) {
    const profile = this.authorize(token);
    const ticket = this.store.getTicket(ticketId);
    if (!ticket || ticket.profileId !== profile.profileId) {
      throw new ServiceError(404, "ticket_not_found", "Matchmaking ticket was not found");
    }
    await this.store.deleteTicket(ticketId);
    return { ticketId, isCancelled: true };
  }

  async rpc(method, params = {}, token) {
    switch (method) {
      case "time":
      case "Time":
        return this.timeResponse();
      case "compatibility.get":
        return this.compatibility();
      case "config.get":
      case "GetConfig":
        return this.configResponse();
      case "auth.bootstrap":
        return this.bootstrap(params);
      case "auth.profile":
      case "Auth":
        return this.authenticate(params);
      case "profile.get":
      case "GetProfile":
        return this.getProfile(token);
      case "profile.save":
      case "SaveProfile":
        return this.saveProfile(token, params);
      case "matchmaking.start":
      case "StartRaceSearch":
        return this.startMatchmaking(token, params);
      case "matchmaking.stop":
      case "StopRaceSearch":
        return this.stopMatchmaking(token, requireString(params.ticketId, "ticketId"));
      case "gamelift.endpoints":
      case "GetGameliftEndpoints":
        return {
          endpoints: [
            { region: "private", url: this.config.publicHost, ip: this.config.publicHost, port: this.config.udpPort },
          ],
        };
      default:
        throw new ServiceError(404, "method_not_implemented", `RPC method '${method}' is not implemented`);
    }
  }
}
