const priorities = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

export function createLogger(level = "info", sink = console) {
  const threshold = priorities[level] ?? priorities.info;

  function emit(eventLevel, event, details = {}) {
    if ((priorities[eventLevel] ?? priorities.info) < threshold) return;
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: eventLevel,
      event,
      ...details,
    });
    const method = eventLevel === "error" ? "error" : eventLevel === "warn" ? "warn" : "log";
    sink[method](record);
  }

  return Object.freeze({
    debug: (event, details) => emit("debug", event, details),
    info: (event, details) => emit("info", event, details),
    warn: (event, details) => emit("warn", event, details),
    error: (event, details) => emit("error", event, details),
  });
}
