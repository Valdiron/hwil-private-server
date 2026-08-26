import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createPrivateServer } from "./server.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);

if (config.tokenSecret === "development-only-change-me") {
  logger.warn("insecure_default_token_secret", {
    message: "Set TOKEN_SECRET before exposing the server to a network",
  });
}

const server = await createPrivateServer(config, { logger });
await server.start();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info("shutdown_requested", { signal });
  try {
    await server.stop();
    process.exitCode = 0;
  } catch (error) {
    logger.error("shutdown_failed", { message: error.message });
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
