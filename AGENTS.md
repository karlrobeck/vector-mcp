# Agents Guide: vector-mcp

## Tech Stack
- **Runtime**: Deno
- **Framework**: Model Context Protocol (MCP) server
- **Vector DB**: SQLite + sqlite-vec (L2 distance metric)
- **Embeddings**: Hugging Face Transformers (Xenova/all-MiniLM-L6-v2)

## Commands
- `deno task dev` — Run MCP server with watch mode (loads all topics on startup)
- `deno task load` — Load all topics from config.json
- `deno task load --topic <name>` — Load single topic
- `deno task load --topic <name> --force` — Force reload (ignore checksum)
- `deno task load --topic <name> --status` — Show topic status
- `deno task load --dry-run` — Test without inserting to DB

## Architecture

### Entry Point (`main.ts`)
- Loads config from `VECTOR_MCP_CONFIG`
- Initializes database synchronously
- Spawns worker thread to load topics in background (server handles queries immediately)
- Registers 3 MCP tools: `query_knowledge_base`, `list_topics`, `refresh_knowledge_topic`
- Uses stdio transport; logs to stderr, stdout reserved for MCP protocol

### Core Modules
- **`src/config.ts`**: Validates config with Zod. Topic names must match `[a-z0-9_-]+`.
- **`src/db.ts`**: SQLite + sqlite-vec. Schema: `vectors` (content, topic, h1-h4, breadcrumbs, embeddings BLOB) and `topic_metadata`. Initialize with `initializeDatabase(path)` before any queries.
- **`src/chunker.ts`**: Hierarchical semantic chunking. Code blocks (```/~~~) preserved intact. Breadcrumbs built from heading path. Minimum chunk: 50 chars, 5 words.
- **`src/embedding.ts`**: Lazy-loads Xenova/all-MiniLM-L6-v2 on first call (~300MB download).
- **`src/source.ts`**: HTTP/file fetch with auto content-type detection, SHA256 checksum.
- **`src/loader.ts`**: Checksum-based caching. Fetch → checksum → compare → (update or skip).
- **`src/knowledge-worker.ts`**: Background thread for non-blocking topic loading. Posts `{ type: 'log' }`, `'progress'`, `'complete'`, `'error'` messages.
- **`scripts/load.ts`**: CLI with `--topic`, `--force`, `--dry-run`, `--status` flags.

## Configuration

```json
{
  "topics": [
    { "zod": "https://zod.dev/llms-full.txt" },
    { "hono": "https://hono.dev/llms-full.txt" }
  ]
}
```

- `VECTOR_MCP_CONFIG` — Path to config.json (**required**, fatal if missing)
- `DATABASE_URL` — Path to SQLite DB (default: `./data/knowledge.db`)
- `DENO_DIR` — Deno cache directory (default: `.deno`)

## Gotchas
1. **First embedding**: Model downloads ~300MB on first call; Deno caches in `.deno`
2. **allowScripts**: Deno must allow scripts for sqlite3, onnxruntime-node, protobufjs, sharp
3. **Vector storage**: Float32Array → Uint8Array for sqlite-vec
4. **Non-blocking startup**: Server available immediately; queries work during background loading
5. **Checksum caching**: SHA256 of entire fetched content; small changes trigger full reload
6. **Query grouping**: `queryVectorsWithContext()` returns top-2 per breadcrumb section (max 10), not pure top-10 by distance
7. **Cleanup**: `beforeunload` terminates worker and closes database

## VSCode Testing
`.vscode/mcp.json` configures the MCP server for VSCode MCP extension with correct env vars.
