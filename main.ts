import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import * as z from "zod";
import { getEmbedding } from "./src/embedding.ts";
import {
  closeDatabase,
  initializeDatabase,
  listTopics,
  queryVectorsWithContext,
} from "./src/db.ts";
import { loadConfig, getTopicsMap } from "./src/config.ts";
import { loadTopic } from "./src/loader.ts";
import type { Config } from "./src/config.ts";

export const server = new McpServer({ name: "vector-mcp", version: "1.0.0" });

// Loading state
let knowledgeLoadingComplete = false;
let knowledgeWorker: Worker | null = null;

/**
 * Spawn a worker thread to load knowledge base in background
 * This keeps the main thread available for MCP requests
 */
function spawnKnowledgeWorker(config: Config, databasePath: string) {
  try {
    // Create worker from TypeScript file
    const workerUrl = new URL("./src/knowledge-worker.ts", import.meta.url);
    knowledgeWorker = new Worker(workerUrl.href, { type: "module" });

    // Handle messages from worker
    knowledgeWorker.onmessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.type === "log") {
        server.sendLoggingMessage({
          level: message.level,
          data: message.message,
        });
      } else if (message.type === "complete") {
        server.sendLoggingMessage({
          level: "info",
          data: `[worker] Knowledge loading complete: ${message.totalCached} cached, ${message.totalLoaded} loaded, ${message.totalFailed} failed`,
        });
        knowledgeLoadingComplete = true;
      } else if (message.type === "error") {
        server.sendLoggingMessage({
          level: "error",
          data: `[worker] Error: ${message.message}`,
        });
      }
    };

    // Handle worker errors
    knowledgeWorker.onerror = (error: ErrorEvent) => {
      server.sendLoggingMessage({
        level: "error",
        data: `[worker] Worker error: ${error.message}`,
      });
    };

    // Send configuration to worker
    knowledgeWorker.postMessage({
      type: "load",
      config,
      databasePath,
    });

    server.sendLoggingMessage({
      level: "info",
      data: "[startup] Knowledge loading worker spawned",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    server.sendLoggingMessage({
      level: "error",
      data: `[startup] Failed to spawn knowledge worker: ${message}`,
    });
  }
}

// Register query_knowledge_base tool
server.registerTool(
  "query_knowledge_base",
  {
    description:
      "Query the vector knowledge base with semantic search. Supports filtering by topic.",
    inputSchema: z.object({
      message: z.string().describe(
        "The query message to search the knowledge base",
      ),
      topic: z.string().optional().describe(
        "Optional topic filter (e.g., 'zod', 'postgres', 'hono')",
      ),
      limit: z.number().int().min(1).max(10).default(5).describe(
        "Number of results to return",
      ),
    }),
  },
  async (input) => {
    const { message, topic, limit } = input;

    try {
      // Generate embedding for the query message
      const queryEmbedding = await getEmbedding(message);

      // Query the vector database
      const results = queryVectorsWithContext(queryEmbedding, topic, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results found for query: "${message}"${
                topic ? ` in topic: ${topic}` : ""
              }`,
            },
          ],
        };
      }

      // Format results with context
      const formattedResults = results
        .map((result, index) => {
          const distance = (result.distance as number).toFixed(3);
          const relevance = distance < "0.900"
            ? "🟢 Excellent"
            : distance < "1.000"
            ? "🟡 Good"
            : "🔵 Fair";

          return `**${index + 1}. ${
            result.title || "Untitled"
          } (${relevance} match - distance: ${distance})**\n${result.content}\n`;
        })
        .join("\n---\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} result(s) for: "${message}"${
              topic ? ` (topic: ${topic})` : ""
            }\n\n${formattedResults}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying knowledge base: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Register list_topics tool
server.registerTool(
  "list_topics",
  {
    description:
      "List all available topics in the knowledge base (e.g., 'zod', 'postgres', 'hono')",
    inputSchema: z.object({}),
  },
  () => {
    try {
      const topics = listTopics();

      if (topics.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No topics available in the knowledge base.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Available topics:\n${
              topics.map((t) => `  • ${t}`).join("\n")
            }`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing topics: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Register refresh_knowledge_topic tool
server.registerTool(
  "refresh_knowledge_topic",
  {
    description:
      "Refresh a specific knowledge topic. Fetches latest content from source, detects changes via checksum, and updates database if changed. If topic is not in database but fetch fails, alerts client.",
    inputSchema: z.object({
      topic: z.string().describe(
        "Topic name (must exist in config). E.g., 'zod', 'hono'",
      ),
      force: z.boolean().optional().default(false).describe(
        "Force reload even if checksum matches",
      ),
    }),
  },
  async (input) => {
    const { topic, force } = input;

    try {
      // Load config to get topic source URL
      const config = loadConfig();
      const topicsMap = getTopicsMap(config);
      const sourceUrl = topicsMap.get(topic);

      if (!sourceUrl) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Topic "${topic}" not found in configuration`,
            },
          ],
          isError: true,
        };
      }

      // Load the topic
      const result = await loadTopic(topic, sourceUrl, { force });

      const statusIcon = result.status === "cached"
        ? "✓"
        : result.status === "loaded"
        ? "✔️"
        : "⚠️";
      const statusText = result.status === "cached"
        ? "CACHED"
        : result.status === "loaded"
        ? "LOADED"
        : "FAILED";

      let responseText = `${statusIcon} ${topic}: ${statusText}\n` +
        `Chunks: ${result.chunks}\n` +
        `Checksum: ${result.checksum.substring(0, 8)}...\n` +
        `Duration: ${result.duration}ms`;

      if (result.error) {
        responseText += `\nError: ${result.error}`;
      }

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
        ],
        isError: result.status === "failed",
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error refreshing topic: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Start server
async function main() {
  try {
    // Load configuration
    const config = loadConfig();
    server.sendLoggingMessage({
      level: "info",
      data: "[startup] Config loaded successfully",
    });

    // Initialize database (synchronously, so it's ready before server starts)
    const databasePath = Deno.env.get("DATABASE_URL") ||
      "./data/knowledge.db";
    initializeDatabase(databasePath);
    server.sendLoggingMessage({
      level: "info",
      data: `[startup] Database initialized at ${databasePath}`,
    });

    // Spawn worker to load knowledge base in background (non-blocking)
    server.sendLoggingMessage({
      level: "info",
      data: "[startup] Starting knowledge loading in background...",
    });
    spawnKnowledgeWorker(config, databasePath);

    // Connect MCP server immediately (don't wait for knowledge loading)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    server.sendLoggingMessage({
      level: "info",
      data: "[startup] MCP server connected via stdio transport",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    server.sendLoggingMessage({
      level: "error",
      data: `[startup] FATAL: ${message}`,
    });
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    server.sendLoggingMessage({
      level: "error",
      data: `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    });
    Deno.exit(1);
  });

  // Cleanup on exit
  globalThis.addEventListener("beforeunload", () => {
    // Terminate worker if it's still running
    if (knowledgeWorker) {
      knowledgeWorker.terminate();
    }
    closeDatabase();
  });
}
