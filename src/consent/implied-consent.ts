/**
 * Implied Consent Derivation Orchestrator
 *
 * Determines the impliedEffects for a PurchaseOrder by combining:
 * 1. Vector similarity search against the consent pattern store
 * 2. Deterministic keyword heuristics
 *
 * Modes:
 * - "vector"    -- vector search only, heuristic fallback on failure
 * - "heuristic" -- keyword heuristic only, no vector search
 * - "both"      -- union of vector + heuristic results (default)
 *
 * Graceful degradation: vector failure -> heuristic -> default ["read","compose"]
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
} from "../plugins/memory-embedding-providers.js";
import { deriveEffectsFromHeuristic } from "./implied-consent-heuristic.js";
import { CONSENT_SEED_PATTERNS } from "./implied-consent-seed.js";
import {
  openConsentPatternStore,
  resolveDefaultConsentStorePath,
  seedConsentPatternStore,
  type ConsentPatternStore,
} from "./implied-consent-store.js";
import type { EffectClass } from "./types.js";

const log = createSubsystemLogger("consent/implied");

export type ImpliedConsentMode = "vector" | "heuristic" | "both";

export type ImpliedConsentConfig = {
  /** Embedding provider ID. Default: "auto" (uses memory search provider). */
  provider?: string;
  /** Embedding model override. */
  model?: string;
  /** Cosine distance threshold. Lower = stricter matching. Default: 0.35 */
  threshold?: number;
  /** Number of similar patterns to consider. Default: 5 */
  topK?: number;
  /** Derivation mode. Default: "both" */
  mode?: ImpliedConsentMode;
};

const DEFAULT_THRESHOLD = 0.35;
const DEFAULT_TOP_K = 5;
const DEFAULT_MODE: ImpliedConsentMode = "both";
const DEFAULT_EFFECTS: readonly EffectClass[] = ["read", "compose"];

// Singleton store handle -- opened once per process lifetime.
let _storePromise: Promise<ConsentPatternStore> | undefined;
let _storeSeeded = false;

export type DeriveImpliedEffectsParams = {
  requestText: string;
  /** Resolved config for consent.impliedEffects. */
  consentConfig?: ImpliedConsentConfig;
  /** State dir override (defaults to ~/.openclaw). */
  stateDir?: string;
  /** Injected embedding provider (for testing or pre-resolved provider). */
  embeddingProvider?: MemoryEmbeddingProvider;
  /** Injected store (for testing). */
  store?: ConsentPatternStore;
};

/**
 * Derive the impliedEffects for a request. This is the main entry point
 * called by initializeConsentForRun to replace the hardcoded default.
 */
export async function deriveImpliedEffects(
  params: DeriveImpliedEffectsParams,
): Promise<EffectClass[]> {
  const config = params.consentConfig ?? {};
  const mode = config.mode ?? DEFAULT_MODE;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const topK = config.topK ?? DEFAULT_TOP_K;

  if (mode === "heuristic") {
    return deriveEffectsFromHeuristic(params.requestText);
  }

  // Vector-based path (mode "vector" or "both")
  let vectorEffects: EffectClass[] | undefined;
  try {
    vectorEffects = await deriveVectorEffects({
      requestText: params.requestText,
      threshold,
      topK,
      consentConfig: config,
      stateDir: params.stateDir,
      embeddingProvider: params.embeddingProvider,
      store: params.store,
    });
  } catch (err) {
    log.warn(`vector consent derivation failed, using heuristic fallback: ${String(err)}`);
  }

  if (mode === "both") {
    const heuristicEffects = deriveEffectsFromHeuristic(params.requestText);
    if (vectorEffects) {
      return mergeEffects(vectorEffects, heuristicEffects);
    }
    return heuristicEffects;
  }

  // mode === "vector"
  if (vectorEffects && vectorEffects.length > 0) {
    return vectorEffects;
  }

  // Vector-only mode failed; fall back to heuristic as safety net
  log.debug("vector search returned no matches, falling back to heuristic");
  return deriveEffectsFromHeuristic(params.requestText);
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

async function deriveVectorEffects(params: {
  requestText: string;
  threshold: number;
  topK: number;
  consentConfig: ImpliedConsentConfig;
  stateDir?: string;
  embeddingProvider?: MemoryEmbeddingProvider;
  store?: ConsentPatternStore;
}): Promise<EffectClass[]> {
  const provider =
    params.embeddingProvider ?? (await resolveEmbeddingProvider(params.consentConfig));
  if (!provider) {
    throw new Error("no embedding provider available for consent derivation");
  }

  const store = params.store ?? (await getOrCreateStore(provider, params.stateDir));

  // Embed the request text
  const queryEmbedding = await provider.embedQuery(params.requestText);
  const queryVec = new Float32Array(queryEmbedding);

  // KNN search
  const results = store.searchSimilarPatterns(queryVec, params.topK, params.threshold);

  if (results.length === 0) {
    return [];
  }

  // Union all effects from patterns within the distance threshold
  const effectSet = new Set<EffectClass>();
  for (const result of results) {
    for (const effect of result.pattern.effects) {
      effectSet.add(effect);
    }
  }

  log.debug(
    `vector derived effects=[${[...effectSet].join(",")}] from ${results.length} matches ` +
      `(closest distance=${results[0]?.distance.toFixed(4)})`,
  );

  return [...effectSet];
}

// ---------------------------------------------------------------------------
// Embedding provider resolution
// ---------------------------------------------------------------------------

async function resolveEmbeddingProvider(
  config: ImpliedConsentConfig,
): Promise<MemoryEmbeddingProvider | undefined> {
  try {
    const { listMemoryEmbeddingProviders } =
      await import("../plugins/memory-embedding-providers.js");
    const adapters = listMemoryEmbeddingProviders();
    if (adapters.length === 0) {
      return undefined;
    }

    const targetId = config.provider ?? "auto";
    let adapter: MemoryEmbeddingProviderAdapter | undefined;

    if (targetId === "auto") {
      adapter = adapters
        .filter((a) => typeof a.autoSelectPriority === "number")
        .toSorted(
          (a, b) =>
            (a.autoSelectPriority ?? Number.MAX_SAFE_INTEGER) -
            (b.autoSelectPriority ?? Number.MAX_SAFE_INTEGER),
        )[0];
    } else {
      const { getMemoryEmbeddingProvider } =
        await import("../plugins/memory-embedding-providers.js");
      adapter = getMemoryEmbeddingProvider(targetId);
    }

    if (!adapter) {
      return undefined;
    }

    const { loadConfig } = await import("../config/config.js");
    const cfg = loadConfig();
    const model = config.model ?? adapter.defaultModel ?? "";
    const result = await adapter.create({ config: cfg, model });
    return result.provider ?? undefined;
  } catch (err) {
    log.debug(`failed to resolve embedding provider for consent: ${String(err)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

async function getOrCreateStore(
  provider: MemoryEmbeddingProvider,
  stateDir?: string,
): Promise<ConsentPatternStore> {
  if (!_storePromise) {
    _storePromise = initStore(provider, stateDir);
  }
  const store = await _storePromise;

  if (!_storeSeeded) {
    await ensureSeeded(store, provider);
    _storeSeeded = true;
  }

  return store;
}

async function initStore(
  provider: MemoryEmbeddingProvider,
  stateDir?: string,
): Promise<ConsentPatternStore> {
  const dbPath = stateDir
    ? `${stateDir}/consent/consent-patterns.sqlite`
    : await resolveDefaultConsentStorePath();

  // Determine dimension by embedding a probe string
  const probe = await provider.embedQuery("dimension probe");
  const dimension = probe.length;

  return openConsentPatternStore({ dbPath, embeddingDimension: dimension });
}

async function ensureSeeded(
  store: ConsentPatternStore,
  provider: MemoryEmbeddingProvider,
): Promise<void> {
  try {
    await seedConsentPatternStore({
      store,
      seedData: CONSENT_SEED_PATTERNS,
      embedder: (texts) => provider.embedBatch(texts),
    });
  } catch (err) {
    log.warn(`consent pattern store seeding failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Effect merging
// ---------------------------------------------------------------------------

function mergeEffects(...arrays: EffectClass[][]): EffectClass[] {
  const set = new Set<EffectClass>();
  for (const arr of arrays) {
    for (const effect of arr) {
      set.add(effect);
    }
  }
  if (set.size === 0) {
    return [...DEFAULT_EFFECTS];
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// Testing seam
// ---------------------------------------------------------------------------

export const __testing = {
  resetStore(): void {
    _storePromise = undefined;
    _storeSeeded = false;
  },
  get storeSeeded(): boolean {
    return _storeSeeded;
  },
  mergeEffects,
};
