/**
 * Standing Policy Persistence Store (Phase 5b)
 *
 * Agent-global SQLite + sqlite-vec store for standing policies. Unlike consent
 * records (per-session), policies persist across sessions and represent the
 * agent's long-lived consent posture.
 *
 * Storage: ~/.openclaw/consent/policies.sqlite
 *
 * Three table groups:
 *   1. `policies` — relational metadata, JSON-serialized complex fields
 *   2. `policy_usage` — tracks per-WO usage for maxUses expiry
 *   3. `policy_embeddings` — vec0 virtual table for cosine KNN search
 *
 * Serialization note: EscalationCondition with kind:"custom" carries a
 * function-typed `evaluate` field that cannot be persisted. Custom conditions
 * are stripped on write and must be restored from the system policy registry
 * on read (system policies are the only source of custom conditions).
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  EscalationCondition,
  EscalationRule,
  PolicyApplicabilityPredicate,
  PolicyClass,
  PolicyExpiry,
  PolicyProvenance,
  PolicyRevocationSemantics,
  PolicyStatus,
  StandingPolicy,
} from "./policy.js";

const log = createSubsystemLogger("consent/policy-store");

const SCHEMA_VERSION = "1";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PolicyStore = {
  /** Insert a new policy. System policies are bulk-loaded at startup. */
  insertPolicy(policy: StandingPolicy): void;
  /** Get a policy by ID. */
  getPolicy(id: string): StandingPolicy | undefined;
  /** Get all active policies (status = "active"). */
  getActivePolicies(): StandingPolicy[];
  /** Get active policies filtered by class. */
  getActivePoliciesByClass(policyClass: PolicyClass): StandingPolicy[];
  /** Update policy status (activate, revoke, expire). */
  updatePolicyStatus(id: string, status: PolicyStatus, updatedAt?: number): boolean;
  /** Confirm a self-minted policy (sets confirmedAt and status = "active"). */
  confirmPolicy(id: string, confirmedAt?: number): boolean;
  /** Record a policy usage (for maxUses tracking). */
  recordPolicyUsage(policyId: string, woId: string): void;
  /** Get usage count for a policy. */
  getPolicyUsageCount(policyId: string): number;
  /** Expire policies that have exceeded their expiresAt or maxUses. */
  expireStalePolicies(now?: number): number;

  /** Store/update an embedding for a policy's composite description text. */
  upsertPolicyEmbedding(policyId: string, embedding: Float32Array): void;
  /** Delete embedding when a policy is revoked/expired. */
  deletePolicyEmbedding(policyId: string): void;
  /**
   * KNN similarity search against policy embeddings.
   * Returns candidates ordered by cosine distance, filtered by threshold.
   * Only returns policies with status in statusFilter (default: ["active"]).
   */
  findSimilarPolicies(params: {
    embedding: Float32Array;
    topK?: number;
    threshold?: number;
    statusFilter?: PolicyStatus[];
  }): Array<{ policy: StandingPolicy; distance: number }>;

  /** Remove all policies and usage records (for testing). */
  clearAll(): void;
  /** Close the database connection. */
  close(): void;
  /** Exposed for testing. */
  readonly db: DatabaseSync;
};

export type OpenPolicyStoreParams = {
  /** Full path to the SQLite database file. */
  dbPath: string;
  /** Embedding dimension for the vec0 virtual table. 0 or undefined = embeddings disabled. */
  embeddingDimension?: number;
  /** Pre-opened DatabaseSync instance (for testing). */
  injectedDb?: DatabaseSync;
  /** Skip sqlite-vec loading (for testing or when embeddings not needed). */
  skipVecExtension?: boolean;
};

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

type PolicyRow = {
  id: string;
  class: string;
  effect_scope: string;
  applicability: string;
  escalation_rules: string;
  expiry: string;
  revocation_semantics: string;
  provenance: string;
  description: string;
  status: string;
  created_at: number | bigint;
  updated_at: number | bigint;
};

type VecSearchRow = {
  policy_id: string;
  distance: number;
};

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Strip function-typed "custom" escalation conditions before persisting.
 * Custom conditions are runtime-only and must be restored from the system
 * policy registry on read.
 */
function serializeEscalationRules(rules: EscalationRule[]): string {
  const serializable = rules
    .filter((r) => r.condition.kind !== "custom")
    .map((r) => ({
      condition: r.condition,
      action: r.action,
      description: r.description,
    }));
  return JSON.stringify(serializable);
}

function deserializeEscalationRules(json: string): EscalationRule[] {
  try {
    const parsed = JSON.parse(json) as Array<{
      condition: EscalationCondition;
      action: "require-co" | "trigger-eaa" | "refuse";
      description: string;
    }>;
    return parsed.map((r) => ({
      condition: r.condition,
      action: r.action,
      description: r.description,
    }));
  } catch {
    return [];
  }
}

function rowToPolicy(row: PolicyRow): StandingPolicy {
  let effectScope: StandingPolicy["effectScope"];
  try {
    effectScope = JSON.parse(row.effect_scope);
  } catch {
    effectScope = [];
  }

  let applicability: PolicyApplicabilityPredicate;
  try {
    applicability = JSON.parse(row.applicability);
  } catch {
    applicability = {};
  }

  let expiry: PolicyExpiry;
  try {
    expiry = JSON.parse(row.expiry);
  } catch {
    expiry = { currentUses: 0 };
  }

  let provenance: PolicyProvenance;
  try {
    provenance = JSON.parse(row.provenance);
  } catch {
    provenance = { author: "unknown", createdAt: 0 };
  }

  return {
    id: row.id,
    class: row.class as PolicyClass,
    effectScope,
    applicability,
    escalationRules: deserializeEscalationRules(row.escalation_rules),
    expiry,
    revocationSemantics: row.revocation_semantics as PolicyRevocationSemantics,
    provenance,
    description: row.description,
    status: row.status as PolicyStatus,
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
    CREATE TABLE IF NOT EXISTS policies (
      id            TEXT PRIMARY KEY,
      class         TEXT NOT NULL CHECK(class IN ('user', 'self-minted', 'system')),
      effect_scope  TEXT NOT NULL,
      applicability TEXT NOT NULL,
      escalation_rules TEXT NOT NULL,
      expiry        TEXT NOT NULL,
      revocation_semantics TEXT NOT NULL CHECK(revocation_semantics IN ('immediate', 'after-current-slice')),
      provenance    TEXT NOT NULL,
      description   TEXT NOT NULL,
      status        TEXT NOT NULL CHECK(status IN ('active', 'pending-confirmation', 'revoked', 'expired')),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_status ON policies(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_class ON policies(class);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_usage (
      policy_id TEXT NOT NULL REFERENCES policies(id),
      wo_id     TEXT NOT NULL,
      used_at   INTEGER NOT NULL,
      PRIMARY KEY (policy_id, wo_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policy_usage_policy ON policy_usage(policy_id);`);

  if (embeddingDim > 0) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS policy_embeddings USING vec0(
          policy_id TEXT PRIMARY KEY,
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
  insertPolicy: StatementSync;
  selectPolicyById: StatementSync;
  selectActivePolicies: StatementSync;
  selectActivePoliciesByClass: StatementSync;
  updatePolicyStatus: StatementSync;
  insertPolicyUsage: StatementSync;
  countPolicyUsage: StatementSync;
  deleteAllPolicies: StatementSync;
  deleteAllUsage: StatementSync;
};

function prepareStatements(db: DatabaseSync): PreparedStatements {
  return {
    insertPolicy: db.prepare(`
      INSERT INTO policies (id, class, effect_scope, applicability, escalation_rules, expiry, revocation_semantics, provenance, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectPolicyById: db.prepare("SELECT * FROM policies WHERE id = ?"),
    selectActivePolicies: db.prepare(
      "SELECT * FROM policies WHERE status = 'active' ORDER BY created_at",
    ),
    selectActivePoliciesByClass: db.prepare(
      "SELECT * FROM policies WHERE status = 'active' AND class = ? ORDER BY created_at",
    ),
    updatePolicyStatus: db.prepare("UPDATE policies SET status = ?, updated_at = ? WHERE id = ?"),
    insertPolicyUsage: db.prepare(
      "INSERT OR IGNORE INTO policy_usage (policy_id, wo_id, used_at) VALUES (?, ?, ?)",
    ),
    countPolicyUsage: db.prepare("SELECT COUNT(*) as cnt FROM policy_usage WHERE policy_id = ?"),
    deleteAllPolicies: db.prepare("DELETE FROM policies"),
    deleteAllUsage: db.prepare("DELETE FROM policy_usage"),
  };
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

function createStoreApi(
  db: DatabaseSync,
  stmts: PreparedStatements,
  embeddingDim: number,
): PolicyStore {
  let vecSearchStmt: StatementSync | undefined;
  if (embeddingDim > 0) {
    try {
      vecSearchStmt = db.prepare(`
        SELECT policy_id, distance
        FROM policy_embeddings
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

    insertPolicy(policy: StandingPolicy): void {
      const now = Date.now();
      stmts.insertPolicy.run(
        policy.id,
        policy.class,
        JSON.stringify(policy.effectScope),
        JSON.stringify(policy.applicability),
        serializeEscalationRules(policy.escalationRules),
        JSON.stringify(policy.expiry),
        policy.revocationSemantics,
        JSON.stringify(policy.provenance),
        policy.description,
        policy.status,
        policy.provenance.createdAt ?? now,
        now,
      );
    },

    getPolicy(id: string): StandingPolicy | undefined {
      const row = stmts.selectPolicyById.get(id) as PolicyRow | undefined;
      if (!row) {
        return undefined;
      }
      const policy = rowToPolicy(row);
      // Hydrate currentUses from the usage table
      policy.expiry.currentUses = this.getPolicyUsageCount(id);
      return policy;
    },

    getActivePolicies(): StandingPolicy[] {
      const rows = stmts.selectActivePolicies.all() as PolicyRow[];
      return rows.map((row) => {
        const policy = rowToPolicy(row);
        policy.expiry.currentUses = this.getPolicyUsageCount(policy.id);
        return policy;
      });
    },

    getActivePoliciesByClass(policyClass: PolicyClass): StandingPolicy[] {
      const rows = stmts.selectActivePoliciesByClass.all(policyClass) as PolicyRow[];
      return rows.map((row) => {
        const policy = rowToPolicy(row);
        policy.expiry.currentUses = this.getPolicyUsageCount(policy.id);
        return policy;
      });
    },

    updatePolicyStatus(id: string, status: PolicyStatus, updatedAt?: number): boolean {
      const result = stmts.updatePolicyStatus.run(status, updatedAt ?? Date.now(), id);
      return result.changes > 0;
    },

    confirmPolicy(id: string, confirmedAt?: number): boolean {
      const row = stmts.selectPolicyById.get(id) as PolicyRow | undefined;
      if (!row) {
        return false;
      }

      const policy = rowToPolicy(row);
      if (policy.status !== "pending-confirmation") {
        return false;
      }

      const ts = confirmedAt ?? Date.now();
      policy.provenance.confirmedAt = ts;

      // Update both status and provenance (confirmedAt) in a single transaction
      db.exec("BEGIN");
      try {
        stmts.updatePolicyStatus.run("active", ts, id);
        db.prepare("UPDATE policies SET provenance = ? WHERE id = ?").run(
          JSON.stringify(policy.provenance),
          id,
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return true;
    },

    recordPolicyUsage(policyId: string, woId: string): void {
      stmts.insertPolicyUsage.run(policyId, woId, Date.now());
    },

    getPolicyUsageCount(policyId: string): number {
      const row = stmts.countPolicyUsage.get(policyId) as { cnt: number | bigint };
      return Number(row.cnt);
    },

    expireStalePolicies(now?: number): number {
      const ts = now ?? Date.now();
      let expiredCount = 0;

      const activePolicies = this.getActivePolicies();
      for (const policy of activePolicies) {
        let shouldExpire = false;

        if (policy.expiry.expiresAt !== undefined && ts >= policy.expiry.expiresAt) {
          shouldExpire = true;
        }

        if (
          policy.expiry.maxUses !== undefined &&
          policy.expiry.currentUses >= policy.expiry.maxUses
        ) {
          shouldExpire = true;
        }

        if (shouldExpire) {
          this.updatePolicyStatus(policy.id, "expired", ts);
          expiredCount++;
        }
      }

      return expiredCount;
    },

    // --- Embedding / Similarity ---

    upsertPolicyEmbedding(policyId: string, embedding: Float32Array): void {
      if (embeddingDim <= 0) {
        return;
      }
      if (embedding.length !== embeddingDim) {
        throw new Error(
          `Embedding dimension mismatch: expected ${embeddingDim}, got ${embedding.length}`,
        );
      }
      try {
        db.prepare("DELETE FROM policy_embeddings WHERE policy_id = ?").run(policyId);
        db.prepare("INSERT INTO policy_embeddings (policy_id, embedding) VALUES (?, ?)").run(
          policyId,
          embedding,
        );
      } catch (err) {
        log.debug(`failed to upsert policy embedding: ${String(err)}`);
      }
    },

    deletePolicyEmbedding(policyId: string): void {
      if (embeddingDim <= 0) {
        return;
      }
      try {
        db.prepare("DELETE FROM policy_embeddings WHERE policy_id = ?").run(policyId);
      } catch (err) {
        log.debug(`failed to delete policy embedding: ${String(err)}`);
      }
    },

    findSimilarPolicies(params): Array<{ policy: StandingPolicy; distance: number }> {
      if (!vecSearchStmt) {
        return [];
      }

      const topK = params.topK ?? 10;
      const threshold = params.threshold ?? 0.3;
      const statusFilter = new Set(params.statusFilter ?? ["active"]);

      const results: Array<{ policy: StandingPolicy; distance: number }> = [];

      try {
        const rows = vecSearchStmt.all(params.embedding, topK) as VecSearchRow[];

        for (const row of rows) {
          if (row.distance > threshold) {
            continue;
          }

          const policy = this.getPolicy(row.policy_id);
          if (!policy) {
            continue;
          }
          if (!statusFilter.has(policy.status)) {
            continue;
          }

          results.push({ policy, distance: row.distance });
        }
      } catch (err) {
        log.debug(`policy similarity search failed: ${String(err)}`);
      }

      return results;
    },

    clearAll(): void {
      stmts.deleteAllUsage.run();
      stmts.deleteAllPolicies.run();
      if (embeddingDim > 0) {
        try {
          db.exec("DELETE FROM policy_embeddings");
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
 * Open (or create) the policy store. Ensures schema, optionally loads
 * sqlite-vec for embedding-based semantic policy search.
 */
export async function openPolicyStore(params: OpenPolicyStoreParams): Promise<PolicyStore> {
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
        log.debug(`sqlite-vec not available for policy store: ${vecResult.error}`);
      }
    } catch (err) {
      log.debug(`sqlite-vec loading failed for policy store: ${String(err)}`);
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
 * Build the policy store path from an explicit state directory.
 * Agent-global (not per-session, not per-agent).
 */
export function resolvePolicyStorePath(stateDir: string): string {
  return `${stateDir}/consent/policies.sqlite`;
}

/**
 * Resolve the policy store path using the standard state dir.
 */
export async function resolveDefaultPolicyStorePath(): Promise<string> {
  const { resolveStateDir } = await import("../config/paths.js");
  const stateDir = resolveStateDir();
  return resolvePolicyStorePath(stateDir);
}
