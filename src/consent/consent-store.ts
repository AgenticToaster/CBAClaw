/**
 * Consent Record Persistence Store
 *
 * Persists consent records and EAA records per-session for:
 * - Binder anchor verification (explicit/eaa anchors reference stored records)
 * - Audit and explainability (full consent history per session)
 * - Consent precedent reuse via embedding similarity search (3c-vec)
 *
 * Storage: SQLite at ~/.openclaw/agents/<agentId>/consent/consent-records.sqlite
 * Each session gets its own database for isolation and easy cleanup.
 *
 * Precedent reuse: when a CO would be triggered, first check if a prior
 * consent record in the same session covers semantically equivalent operations
 * (same effect classes, similar request context, within expiry). If so, reuse
 * it as an implicit consent anchor instead of re-prompting the user.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ConsentRecord, EAARecord, EffectClass, EAAOutcome } from "./types.js";

const log = createSubsystemLogger("consent/store");

const SCHEMA_VERSION = "1";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConsentRecordStore = {
  /** Insert a new consent record. */
  insertConsentRecord(record: ConsentRecord): void;

  /** Get a consent record by ID. */
  getConsentRecord(id: string): ConsentRecord | undefined;

  /** Get all consent records for a PO. */
  getConsentRecordsByPO(poId: string): ConsentRecord[];

  /** Get all consent records with a given decision. */
  getConsentRecordsByDecision(decision: string): ConsentRecord[];

  /** Get all consent records. */
  getAllConsentRecords(): ConsentRecord[];

  /** Update the decision of a consent record (e.g., revoke). */
  updateConsentDecision(id: string, decision: string, timestamp?: number): boolean;

  /** Insert a new EAA record. */
  insertEAARecord(record: EAARecord): void;

  /** Get an EAA record by ID. */
  getEAARecord(id: string): EAARecord | undefined;

  /** Get all EAA records. */
  getAllEAARecords(): EAARecord[];

  /**
   * Find a prior consent precedent that covers the given effects.
   * Uses exact effect-set matching. Returns the most recent matching
   * granted, non-expired record. Session isolation is implicit since
   * each session uses its own SQLite database file.
   */
  findConsentPrecedent(params: { effects: EffectClass[] }): ConsentRecord | undefined;

  /**
   * Find similar consent precedents using embedding similarity search.
   * Requires the optional embeddings table to be populated.
   * Returns the closest matching granted, non-expired record whose
   * effects are a superset of the requested effects and whose distance
   * is below the threshold.
   */
  findSimilarConsentPrecedent(params: {
    embedding: Float32Array;
    effects: EffectClass[];
    threshold?: number;
  }): ConsentRecord | undefined;

  /** Insert or update an embedding for a consent record. */
  upsertConsentEmbedding(recordId: string, embedding: Float32Array): void;

  /** Get total consent record count. */
  getConsentRecordCount(): number;

  /** Get total EAA record count. */
  getEAARecordCount(): number;

  /** Clear all records (used on session reset / revocation). */
  clearAll(): void;

  /** Close the database connection. */
  close(): void;

  /** Exposed for testing. */
  readonly db: DatabaseSync;
};

export type OpenConsentRecordStoreParams = {
  /** Full path to the SQLite database file. */
  dbPath: string;
  /** Embedding dimension for similarity search (optional; 0 to disable). */
  embeddingDimension?: number;
  /** Pre-opened DatabaseSync instance (for testing). */
  injectedDb?: DatabaseSync;
  /** Skip sqlite-vec loading (for testing or when embeddings not needed). */
  skipVecExtension?: boolean;
};

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type ConsentRecordRow = {
  id: string;
  po_id: string;
  wo_id: string;
  effect_classes: string;
  decision: string;
  timestamp: number | bigint;
  expires_at: number | bigint | null;
  metadata: string | null;
};

type EAARecordRow = {
  id: string;
  po_id: string;
  wo_id: string;
  trigger_reason: string;
  outcome: string;
  recommended_effects: string;
  recommended_constraints: string;
  created_at: number | bigint;
  reasoning: string | null;
};

type VecSearchRow = {
  record_id: string;
  distance: number;
};

function rowToConsentRecord(row: ConsentRecordRow): ConsentRecord {
  let effectClasses: EffectClass[];
  try {
    effectClasses = JSON.parse(row.effect_classes) as EffectClass[];
  } catch {
    effectClasses = [];
  }

  let metadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
  }

  return {
    id: row.id,
    poId: row.po_id,
    woId: row.wo_id,
    effectClasses,
    decision: row.decision as ConsentRecord["decision"],
    timestamp: Number(row.timestamp),
    expiresAt: row.expires_at != null ? Number(row.expires_at) : undefined,
    metadata,
  };
}

function rowToEAARecord(row: EAARecordRow): EAARecord {
  let recommendedEffects: EffectClass[];
  try {
    recommendedEffects = JSON.parse(row.recommended_effects) as EffectClass[];
  } catch {
    recommendedEffects = [];
  }

  let recommendedConstraints: EAARecord["recommendedConstraints"];
  try {
    recommendedConstraints = JSON.parse(row.recommended_constraints);
  } catch {
    recommendedConstraints = [];
  }

  return {
    id: row.id,
    poId: row.po_id,
    woId: row.wo_id,
    triggerReason: row.trigger_reason,
    outcome: row.outcome as EAAOutcome,
    recommendedEffects,
    recommendedConstraints,
    createdAt: Number(row.created_at),
    reasoning: row.reasoning ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function ensureSchema(db: DatabaseSync, embeddingDim: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS consent_records (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      wo_id TEXT NOT NULL,
      effect_classes TEXT NOT NULL,
      decision TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      expires_at INTEGER,
      metadata TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cr_po_id ON consent_records(po_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cr_decision ON consent_records(decision);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS eaa_records (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      wo_id TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      outcome TEXT NOT NULL,
      recommended_effects TEXT NOT NULL,
      recommended_constraints TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reasoning TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eaa_po_id ON eaa_records(po_id);`);

  if (embeddingDim > 0) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS consent_embeddings USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${embeddingDim}] distance_metric=cosine
        );
      `);
    } catch (err) {
      log.debug(`vec0 table creation skipped (embeddings disabled): ${String(err)}`);
    }
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

type PreparedStatements = {
  insertConsentRecord: StatementSync;
  selectConsentRecordById: StatementSync;
  selectConsentRecordsByPO: StatementSync;
  selectConsentRecordsByDecision: StatementSync;
  selectAllConsentRecords: StatementSync;
  updateConsentDecision: StatementSync;
  insertEAARecord: StatementSync;
  selectEAARecordById: StatementSync;
  selectAllEAARecords: StatementSync;
  countConsentRecords: StatementSync;
  countEAARecords: StatementSync;
  deleteAllConsentRecords: StatementSync;
  deleteAllEAARecords: StatementSync;
};

function prepareStatements(db: DatabaseSync): PreparedStatements {
  return {
    insertConsentRecord: db.prepare(`
      INSERT INTO consent_records (id, po_id, wo_id, effect_classes, decision, timestamp, expires_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectConsentRecordById: db.prepare("SELECT * FROM consent_records WHERE id = ?"),
    selectConsentRecordsByPO: db.prepare("SELECT * FROM consent_records WHERE po_id = ?"),
    selectConsentRecordsByDecision: db.prepare(
      "SELECT * FROM consent_records WHERE decision = ? ORDER BY timestamp DESC",
    ),
    selectAllConsentRecords: db.prepare("SELECT * FROM consent_records ORDER BY timestamp DESC"),
    updateConsentDecision: db.prepare(
      "UPDATE consent_records SET decision = ?, timestamp = ? WHERE id = ?",
    ),
    insertEAARecord: db.prepare(`
      INSERT INTO eaa_records (id, po_id, wo_id, trigger_reason, outcome, recommended_effects, recommended_constraints, created_at, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectEAARecordById: db.prepare("SELECT * FROM eaa_records WHERE id = ?"),
    selectAllEAARecords: db.prepare("SELECT * FROM eaa_records ORDER BY created_at DESC"),
    countConsentRecords: db.prepare("SELECT COUNT(*) as cnt FROM consent_records"),
    countEAARecords: db.prepare("SELECT COUNT(*) as cnt FROM eaa_records"),
    deleteAllConsentRecords: db.prepare("DELETE FROM consent_records"),
    deleteAllEAARecords: db.prepare("DELETE FROM eaa_records"),
  };
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

function createStoreApi(
  db: DatabaseSync,
  stmts: PreparedStatements,
  embeddingDim: number,
): ConsentRecordStore {
  // Optional vec search statement (only if embeddings table exists)
  let vecSearchStmt: StatementSync | undefined;
  if (embeddingDim > 0) {
    try {
      vecSearchStmt = db.prepare(`
        SELECT record_id, distance
        FROM consent_embeddings
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    } catch {
      // vec0 table not available
    }
  }

  return {
    get db() {
      return db;
    },

    insertConsentRecord(record: ConsentRecord): void {
      stmts.insertConsentRecord.run(
        record.id,
        record.poId,
        record.woId,
        JSON.stringify(record.effectClasses),
        record.decision,
        record.timestamp,
        record.expiresAt ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
      );
    },

    getConsentRecord(id: string): ConsentRecord | undefined {
      const row = stmts.selectConsentRecordById.get(id) as ConsentRecordRow | undefined;
      return row ? rowToConsentRecord(row) : undefined;
    },

    getConsentRecordsByPO(poId: string): ConsentRecord[] {
      const rows = stmts.selectConsentRecordsByPO.all(poId) as ConsentRecordRow[];
      return rows.map(rowToConsentRecord);
    },

    getConsentRecordsByDecision(decision: string): ConsentRecord[] {
      const rows = stmts.selectConsentRecordsByDecision.all(decision) as ConsentRecordRow[];
      return rows.map(rowToConsentRecord);
    },

    getAllConsentRecords(): ConsentRecord[] {
      const rows = stmts.selectAllConsentRecords.all() as ConsentRecordRow[];
      return rows.map(rowToConsentRecord);
    },

    updateConsentDecision(id: string, decision: string, timestamp?: number): boolean {
      const result = stmts.updateConsentDecision.run(decision, timestamp ?? Date.now(), id);
      return result.changes > 0;
    },

    insertEAARecord(record: EAARecord): void {
      stmts.insertEAARecord.run(
        record.id,
        record.poId,
        record.woId,
        record.triggerReason,
        record.outcome,
        JSON.stringify(record.recommendedEffects),
        JSON.stringify(record.recommendedConstraints),
        record.createdAt,
        record.reasoning ?? null,
      );
    },

    getEAARecord(id: string): EAARecord | undefined {
      const row = stmts.selectEAARecordById.get(id) as EAARecordRow | undefined;
      return row ? rowToEAARecord(row) : undefined;
    },

    getAllEAARecords(): EAARecord[] {
      const rows = stmts.selectAllEAARecords.all() as EAARecordRow[];
      return rows.map(rowToEAARecord);
    },

    findConsentPrecedent(params): ConsentRecord | undefined {
      const now = Date.now();

      const grantedRecords = this.getConsentRecordsByDecision("granted");

      // Find the most recent granted record whose effects are a superset
      for (const record of grantedRecords) {
        if (record.expiresAt && record.expiresAt < now) {
          continue;
        }
        const recordEffects = new Set(record.effectClasses);
        const allCovered = params.effects.every((e) => recordEffects.has(e));
        if (allCovered) {
          return record;
        }
      }

      return undefined;
    },

    findSimilarConsentPrecedent(params): ConsentRecord | undefined {
      if (!vecSearchStmt) {
        return undefined;
      }

      const threshold = params.threshold ?? 0.25;
      const now = Date.now();

      try {
        const rows = vecSearchStmt.all(params.embedding, 10) as VecSearchRow[];

        for (const row of rows) {
          if (row.distance > threshold) {
            continue;
          }

          const record = this.getConsentRecord(row.record_id);
          if (!record) {
            continue;
          }

          if (record.decision !== "granted") {
            continue;
          }

          if (record.expiresAt && record.expiresAt < now) {
            continue;
          }

          // Check that the record's effects cover all requested effects
          const recordEffects = new Set(record.effectClasses);
          const allCovered = params.effects.every((e) => recordEffects.has(e));
          if (allCovered) {
            log.debug(
              `consent precedent reuse: record=${record.id} distance=${row.distance.toFixed(4)} ` +
                `effects=[${record.effectClasses.join(",")}]`,
            );
            return record;
          }
        }
      } catch (err) {
        log.debug(`similarity precedent search failed: ${String(err)}`);
      }

      return undefined;
    },

    upsertConsentEmbedding(recordId: string, embedding: Float32Array): void {
      if (embeddingDim <= 0) {
        return;
      }
      if (embedding.length !== embeddingDim) {
        throw new Error(
          `Embedding dimension mismatch: expected ${embeddingDim}, got ${embedding.length}`,
        );
      }
      try {
        db.prepare("DELETE FROM consent_embeddings WHERE record_id = ?").run(recordId);
        db.prepare("INSERT INTO consent_embeddings (record_id, embedding) VALUES (?, ?)").run(
          recordId,
          embedding,
        );
      } catch (err) {
        log.debug(`failed to upsert consent embedding: ${String(err)}`);
      }
    },

    getConsentRecordCount(): number {
      const row = stmts.countConsentRecords.get() as { cnt: number | bigint };
      return Number(row.cnt);
    },

    getEAARecordCount(): number {
      const row = stmts.countEAARecords.get() as { cnt: number | bigint };
      return Number(row.cnt);
    },

    clearAll(): void {
      stmts.deleteAllConsentRecords.run();
      stmts.deleteAllEAARecords.run();
      if (embeddingDim > 0) {
        try {
          db.exec("DELETE FROM consent_embeddings");
        } catch {
          // vec table may not exist
        }
      }
    },

    close(): void {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Store Factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) a consent record store. Ensures schema, optionally
 * loads sqlite-vec for embedding-based precedent search.
 */
export async function openConsentRecordStore(
  params: OpenConsentRecordStoreParams,
): Promise<ConsentRecordStore> {
  const { dbPath } = params;
  const embeddingDim = params.embeddingDimension ?? 0;

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
      // Best-effort
    }
  }

  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  if (embeddingDim > 0 && !params.skipVecExtension) {
    try {
      const { loadSqliteVecExtension } =
        await import("../../packages/memory-host-sdk/src/host/sqlite-vec.js");
      const vecResult = await loadSqliteVecExtension({ db });
      if (!vecResult.ok) {
        log.debug(`sqlite-vec not available for consent store: ${vecResult.error}`);
      }
    } catch (err) {
      log.debug(`sqlite-vec loading failed for consent store: ${String(err)}`);
    }
  }

  ensureSchema(db, embeddingDim);

  const stmts = prepareStatements(db);
  return createStoreApi(db, stmts, embeddingDim);
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Build the consent record store path from an agent ID and state directory.
 */
export function resolveConsentRecordStorePath(stateDir: string, agentId: string): string {
  return `${stateDir}/agents/${agentId}/consent/consent-records.sqlite`;
}

/**
 * Resolve the consent record store path using the standard state dir.
 */
export async function resolveDefaultConsentRecordStorePath(agentId: string): Promise<string> {
  const { resolveStateDir } = await import("../config/paths.js");
  const stateDir = resolveStateDir();
  return resolveConsentRecordStorePath(stateDir, agentId);
}
