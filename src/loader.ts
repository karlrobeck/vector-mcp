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
import { createLogger } from "./logger.ts";

const log = createLogger("loader");

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

  log.info(`loadTopic: ${topicName} | force=${force} | dryRun=${dryRun}`);

  try {
    log.debug(`loadTopic: ${topicName} | step: fetch`);
    const fetchResult = await fetchSource(sourceUrl);
    log.debug(`loadTopic: ${topicName} | step: process`);
    const content = processContent(fetchResult.content, fetchResult.contentType);

    log.debug(`loadTopic: ${topicName} | step: checksum`);
    const existingMetadata = getTopicMetadata(topicName);
    const checksumMatches =
      existingMetadata?.last_checksum === fetchResult.checksum && !force;

    if (checksumMatches) {
      const duration = performance.now() - startTime;
      log.info(`loadTopic: ${topicName} | CACHED | ${existingMetadata?.chunk_count} chunks | ${Math.round(duration)}ms`);
      return {
        topic: topicName,
        status: "cached",
        chunks: existingMetadata?.chunk_count || 0,
        checksum: fetchResult.checksum,
        cached: true,
        duration: Math.round(duration),
      };
    }

    log.debug(`loadTopic: ${topicName} | step: chunk`);
    const chunks = chunkTextSemantic(content, 1000);
    log.debug(`loadTopic: ${topicName} | ${chunks.length} chunks created`);

    if (!dryRun) {
      log.debug(`loadTopic: ${topicName} | step: delete`);
      deleteTopicChunks(topicName);

      log.debug(`loadTopic: ${topicName} | step: embed+insert | ${chunks.length} chunks`);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await getEmbedding(chunk.content);
        insertVector(chunk, topicName, embedding);

        if (i === 0 || i === chunks.length - 1 || i % 50 === 0) {
          log.debug(`loadTopic: ${topicName} | embedded ${i + 1}/${chunks.length} chunks`);
        }
      }

      log.debug(`loadTopic: ${topicName} | step: metadata`);
      setTopicMetadata(topicName, sourceUrl, fetchResult.checksum, chunks.length);
    }

    const duration = performance.now() - startTime;
    log.info(`loadTopic: ${topicName} | LOADED | ${chunks.length} chunks | ${Math.round(duration)}ms`);
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

    log.error(`loadTopic: ${topicName} | FAILED | ${errorMessage}`);

    const topicStatus = getTopicStatus(topicName);

    if (topicStatus.exists) {
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
  const topics = Array.from(topicsMap.entries());

  log.info(`loadAllTopics: ${topics.length} topics to load`);

  const results: TopicLoadResult[] = [];

  for (const [topic, sourceUrl] of topics) {
    const result = await loadTopic(topic, sourceUrl, options);
    results.push(result);
  }

  const loaded = results.filter((r) => r.status === "loaded").length;
  const cached = results.filter((r) => r.status === "cached").length;
  const failed = results.filter((r) => r.status === "failed").length;

  log.info(`loadAllTopics: complete | ${loaded} loaded | ${cached} cached | ${failed} failed`);

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
