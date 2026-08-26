import path from "node:path";

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function integerValue(value, fallback, minimum = 0, maximum = 65_535) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const config = {
    host: overrides.host ?? env.HOST ?? "0.0.0.0",
    port: overrides.port ?? integerValue(env.PORT, 8080),
    udpHost: overrides.udpHost ?? env.UDP_HOST ?? "0.0.0.0",
    udpPort: overrides.udpPort ?? integerValue(env.UDP_PORT, 7777),
    publicHost:
      overrides.publicHost ?? env.PUBLIC_HOST ?? env.RENDER_EXTERNAL_HOSTNAME ?? "127.0.0.1",
    tokenSecret: overrides.tokenSecret ?? env.TOKEN_SECRET ?? "development-only-change-me",
    tokenTtlSeconds:
      overrides.tokenTtlSeconds ?? integerValue(env.TOKEN_TTL_SECONDS, 86_400, 60, 2_592_000),
    dataDir: path.resolve(overrides.dataDir ?? env.DATA_DIR ?? "./data"),
    replacementContentDir: path.resolve(
      overrides.replacementContentDir ??
        env.REPLACEMENT_CONTENT_DIR ??
        "./replacement-data/build/Android/data/com.mattel.HWInfiniteLoop/files/private-content",
    ),
    clientVersion: overrides.clientVersion ?? env.CLIENT_VERSION ?? "1.35.0",
    allowRegistration:
      overrides.allowRegistration ?? booleanValue(env.ALLOW_REGISTRATION, true),
    captureBinaryFrames:
      overrides.captureBinaryFrames ?? booleanValue(env.CAPTURE_BINARY_FRAMES, false),
    logLevel: overrides.logLevel ?? env.LOG_LEVEL ?? "info",
    maxBodyBytes:
      overrides.maxBodyBytes ?? integerValue(env.MAX_BODY_BYTES, 262_144, 1024, 10_485_760),
    wsMaxPayloadBytes:
      overrides.wsMaxPayloadBytes ??
      integerValue(env.WS_MAX_PAYLOAD_BYTES, 1_048_576, 1024, 16_777_216),
  };

  if (!config.tokenSecret || config.tokenSecret.length < 16) {
    throw new Error("TOKEN_SECRET must contain at least 16 characters");
  }
  return Object.freeze(config);
}
