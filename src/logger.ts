export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

const DEFAULT_MIN_LEVEL: LogLevel = "debug";

let minLevel: LogLevel = DEFAULT_MIN_LEVEL;

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

function log(level: LogLevel, module: string, message: string): void {
  if (!shouldLog(level)) return;
  const timestamp = formatTimestamp();
  const levelName = LOG_LEVEL_NAMES[level];
  const formatted = `[${timestamp}] [${levelName}] [${module}] ${message}`;
  console.error(formatted);
}

export interface Logger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(childModule: string): Logger;
}

export function createLogger(module: string): Logger {
  return {
    trace(message: string) {
      log("trace", module, message);
    },
    debug(message: string) {
      log("debug", module, message);
    },
    info(message: string) {
      log("info", module, message);
    },
    warn(message: string) {
      log("warn", module, message);
    },
    error(message: string) {
      log("error", module, message);
    },
    child(childModule: string) {
      return createLogger(`${module}:${childModule}`);
    },
  };
}

export const logger = {
  trace: (module: string, message: string) => log("trace", module, message),
  debug: (module: string, message: string) => log("debug", module, message),
  info: (module: string, message: string) => log("info", module, message),
  warn: (module: string, message: string) => log("warn", module, message),
  error: (module: string, message: string) => log("error", module, message),
  create: createLogger,
};