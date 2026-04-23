import { chunkTextSemantic } from "./chunker.ts";
import { getEmbedding } from "./embedding.ts";
import {
  insertVector,
  deleteTopicChunks,
  setTopicMetadata,
  getTopicMetadata,
  getTopicStatus,
} from "./db.ts";
import { fetchSource, processContent } from "./source.ts";
import { Config, getTopicsMap } from "./config.ts";

/**
 * Result of loading a topic
 */
export interface TopicLoadResult {
  topic: string;
  status: "cached" | "loaded" | "failed";
  chunks: number; // Number of chunks after loading
  checksum: string; // New or existing checksum
  cached: boolean; // true if skipped due to matching checksum
  error?: string; // If status === 'failed'
  duration: number; // Milliseconds
}

/**
 * Loads a single topic with self-healing (checksum-based)
 *
 * Algorithm:
 * 1. Fetch content from source
 * 2. Calculate checksum
 * 3. Compare with stored checksum
 *   - If matches: Cache hit, skip loading
 *   - If different: Delete old chunks, re-chunk, re-embed, insert new chunks
 * 4. Update topic_metadata
 * 5. Return result
 *
 * Error handling:
 * - If fetch fails and topic exists in DB: Keep existing chunks, alert client
 * - If fetch fails and topic is new: Alert client with error
 * - If chunking/embedding fails: Keep existing chunks, alert client
 */
export async function loadTopic(
  topicName: string,
  sourceUrl: string,
  options?: { force?: boolean; dryRun?: boolean }
): Promise<TopicLoadResult> {
  const startTime = performance.now();
  const force = options?.force ?? false;
  const dryRun = options?.dryRun ?? false;

  try {
    // Step 1: Fetch content
    const fetchResult = await fetchSource(sourceUrl);
    const content = processContent(fetchResult.content, fetchResult.contentType);

    // Step 2: Check if we need to load (checksum comparison)
    const existingMetadata = getTopicMetadata(topicName);
    const checksumMatches =
      existingMetadata?.last_checksum === fetchResult.checksum && !force;

    if (checksumMatches) {
      // Cache hit
      const duration = performance.now() - startTime;
      return {
        topic: topicName,
        status: "cached",
        chunks: existingMetadata?.chunk_count || 0,
        checksum: fetchResult.checksum,
        cached: true,
        duration: Math.round(duration),
      };
    }

    // Step 3: Need to load - chunk, embed, and insert
    const maxSize = 1000; // Default chunk size

    const chunks = chunkTextSemantic(content, maxSize);

    if (!dryRun) {
      // Delete existing chunks for this topic
      deleteTopicChunks(topicName);

      // Embed and insert each chunk
      for (const chunk of chunks) {
        const embedding = await getEmbedding(chunk.content);
        insertVector(chunk, topicName, embedding);
      }

      // Update metadata
      setTopicMetadata(topicName, sourceUrl, fetchResult.checksum, chunks.length);
    }

    const duration = performance.now() - startTime;
    return {
      topic: topicName,
      status: "loaded",
      chunks: chunks.length,
      checksum: fetchResult.checksum,
      cached: false,
      duration: Math.round(duration),
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if topic exists in database
    const topicStatus = getTopicStatus(topicName);

    if (topicStatus.exists) {
      // Keep existing chunks, alert client
      setTopicMetadata(topicName, sourceUrl, null, topicStatus.chunkCount, errorMessage);

      return {
        topic: topicName,
        status: "failed",
        chunks: topicStatus.chunkCount,
        checksum: topicStatus.lastChecksum || "",
        cached: false,
        error: errorMessage,
        duration: Math.round(duration),
      };
    } else {
      // New topic that couldn't be loaded
      return {
        topic: topicName,
        status: "failed",
        chunks: 0,
        checksum: "",
        cached: false,
        error: `Topic not found in database and fetch failed: ${errorMessage}`,
        duration: Math.round(duration),
      };
    }
  }
}

/**
 * Loads all topics from config with self-healing
 *
 * @param config - Configuration object containing topics
 * @param options - Loading options
 * @returns Array of loading results for each topic
 */
export async function loadAllTopics(
  config: Config,
  options?: { force?: boolean; dryRun?: boolean }
): Promise<TopicLoadResult[]> {
  const topicsMap = getTopicsMap(config);
  const results: TopicLoadResult[] = [];

  // Load all topics sequentially (respecting rate limiting)
  for (const [topic, sourceUrl] of topicsMap) {
    const result = await loadTopic(topic, sourceUrl, options);
    results.push(result);
  }

  return results;
}

/**
 * Gets human-readable status for a topic
 */
export function getTopicStatusMessage(result: TopicLoadResult): string {
  if (result.status === "cached") {
    return `${result.topic}: CACHED (checksum matches, ${result.chunks} chunks)`;
  } else if (result.status === "loaded") {
    return `${result.topic}: LOADED (${result.chunks} chunks in ${result.duration}ms)`;
  } else {
    return `${result.topic}: FAILED (${result.error})`;
  }
}
