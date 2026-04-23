import { z } from "zod";

/**
 * Topic name must be lowercase alphanumeric with hyphens and underscores
 */
const topicNameSchema = z
  .string()
  .toLowerCase()
  .regex(/^[a-z0-9_-]+$/, "Topic name must contain only lowercase letters, numbers, hyphens, and underscores");

/**
 * Configuration schema for vector-mcp
 */
const configSchema = z.object({
  topics: z.array(
    z.record(topicNameSchema, z.string().url("Topic URL must be a valid URL"))
  ),
  embedding: z
    .object({
      model: z.string().default("Xenova/all-MiniLM-L6-v2"),
    })
    .optional(),
  chunking: z
    .object({
      maxSize: z.number().int().positive().default(1000),
    })
    .optional(),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Loads and validates configuration from VECTOR_MCP_CONFIG environment variable
 * @throws Error if config file not found, invalid JSON, or fails validation
 */
export function loadConfig(): Config {
  const configPath = Deno.env.get("VECTOR_MCP_CONFIG");

  if (!configPath) {
    throw new Error(
      'VECTOR_MCP_CONFIG environment variable not set. Please set it to the path of your config.json file'
    );
  }

  let configContent: string;
  try {
    configContent = Deno.readTextFileSync(configPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Config file not found at: ${configPath}`);
    }
    throw new Error(`Failed to read config file at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let configJson: unknown;
  try {
    configJson = JSON.parse(configContent);
  } catch (error) {
    throw new Error(`Invalid JSON in config file at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return configSchema.parse(configJson);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n");
      throw new Error(`Configuration validation failed:\n${issues}`);
    }
    throw error;
  }
}

/**
 * Converts topics array to a Map<topicName, sourceUrl>
 */
export function getTopicsMap(config: Config): Map<string, string> {
  const topicsMap = new Map<string, string>();

  for (const topicObj of config.topics) {
    for (const [topic, url] of Object.entries(topicObj)) {
      topicsMap.set(topic, url);
    }
  }

  return topicsMap;
}

/**
 * Gets the embedding model name from config
 */
export function getEmbeddingModel(config: Config): string {
  return config.embedding?.model || "Xenova/all-MiniLM-L6-v2";
}

/**
 * Gets the max chunk size from config
 */
export function getChunkingMaxSize(config: Config): number {
  return config.chunking?.maxSize || 1000;
}
