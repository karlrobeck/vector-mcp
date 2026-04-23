# vector-mcp

![Deno](https://img.shields.io/badge/Deno-1.46+-000000?style=flat&logo=deno&logoColor=ffffff)
![License](https://img.shields.io/badge/License-MIT-29B700?style=flat)
![npm](https://img.shields.io/badge/sqlite--vec-0.1.9-326CE5?style=flat&logo=sqlite&logoColor=326CE5)

A Model Context Protocol (MCP) server for semantic knowledge base querying with vector embeddings.

## Overview

`vector-mcp` loads documentation from URLs, chunks content semantically, embeds it using transformer models, and stores vectors in SQLite for semantic search. Exposes 3 MCP tools: `query_knowledge_base`, `list_topics`, and `refresh_knowledge_topic`.

## Quick Start

### 1. Install Deno

```bash
curl -fsSL https://deno.land/install.sh | sh
```

### 2. Configure Topics

Create a `config.json` file:

```json
{
  "topics": [
    { "[topic-name]": "[URL]" }
  ]
}
```

Example:

```json
{
  "topics": [
    { "zod": "https://zod.dev/llms-full.txt" },
    { "hono": "https://hono.dev/llms-full.txt" }
  ]
}
```

### 3. Run the Server

```bash
export VECTOR_MCP_CONFIG=./config.json
deno task dev
```

The server starts immediately and begins loading topics in the background.

## Features

- **Semantic Search** — Query knowledge bases using natural language with L2 distance similarity
- **Topic Filtering** — Scope queries to specific topics or search across all
- **Hierarchical Chunking** — Preserve document structure (H1-H4 headings, breadcrumbs, parent context)
- **Code Preservation** — Code blocks are never split across chunks
- **Checksum Caching** — Only re-embeds when source content changes (SHA256)
- **Non-blocking Startup** — Server ready immediately; queries work during background loading
- **Section-aware Results** — Groups results by section to provide comprehensive context

## Configuration

### config.json

```json
{
  "topics": [
    { "[topic-name]": "[URL]" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `topics` | `Array<{ [name]: string }>` | Map topic names to source URLs |

**Constraints**:
- Topic names must match `[a-z0-9_-]+`
- Sources must be HTTP(S) URLs or local file paths
- Minimum chunk: 50 characters, 5 words

## Environment Variables

| Variable | Required | Default | Description |
|---------|----------|---------|-------------|
| `VECTOR_MCP_CONFIG` | Yes | — | Path to `config.json` |
| `DATABASE_URL` | No | `./data/knowledge.db` | Path to SQLite database |
| `DENO_DIR` | No | `.deno` | Deno cache directory |

## MCP Tools

### query_knowledge_base

Query the vector knowledge base with semantic search.

**Input**:

```typescript
{
  message: string;      // Query text
  topic?: string;       // Optional topic filter
  limit?: number;      // Results to return (1-10, default: 5)
}
```

**Example Request**:

```json
{
  "message": "How do I define a schema with Zod?",
  "topic": "zod",
  "limit": 5
}
```

**Example Response**:

```text
Found 3 results for: "How do I define a schema with Zod?" (topic: zod)

**1. Creating Schemas (🟢 Excellent match - distance: 0.712)**
...

---
```

### list_topics

List all available topics in the knowledge base.

**Input**: (empty)

**Example Response**:

```text
Available topics:
  • hono
  • zod
```

### refresh_knowledge_topic

Refresh a specific knowledge topic. Fetches latest content and updates database if checksum changed.

**Input**:

```typescript
{
  topic: string;       // Topic name from config
  force?: boolean;   // Force reload even if checksum matches
}
```

**Example Response**:

```text
✔️ zod: LOADED
Chunks: 127
Checksum: abc12345...
Duration: 1650ms
```

## Architecture

### Core Modules

| Module | Purpose |
|--------|---------|
| `main.ts` | MCP server entry, stdio transport, 3 registered tools |
| `src/db.ts` | SQLite + sqlite-vec, database operations |
| `src/chunker.ts` | Hierarchical semantic chunking with breadcrumbs |
| `src/embedding.ts` | HuggingFace Xenova/all-MiniLM-L6-v2 (lazy load) |
| `src/config.ts` | Zod validation for config.json |
| `src/loader.ts` | Fetch → checksum → chunk → embed → insert pipeline |
| `src/source.ts` | HTTP/file fetch with content-type detection |
| `src/logger.ts` | Structured logging to stderr |

### Database Schema

**vectors table**:

| Column | Type | Description |
|-------|------|-------------|
| `id` | INTEGER | Primary key |
| `content` | TEXT | Chunk content |
| `topic` | TEXT | Topic name |
| `title` | TEXT | Section title |
| `breadcrumb` | TEXT | Full heading path |
| `h1`–`h4` | TEXT | Hierarchical headings |
| `level` | INTEGER | Heading depth (0-4) |
| `parent_context` | TEXT | Parent section content |
| `has_code_block` | BOOLEAN | Contains code |
| `code_languages` | TEXT | JSON array of languages |
| `embedding` | BLOB | Float32 vector (384 dimensions) |

**topic_metadata table**:

| Column | Type | Description |
|-------|------|-------------|
| `topic` | TEXT | Topic name (unique) |
| `source_url` | TEXT | Source URL |
| `last_checksum` | TEXT | SHA256 of last fetch |
| `chunk_count` | INTEGER | Number of chunks |
| `last_loaded_at` | DATETIME | Last successful load |
| `last_error` TEXT | Last error message |

### Chunking Strategy

1. **Parse** — Build markdown tree from headings
2. **Preserve Code** — Never split code blocks (` ``` ` or `~~~`)
3. **Context** — Include full parent section content in each chunk
4. **Breadcrumbs** — Full heading path (e.g., `Defining schemas > Strings > Emails`)
5. **Split** — Split large sections by paragraphs (max 1000 chars default)
6. **Filter** — Remove chunks < 50 chars or < 5 words

## Development

### Prerequisites

- Deno 1.46+
- Scripts enabled for: `better-sqlite3`, `onnxruntime-node`, `protobufjs`, `sharp`

```json
{
  "allowScripts": [
    "npm:better-sqlite3",
    "npm:onnxruntime-node@1.24.3",
    "npm:protobufjs@7.5.5",
    "npm:sharp@0.34.5"
  ]
}
```

### Commands

| Command | Description |
|---------|-------------|
| `deno task dev` | Run MCP server with watch mode |
| `deno task load` | Load all topics into database |
| `deno task load --topic <name>` | Load single topic |
| `deno task load --topic <name> --force` | Force reload (ignore checksum) |
| `deno task load --topic <name> --status` | Show topic status |

### CLI Options

| Option | Description |
|--------|-------------|
| `--topic`, `-t` | Load a specific topic |
| `--force`, `-f` | Force reload even if checksum matches |
| `--dry-run` | Test parsing without inserting |
| `--status`, `-s` | Show status of a topic |
| `--help`, `-h` | Show help message |

## Integration

### OpenCode MCP

Add to your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vector-mcp": {
      "type": "local",
      "command": [
        "env",
        "DENO_DIR=.deno",
        "DATABASE_URL=./data/knowledge.db",
        "VECTOR_MCP_CONFIG=./config.json",
        "deno",
        "run",
        "-A",
        "main.ts"
      ],
      "enabled": true
    }
  }
}
```

Then query from OpenCode:

```
/query "How do I create a Zod schema?" --topic zod
```

### VSCode MCP Extension

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "vector-mcp": {
      "command": "deno",
      "args": ["run", "-A", "main.ts"],
      "env": {
        "DENO_DIR": ".deno",
        "DATABASE_URL": "${workspaceFolder}/data/knowledge.db",
        "VECTOR_MCP_CONFIG": "${workspaceFolder}/config.json"
      },
      "cwd": "${workspaceFolder}"
    }
  }
}
```

Then use the `vector-mcp` server from VSCode's MCP extension.

## Gotchas

1. **First Embedding Download** — The first query triggers ~300MB model download, subsequent queries are fast

2. **Script Permissions** — Deno requires `--allow-scripts` for native modules:
   - `better-sqlite3` — SQLite bindings
   - `onnxruntime-node` — Transformer inference
   - `protobufjs` — Model loading
   - `sharp` — Image processing (if needed)

3. **Checksum Caching** — SHA256 of entire fetched content; even whitespace changes trigger full reload

4. **Query Grouping** — Returns top-2 results per breadcrumb section (max 10 total) for context diversity, not pure top-10 by distance

5. **Non-blocking Startup** — Server accepts queries immediately while topics load in background

## License

MIT License

Copyright (c) 2024

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.