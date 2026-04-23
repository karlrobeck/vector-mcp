import { initializeDatabase, closeDatabase, getTopicStatus } from "../src/db.ts";
import { loadConfig, getTopicsMap } from "../src/config.ts";
import { loadAllTopics, loadTopic, getTopicStatusMessage } from "../src/loader.ts";

/**
 * Parse CLI arguments
 */
interface CliArgs {
  topic?: string;
  force: boolean;
  dryRun: boolean;
  status: boolean;
  help: boolean;
}

function parseArgs(): CliArgs {
  const args = Deno.args;
  const result: CliArgs = {
    force: false,
    dryRun: false,
    status: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--topic" || arg === "-t") {
      result.topic = args[++i];
    } else if (arg === "--force" || arg === "-f") {
      result.force = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--status" || arg === "-s") {
      result.status = true;
    }
  }

  return result;
}

/**
 * Print help message
 */
function printHelp(): void {
  const help = `
vector-mcp Knowledge Base Loader

USAGE:
  deno task load [OPTIONS]

OPTIONS:
  --help, -h              Show this help message
  --topic <name>, -t      Load a specific topic (e.g., 'zod', 'hono')
  --force, -f             Force reload even if checksum matches
  --dry-run               Test loading without inserting to database
  --status, -s            Show status of a topic (requires --topic)

EXAMPLES:
  # Load all topics from config
  deno task load

  # Load single topic
  deno task load --topic zod

  # Force reload (ignore checksum)
  deno task load --topic hono --force

  # Test parsing without inserting
  deno task load --topic zod --dry-run

  # Show topic status
  deno task load --topic zod --status
`;

  console.log(help);
}

/**
 * Format a number with commas
 */
function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Print formatted table of results
 */
function printResults(results: Array<any>): void {
  const sorted = [...results].sort((a, b) => {
    // Sort by: loaded > cached > failed
    const order = { loaded: 0, cached: 1, failed: 2 };
    return order[a.status] - order[b.status];
  });

  console.log("\n📚 Knowledge Base Loading Results\n");

  for (const result of sorted) {
    const statusIcon =
      result.status === "loaded"
        ? "✔️"
        : result.status === "cached"
          ? "✓"
          : "❌";
    const statusColor =
      result.status === "loaded"
        ? "\x1b[32m"
        : result.status === "cached"
          ? "\x1b[36m"
          : "\x1b[33m";
    const reset = "\x1b[0m";

    const status =
      result.status === "cached"
        ? `${statusColor}CACHED${reset}`
        : result.status === "loaded"
          ? `${statusColor}LOADED${reset}`
          : `${statusColor}FAILED${reset}`;

    const chunkCount = formatNumber(result.chunks);
    const checksumShort = result.checksum.substring(0, 8);

    console.log(`${statusIcon} ${result.topic.padEnd(15)} │ ${status} │ ${chunkCount} chunks │ ${checksumShort}...`);

    if (result.error) {
      console.log(`   └─ Error: ${result.error}`);
    }

    if (result.cached) {
      console.log(`   └─ Skipped (checksum matches)`);
    }

    if (result.duration) {
      console.log(`   └─ Loaded in ${result.duration}ms`);
    }
  }

  // Summary
  const total = sorted.length;
  const loaded = sorted.filter((r) => r.status === "loaded").length;
  const cached = sorted.filter((r) => r.status === "cached").length;
  const failed = sorted.filter((r) => r.status === "failed").length;

  console.log(`\n📊 Summary: ${total} total | ${loaded} loaded | ${cached} cached | ${failed} failed\n`);
}

/**
 * Main CLI entry point
 */
async function main() {
  try {
    const args = parseArgs();

    if (args.help) {
      printHelp();
      return;
    }

    // Load config
    const config = loadConfig();
    const databasePath = Deno.env.get("DATABASE_URL") || "./data/knowledge.db";

    // Initialize database
    initializeDatabase(databasePath);

    // Handle status command
    if (args.status) {
      if (!args.topic) {
        console.error("❌ Error: --status requires --topic");
        Deno.exit(1);
      }

      const topicStatus = getTopicStatus(args.topic);

      if (!topicStatus.exists) {
        console.log(`\n❌ Topic "${args.topic}" not found in database\n`);
        Deno.exit(0);
      }

      console.log(`\n📋 Status for topic: ${args.topic}\n`);
      console.log(`  Chunks:        ${formatNumber(topicStatus.chunkCount)}`);
      console.log(`  Last checksum: ${topicStatus.lastChecksum ? topicStatus.lastChecksum.substring(0, 16) + "..." : "N/A"}`);
      console.log(
        `  Last loaded:   ${topicStatus.lastLoadedAt ? new Date(topicStatus.lastLoadedAt).toLocaleString() : "Never"}`
      );
      if (topicStatus.lastError) {
        console.log(`  Last error:    ${topicStatus.lastError}`);
      }
      console.log("");
      return;
    }

    // Load topics
    if (args.topic) {
      // Load single topic
      const topicsMap = getTopicsMap(config);
      const sourceUrl = topicsMap.get(args.topic);

      if (!sourceUrl) {
        console.error(`❌ Error: Topic "${args.topic}" not found in configuration`);
        Deno.exit(1);
      }

      console.log(`\n🔄 Loading topic: ${args.topic}${args.force ? " (force reload)" : ""}${args.dryRun ? " (dry-run)" : ""}\n`);

      const result = await loadTopic(args.topic, sourceUrl, {
        force: args.force,
        dryRun: args.dryRun,
      });

      printResults([result]);

      if (result.status === "failed") {
        Deno.exit(1);
      }
    } else {
      // Load all topics
      console.log(`\n🔄 Loading all topics${args.force ? " (force reload)" : ""}${args.dryRun ? " (dry-run)" : ""}\n`);

      const results = await loadAllTopics(config, {
        force: args.force,
        dryRun: args.dryRun,
      });

      printResults(results);

      const hasFailures = results.some((r) => r.status === "failed");
      if (hasFailures) {
        Deno.exit(1);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Error: ${message}\n`);
    Deno.exit(1);
  } finally {
    closeDatabase();
  }
}

if (import.meta.main) {
  main();
}
