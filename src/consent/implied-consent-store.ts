/**
 * Persistent SQLite + sqlite-vec store for consent pattern matching.
 *
 * Stores canonical request text patterns, their associated EffectClass
 * arrays, and vector embeddings for similarity search. Uses sqlite-vec's
 * vec0 virtual table for KNN cosine-distance queries.
 *
 * Database lives at ~/.openclaw/consent/consent-patterns.sqlite.
 * Follows the same patterns as src/tasks/task-registry.store.sqlite.ts
 * and packages/memory-host-sdk/src/host/memory-schema.ts.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { EffectClass } from "./types.js";

const log = createSubsystemLogger("consent/store");

const SCHEMA_VERSION = "1";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConsentPatternSource = "seed" | "learned" | "admin";

export type ConsentPattern = {
  id: number;
  text: string;
  effects: EffectClass[];
  source: ConsentPatternSource;
  confidence: number;
  createdAt: number;
  updatedAt: number;
};

export type PatternSearchResult = {
  pattern: ConsentPattern;
  distance: number;
};

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

type PatternRow = {
  id: number | bigint;
  text: string;
  effects: string;
  source: string;
  confidence: number;
  created_at: number | bigint;
  updated_at: number | bigint;
};

type VecSearchRow = {
  pattern_id: number | bigint;
  distance: number;
};

function rowToPattern(row: PatternRow): ConsentPattern {
  let effects: EffectClass[];
  try {
    effects = JSON.parse(row.effects) as EffectClass[];
  } catch {
    effects = [];
  }
  return {
    id: Number(row.id),
    text: row.text,
    effects,
    source: row.source as ConsentPatternSource,
    confidence: row.confidence,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type PreparedStatements = {
  insertPattern: StatementSync;
  selectPatternById: StatementSync;
  selectPatternByText: StatementSync;
  selectAllPatterns: StatementSync;
  deletePattern: StatementSync;
  updatePattern: StatementSync;
  insertEmbedding: StatementSync;
  deleteEmbedding: StatementSync;
  getMeta: StatementSync;
  setMeta: StatementSync;
};

export type ConsentPatternStore = {
  insertPattern(params: {
    text: string;
    effects: EffectClass[];
    source: ConsentPatternSource;
    confidence?: number;
    embedding?: Float32Array;
  }): ConsentPattern;

  upsertPattern(params: {
    text: string;
    effects: EffectClass[];
    source: ConsentPatternSource;
    confidence?: number;
    embedding?: Float32Array;
  }): ConsentPattern;

  getPatternById(id: number): ConsentPattern | undefined;
  getPatternByText(text: string): ConsentPattern | undefined;
  getAllPatterns(): ConsentPattern[];
  deletePattern(id: number): boolean;

  searchSimilarPatterns(
    embedding: Float32Array,
    k: number,
    threshold: number,
  ): PatternSearchResult[];

  getEmbeddingDimension(): number | undefined;
  getPatternCount(): number;

  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;

  close(): void;

  /** Exposed for testing; not part of the public contract. */
  readonly db: DatabaseSync;
};

export type OpenStoreParams = {
  /** Full path to the SQLite database file. */
  dbPath: string;
  /** Embedding dimension for the vec0 virtual table. */
  embeddingDimension: number;
  /** Pre-opened DatabaseSync instance (for testing). */
  injectedDb?: DatabaseSync;
  /** Skip sqlite-vec loading (for testing with mocks). */
  skipVecExtension?: boolean;
};

/**
 * Open (or create) the consent pattern store. Ensures schema, loads
 * the sqlite-vec extension, and creates the vec0 virtual table.
 */
export async function openConsentPatternStore(
  params: OpenStoreParams,
): Promise<ConsentPatternStore> {
  const { dbPath, embeddingDimension } = params;

  let db: DatabaseSync;
  if (params.injectedDb) {
    db = params.injectedDb;
  } else {
    const dir = dbPath.replace(/\/[^/]+$/, "");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    }

    const sqlite = await import("../infra/node-sqlite.js");
    db = new (sqlite.requireNodeSqlite().DatabaseSync)(dbPath);
    try {
      chmodSync(dbPath, FILE_MODE);
    } catch {
      // Best-effort; may fail on some platforms
    }
  }

  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  if (!params.skipVecExtension) {
    const { loadSqliteVecExtension } =
      await import("../../packages/memory-host-sdk/src/host/sqlite-vec.js");
    const vecResult = await loadSqliteVecExtension({ db });
    if (!vecResult.ok) {
      log.warn(`sqlite-vec extension failed to load: ${vecResult.error}`);
      throw new Error(`sqlite-vec extension failed to load: ${vecResult.error}`);
    }
  }

  ensureSchema(db, embeddingDimension);

  const stmts = prepareStatements(db);

  return createStoreApi(db, stmts, embeddingDimension);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function ensureSchema(db: DatabaseSync, dim: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      effects TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'seed',
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_patterns_text ON patterns(text);`);

  // vec0 virtual table for KNN search. The dimension is baked into the
  // CREATE statement. If the dimension changes, the table must be rebuilt.
  const existingDim = getMetaValue(db, "embedding_dimension");
  if (existingDim && Number(existingDim) !== dim) {
    log.warn(
      `embedding dimension changed from ${existingDim} to ${dim}; ` +
        "rebuilding pattern_embeddings table and re-seeding",
    );
    db.exec("DROP TABLE IF EXISTS pattern_embeddings;");
    setMetaValue(db, "embedding_dimension", String(dim));
    // Reset seeded flag so patterns get re-embedded with the new dimension
    setMetaValue(db, "seeded", "false");
  } else if (!existingDim) {
    setMetaValue(db, "embedding_dimension", String(dim));
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pattern_embeddings USING vec0(
        pattern_id INTEGER PRIMARY KEY,
        embedding float[${dim}] distance_metric=cosine
      );
    `);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`failed to create vec0 virtual table: ${message}`);
    throw err;
  }

  const version = getMetaValue(db, "schema_version");
  if (!version) {
    setMetaValue(db, "schema_version", SCHEMA_VERSION);
  }
}

function getMetaValue(db: DatabaseSync, key: string): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

function setMetaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

function prepareStatements(db: DatabaseSync): PreparedStatements {
  return {
    insertPattern: db.prepare(`
      INSERT INTO patterns (text, effects, source, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    selectPatternById: db.prepare("SELECT * FROM patterns WHERE id = ?"),
    selectPatternByText: db.prepare("SELECT * FROM patterns WHERE text = ?"),
    selectAllPatterns: db.prepare("SELECT * FROM patterns ORDER BY id"),
    deletePattern: db.prepare("DELETE FROM patterns WHERE id = ?"),
    updatePattern: db.prepare(`
      UPDATE patterns SET effects = ?, source = ?, confidence = ?, updated_at = ?
      WHERE id = ?
    `),
    insertEmbedding: db.prepare(
      "INSERT INTO pattern_embeddings (pattern_id, embedding) VALUES (?, ?)",
    ),
    deleteEmbedding: db.prepare("DELETE FROM pattern_embeddings WHERE pattern_id = ?"),
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"),
  };
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

function createStoreApi(
  db: DatabaseSync,
  stmts: PreparedStatements,
  dim: number,
): ConsentPatternStore {
  // vec0 KNN query must be prepared fresh because the dimension is dynamic
  // and the table may have been recreated.
  const vecSearchStmt = db.prepare(`
    SELECT pattern_id, distance
    FROM pattern_embeddings
    WHERE embedding MATCH ?
      AND k = ?
    ORDER BY distance
  `);

  function insertPatternImpl(params: {
    text: string;
    effects: EffectClass[];
    source: ConsentPatternSource;
    confidence?: number;
    embedding?: Float32Array;
  }): ConsentPattern {
    const now = Date.now();
    const confidence = params.confidence ?? 1.0;
    const effectsJson = JSON.stringify(params.effects);

    const result = stmts.insertPattern.run(
      params.text,
      effectsJson,
      params.source,
      confidence,
      now,
      now,
    );
    const id = Number(result.lastInsertRowid);

    if (params.embedding) {
      if (params.embedding.length !== dim) {
        throw new Error(
          `Embedding dimension mismatch: expected ${dim}, got ${params.embedding.length}`,
        );
      }
      stmts.insertEmbedding.run(id, params.embedding);
    }

    return {
      id,
      text: params.text,
      effects: params.effects,
      source: params.source,
      confidence,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    get db() {
      return db;
    },

    insertPattern: insertPatternImpl,

    upsertPattern(params) {
      if (params.embedding && params.embedding.length !== dim) {
        throw new Error(
          `Embedding dimension mismatch: expected ${dim}, got ${params.embedding.length}`,
        );
      }

      const existing = stmts.selectPatternByText.get(params.text) as PatternRow | undefined;
      if (existing) {
        const now = Date.now();
        const effectsJson = JSON.stringify(params.effects);
        const confidence = params.confidence ?? existing.confidence;
        stmts.updatePattern.run(effectsJson, params.source, confidence, now, Number(existing.id));

        if (params.embedding) {
          stmts.deleteEmbedding.run(Number(existing.id));
          stmts.insertEmbedding.run(Number(existing.id), params.embedding);
        }

        return {
          id: Number(existing.id),
          text: params.text,
          effects: params.effects,
          source: params.source,
          confidence,
          createdAt: Number(existing.created_at),
          updatedAt: now,
        };
      }
      return insertPatternImpl(params);
    },

    getPatternById(id: number) {
      const row = stmts.selectPatternById.get(id) as PatternRow | undefined;
      return row ? rowToPattern(row) : undefined;
    },

    getPatternByText(text: string) {
      const row = stmts.selectPatternByText.get(text) as PatternRow | undefined;
      return row ? rowToPattern(row) : undefined;
    },

    getAllPatterns() {
      const rows = stmts.selectAllPatterns.all() as PatternRow[];
      return rows.map(rowToPattern);
    },

    deletePattern(id: number) {
      stmts.deleteEmbedding.run(id);
      const result = stmts.deletePattern.run(id);
      return result.changes > 0;
    },

    searchSimilarPatterns(embedding, k, threshold) {
      if (embedding.length !== dim) {
        throw new Error(`Embedding dimension mismatch: expected ${dim}, got ${embedding.length}`);
      }

      const vecRows = vecSearchStmt.all(embedding, k) as VecSearchRow[];
      const results: PatternSearchResult[] = [];

      for (const vecRow of vecRows) {
        if (vecRow.distance > threshold) {
          continue;
        }
        const patternRow = stmts.selectPatternById.get(Number(vecRow.pattern_id)) as
          | PatternRow
          | undefined;
        if (patternRow) {
          results.push({
            pattern: rowToPattern(patternRow),
            distance: vecRow.distance,
          });
        }
      }

      return results;
    },

    getEmbeddingDimension() {
      const val = stmts.getMeta.get("embedding_dimension") as { value: string } | undefined;
      return val ? Number(val.value) : undefined;
    },

    getPatternCount() {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM patterns").get() as {
        cnt: number | bigint;
      };
      return Number(row.cnt);
    },

    getMeta(key: string) {
      const row = stmts.getMeta.get(key) as { value: string } | undefined;
      return row?.value;
    },

    setMeta(key: string, value: string) {
      stmts.setMeta.run(key, value);
    },

    close() {
      try {
        db.close();
      } catch {
        // already closed or errored
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export type SeedEmbedder = (texts: string[]) => Promise<number[][]>;

/**
 * Populate the store with seed patterns if it hasn't been seeded yet.
 * Returns the number of patterns inserted.
 */
export async function seedConsentPatternStore(params: {
  store: ConsentPatternStore;
  seedData: ReadonlyArray<{ text: string; effects: readonly EffectClass[] }>;
  embedder: SeedEmbedder;
}): Promise<number> {
  const { store, seedData, embedder } = params;

  const seeded = store.getMeta("seeded");
  if (seeded === "true") {
    return 0;
  }

  const texts = seedData.map((entry) => entry.text);
  const embeddings = await embedder(texts);

  let inserted = 0;
  for (let i = 0; i < seedData.length; i++) {
    const entry = seedData[i];
    const embedding = embeddings[i];
    if (!embedding) {
      log.warn(`seed embedder returned no embedding for pattern ${i}: "${entry.text}"`);
      continue;
    }

    try {
      store.upsertPattern({
        text: entry.text,
        effects: [...entry.effects],
        source: "seed",
        confidence: 1.0,
        embedding: new Float32Array(embedding),
      });
      inserted++;
    } catch (err) {
      log.warn(`failed to seed pattern "${entry.text}": ${String(err)}`);
    }
  }

  store.setMeta("seeded", "true");
  log.debug(`consent pattern store seeded with ${inserted} patterns`);
  return inserted;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Build the consent store path from an explicit state directory.
 */
export function resolveConsentStorePath(stateDir: string): string {
  return `${stateDir}/consent/consent-patterns.sqlite`;
}

/**
 * Resolve the consent store path using the standard state dir.
 * Async to avoid eagerly loading the config module at import time.
 */
export async function resolveDefaultConsentStorePath(): Promise<string> {
  const { resolveStateDir } = await import("../config/paths.js");
  const stateDir = resolveStateDir();
  return resolveConsentStorePath(stateDir);
}
