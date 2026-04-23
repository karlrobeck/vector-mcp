/**
 * Worker thread for loading knowledge base without blocking main thread
 *
 * Messages received from main thread:
 * - { type: 'load', config: Config, databasePath: string }
 *
 * Messages sent to main thread:
 * - { type: 'log', level: 'info' | 'warning' | 'error', message: string }
 * - { type: 'progress', topic: string, status: 'cached' | 'loaded' | 'failed', chunks: number }
 * - { type: 'complete', totalCached: number, totalLoaded: number, totalFailed: number }
 * - { type: 'error', message: string }
 */

import { initializeDatabase } from "./db.ts";
import { loadAllTopics } from "./loader.ts";
import type { Config } from "./config.ts";

declare let self: Worker;

interface WorkerMessage {
  type: string;
  config?: Config;
  databasePath?: string;
}

interface LogMessage {
  type: "log";
  level: "info" | "warning" | "error";
  message: string;
}

interface ProgressMessage {
  type: "progress";
  topic: string;
  status: "cached" | "loaded" | "failed";
  chunks: number;
}

interface CompleteMessage {
  type: "complete";
  totalCached: number;
  totalLoaded: number;
  totalFailed: number;
}

interface ErrorMessage {
  type: "error";
  message: string;
}

function sendLog(level: "info" | "warning" | "error", message: string) {
  const msg: LogMessage = { type: "log", level, message };
  self.postMessage(msg);
}

function sendProgress(
  topic: string,
  status: "cached" | "loaded" | "failed",
  chunks: number,
) {
  const msg: ProgressMessage = { type: "progress", topic, status, chunks };
  self.postMessage(msg);
}

function sendComplete(
  totalCached: number,
  totalLoaded: number,
  totalFailed: number,
) {
  const msg: CompleteMessage = {
    type: "complete",
    totalCached,
    totalLoaded,
    totalFailed,
  };
  self.postMessage(msg);
}

function sendError(message: string) {
  const msg: ErrorMessage = { type: "error", message };
  self.postMessage(msg);
}

// Listen for messages from main thread
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { type, config, databasePath } = event.data;

  if (type !== "load" || !config || !databasePath) {
    sendError(
      "Invalid message: expected { type: 'load', config, databasePath }",
    );
    return;
  }

  try {
    sendLog("info", "[worker] Initializing database...");
    initializeDatabase(databasePath);

    sendLog("info", "[worker] Loading knowledge base...");
    const results = await loadAllTopics(config);

    // Report individual results
    results.forEach((result) => {
      if (result.status === "cached") {
        sendProgress(result.topic, "cached", result.chunks);
        sendLog(
          "info",
          `[worker] ${result.topic}: CACHED (${result.chunks} chunks)`,
        );
      } else if (result.status === "loaded") {
        sendProgress(result.topic, "loaded", result.chunks);
        sendLog(
          "info",
          `[worker] ${result.topic}: LOADED (${result.chunks} chunks in ${result.duration}ms)`,
        );
      } else {
        sendProgress(result.topic, "failed", result.chunks);
        sendLog(
          "warning",
          `[worker] ${result.topic}: FAILED (${result.error})`,
        );
      }
    });

    // Calculate summary
    const totalCached = results.filter((r) => r.status === "cached").length;
    const totalLoaded = results.filter((r) => r.status === "loaded").length;
    const totalFailed = results.filter((r) => r.status === "failed").length;

    sendLog(
      "info",
      `[worker] Knowledge base loaded: ${totalCached} cached, ${totalLoaded} loaded, ${totalFailed} failed`,
    );

    // Send completion signal
    sendComplete(totalCached, totalLoaded, totalFailed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendLog("error", `[worker] FATAL: ${message}`);
    sendError(message);
  }
};

// Signal that worker is ready
sendLog("info", "[worker] Knowledge loading worker initialized");
