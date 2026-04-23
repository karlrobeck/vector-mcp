import { DatabaseSync } from "node:sqlite";
import { load } from "sqlite-vec";
import { SemanticChunk } from "./chunker.ts";

let db: DatabaseSync | null = null;

/**
 * Topic metadata stored in the database
 */
export interface TopicMetadata {
  id: number;
  topic: string;
  source_url: string;
  last_checksum: string | null;
  chunk_count: number;
  last_loaded_at: string | null;
  last_attempted_at: string | null;
  last_error: string | null;
  created_at: string;
}

/**
 * Serializes a float32 array to a buffer in sqlite-vec compatible format
 */
function serializeVector(embedding: number[]): Uint8Array {
  const buffer = new Float32Array(embedding);
  return new Uint8Array(buffer.buffer);
}

/**
 * Initializes the SQLite database with sqlite-vec support.
 * Creates the new vectors table with full hierarchy support.
 * Only creates table if it doesn't exist (preserves existing data).
 */
export function initializeDatabase(path: string = ":memory:"): void {
  db = new DatabaseSync(path, { allowExtension: true });

  // Load sqlite-vec extension
  load(db);

  // Create topic_metadata table for tracking topic checksums
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT UNIQUE NOT NULL,
      source_url TEXT NOT NULL,
      last_checksum TEXT,
      chunk_count INTEGER DEFAULT 0,
      last_loaded_at DATETIME,
      last_attempted_at DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create index on topic for fast lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_topic_metadata_topic ON topic_metadata(topic);
  `);

  // Create new vectors table with full hierarchy (only if it doesn't exist)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      
      -- Content
      content TEXT NOT NULL,
      
      -- Topic & Title
      topic TEXT NOT NULL,
      title TEXT,
      breadcrumb TEXT,
      
      -- Full Hierarchy (for filtering and context)
      h1 TEXT,
      h2 TEXT,
      h3 TEXT,
      h4 TEXT,
      level INTEGER DEFAULT 0,
      
      -- Parent Context (full sections)
      parent_context TEXT,
      
      -- Code Metadata
      has_code_block BOOLEAN DEFAULT 0,
      code_languages TEXT,
      
      -- Vector & Metadata
      embedding BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create indexes (if they don't exist)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_topic ON vectors(topic);
    CREATE INDEX IF NOT EXISTS idx_level ON vectors(level);
    CREATE INDEX IF NOT EXISTS idx_h2 ON vectors(h2);
    CREATE INDEX IF NOT EXISTS idx_h3 ON vectors(h3);
    CREATE INDEX IF NOT EXISTS idx_code ON vectors(has_code_block);
  `);

  console.error(`Database initialized at ${path}`);
}

/**
 * Inserts a semantic chunk into the database.
 */
export function insertVector(
  chunk: SemanticChunk,
  topic: string,
  embedding: number[]
): number {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const stmt = db.prepare(`
    INSERT INTO vectors (
      content, 
      topic, 
      title, 
      breadcrumb, 
      h1, 
      h2, 
      h3, 
      h4, 
      level,
      parent_context, 
      has_code_block, 
      code_languages, 
      embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const vectorBuffer = serializeVector(embedding);
  const codeLanguagesJson = JSON.stringify(chunk.codeLanguages);

  stmt.run(
    chunk.content,
    topic,
    chunk.title,
    chunk.breadcrumb,
    chunk.h1 || null,
    chunk.h2 || null,
    chunk.h3 || null,
    chunk.h4 || null,
    chunk.level,
    chunk.parentContext,
    chunk.hasCodeBlock ? 1 : 0,
    codeLanguagesJson,
    vectorBuffer
  );

  // Get the last inserted row ID
  const idStmt = db.prepare(`SELECT last_insert_rowid() as id`);
  const result = idStmt.get() as { id: number };
  return result.id;
}

/**
 * Queries the vector database by similarity to an embedding with optional topic filtering.
 */
export function queryVectors(
  queryEmbedding: number[],
  topic?: string,
  limit: number = 5
): Array<{
  id: number;
  content: string;
  topic: string;
  title: string;
  breadcrumb: string;
  distance: number;
  hasCodeBlock: boolean;
  codeLanguages: string[];
}> {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const queryBuffer = serializeVector(queryEmbedding);

  let query = `
    SELECT 
      id, 
      content, 
      topic,
      title,
      breadcrumb,
      has_code_block,
      code_languages,
      vec_distance_L2(embedding, ?) as distance
    FROM vectors
  `;

  const params: any[] = [queryBuffer];

  if (topic) {
    query += ` WHERE topic = ?`;
    params.push(topic);
  }

  query += ` ORDER BY distance ASC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  const results = stmt.all(...params) as any[];

  return results.map((row) => ({
    id: row.id,
    content: row.content,
    topic: row.topic,
    title: row.title,
    breadcrumb: row.breadcrumb,
    distance: row.distance,
    hasCodeBlock: row.has_code_block === 1,
    codeLanguages: row.code_languages ? JSON.parse(row.code_languages) : [],
  }));
}

/**
 * Queries the vector database with section-aware grouping.
 * Returns top results grouped by breadcrumb for comprehensive context.
 */
export function queryVectorsWithContext(
  queryEmbedding: number[],
  topic?: string,
  limit: number = 5
): Array<{
  id: number;
  content: string;
  topic: string;
  title: string;
  breadcrumb: string;
  distance: number;
  hasCodeBlock: boolean;
  codeLanguages: string[];
}> {
  const results = queryVectors(queryEmbedding, topic, limit * 2);

  // Group by breadcrumb to get section context
  const grouped = new Map<
    string,
    Array<{
      id: number;
      content: string;
      topic: string;
      title: string;
      breadcrumb: string;
      distance: number;
      hasCodeBlock: boolean;
      codeLanguages: string[];
    }>
  >();

  for (const result of results) {
    const key = result.breadcrumb || "General";
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(result);
  }

  // Flatten back to list but preserve grouping order
  const flattened: Array<{
    id: number;
    content: string;
    topic: string;
    title: string;
    breadcrumb: string;
    distance: number;
    hasCodeBlock: boolean;
    codeLanguages: string[];
  }> = [];

  for (const [, items] of grouped) {
    flattened.push(...items.slice(0, 2)); // Top 2 from each section
  }

  return flattened.slice(0, limit);
}

/**
 * Retrieves all distinct topics in the database.
 */
export function listTopics(): string[] {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const stmt = db.prepare(`SELECT DISTINCT topic FROM vectors ORDER BY topic ASC`);
  const results = stmt.all() as any[];
  return results.map((row) => row.topic);
}

/**
 * Get a chunk by ID with full context
 */
export function getChunkById(id: number): {
  id: number;
  content: string;
  breadcrumb: string;
  parentContext: string;
  title: string;
  h1: string;
  h2?: string;
  h3?: string;
  h4?: string;
  hasCodeBlock: boolean;
  codeLanguages: string[];
} | null {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const stmt = db.prepare(`
    SELECT 
      id, 
      content, 
      breadcrumb, 
      parent_context,
      title,
      h1,
      h2,
      h3,
      h4,
      has_code_block,
      code_languages
    FROM vectors 
    WHERE id = ?
  `);

  const row = stmt.get(id) as any;

  if (!row) return null;

  return {
    id: row.id,
    content: row.content,
    breadcrumb: row.breadcrumb,
    parentContext: row.parent_context,
    title: row.title,
    h1: row.h1,
    h2: row.h2,
    h3: row.h3,
    h4: row.h4,
    hasCodeBlock: row.has_code_block === 1,
    codeLanguages: row.code_languages ? JSON.parse(row.code_languages) : [],
  };
}

/**
 * Query chunks by heading level
 */
export function queryByLevel(level: number, topic?: string, limit: number = 10): any[] {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  let query = `SELECT * FROM vectors WHERE level = ?`;
  const params: any[] = [level];

  if (topic) {
    query += ` AND topic = ?`;
    params.push(topic);
  }

  query += ` LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Query chunks with code blocks
 */
export function queryCodeExamples(topic?: string, limit: number = 10): any[] {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  let query = `SELECT * FROM vectors WHERE has_code_block = 1`;
  const params: any[] = [];

  if (topic) {
    query += ` AND topic = ?`;
    params.push(topic);
  }

  query += ` LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get database statistics
 */
export function getStats(): {
  totalChunks: number;
  topics: string[];
  avgChunkSize: number;
  chunksWithCode: number;
} {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const totalStmt = db.prepare(`SELECT COUNT(*) as count FROM vectors`);
  const totalResult = totalStmt.get() as { count: number };

  const avgStmt = db.prepare(`SELECT AVG(LENGTH(content)) as avg FROM vectors`);
  const avgResult = avgStmt.get() as { avg: number };

  const codeStmt = db.prepare(`SELECT COUNT(*) as count FROM vectors WHERE has_code_block = 1`);
  const codeResult = codeStmt.get() as { count: number };

  const topics = listTopics();

  return {
    totalChunks: totalResult.count,
    topics: topics,
    avgChunkSize: Math.round(avgResult.avg || 0),
    chunksWithCode: codeResult.count,
  };
}

/**
 * Get metadata for a specific topic
 */
export function getTopicMetadata(topic: string): TopicMetadata | null {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const stmt = db.prepare(`SELECT * FROM topic_metadata WHERE topic = ?`);
  const result = stmt.get(topic) as TopicMetadata | undefined;
  return result || null;
}

/**
 * Set or update metadata for a topic
 */
export function setTopicMetadata(
  topic: string,
  sourceUrl: string,
  checksum: string | null,
  chunkCount: number,
  error: string | null = null
): TopicMetadata {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const now = new Date().toISOString();
  const existingMetadata = getTopicMetadata(topic);

  if (existingMetadata) {
    // Update existing
    const stmt = db.prepare(`
      UPDATE topic_metadata 
      SET source_url = ?, 
          last_checksum = ?, 
          chunk_count = ?, 
          last_loaded_at = ?, 
          last_attempted_at = ?, 
          last_error = ?
      WHERE topic = ?
    `);
    stmt.run(sourceUrl, checksum, chunkCount, checksum ? now : null, now, error, topic);
  } else {
    // Insert new
    const stmt = db.prepare(`
      INSERT INTO topic_metadata (topic, source_url, last_checksum, chunk_count, last_loaded_at, last_attempted_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(topic, sourceUrl, checksum, chunkCount, checksum ? now : null, now, error);
  }

  const updated = getTopicMetadata(topic);
  if (!updated) throw new Error(`Failed to set metadata for topic: ${topic}`);
  return updated;
}

/**
 * Delete all chunks for a specific topic
 * @returns Number of chunks deleted
 */
export function deleteTopicChunks(topic: string): number {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const stmt = db.prepare(`DELETE FROM vectors WHERE topic = ?`);
  stmt.run(topic);

  // Get the number of changes from the last statement
  const changesStmt = db.prepare(`SELECT changes() as changes`);
  const result = changesStmt.get() as { changes: number };
  return result.changes;
}

/**
 * Get status information for a topic
 */
export function getTopicStatus(topic: string): {
  exists: boolean;
  chunkCount: number;
  lastChecksum: string | null;
  lastLoadedAt: string | null;
  lastError: string | null;
} {
  const metadata = getTopicMetadata(topic);

  if (!metadata) {
    return {
      exists: false,
      chunkCount: 0,
      lastChecksum: null,
      lastLoadedAt: null,
      lastError: null,
    };
  }

  return {
    exists: true,
    chunkCount: metadata.chunk_count,
    lastChecksum: metadata.last_checksum,
    lastLoadedAt: metadata.last_loaded_at,
    lastError: metadata.last_error,
  };
}

/**
 * Closes the database connection.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.error("Database connection closed");
  }
}
