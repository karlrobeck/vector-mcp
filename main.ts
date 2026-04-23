import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import * as z from "zod";
import { getEmbedding } from "./src/embedding.ts";
import {
  closeDatabase,
  getTopicMetadata,
  initializeDatabase,
  insertVector,
  listTopics,
  queryVectorsWithContext,
  setTopicMetadata,
} from "./src/db.ts";
import { loadConfig, getTopicsMap } from "./src/config.ts";
import { loadTopic, loadAllTopics } from "./src/loader.ts";
import { createLogger } from "./src/logger.ts";

const log = createLogger("main");

export const server = new McpServer({ name: "vector-mcp", version: "1.0.0" });

let backgroundLoadingPromise: Promise<void> | null = null;

function startBackgroundLoading(config: ReturnType<typeof loadConfig>): void {
  backgroundLoadingPromise = (async () => {
    try {
      log.info("startBackgroundLoading: starting");
      await loadAllTopics(config);
      log.info("startBackgroundLoading: complete");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`startBackgroundLoading: failed | ${message}`);
    }
  })();
}

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
      log.debug(`query_knowledge_base: "${message}" | topic=${topic ?? "all"} | limit=${limit}`);

      const queryEmbedding = await getEmbedding(message);
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

server.registerTool(
  "list_topics",
  {
    description:
      "List all available topics in the knowledge base (e.g., 'zod', 'postgres', 'hono')",
    inputSchema: z.object({}),
  },
  () => {
    try {
      log.debug("list_topics: querying");
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
      log.info(`refresh_knowledge_topic: ${topic} | force=${force}`);

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

async function main() {
  try {
    log.info("main: starting");

    const config = loadConfig();
    log.info("main: config loaded");

    const databasePath = Deno.env.get("DATABASE_URL") ||
      "./data/knowledge.db";
    initializeDatabase(databasePath);
    log.info(`main: database initialized | ${databasePath}`);

    log.info("main: starting background loading...");
    startBackgroundLoading(config);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("main: MCP server connected via stdio transport");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`main: FATAL | ${message}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    log.error(`main: uncaught | ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  });

  globalThis.addEventListener("beforeunload", () => {
    log.info("main: cleanup");
    closeDatabase();
  });
}