# CBA Phase 3 Implementation Summary (3a Complete)

Token-optimized handoff for Phase 3b/3c/3d and Phase 4 implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- CBA module: `src/consent/` (Phase 0-1 types/binder/scope-chain + Phase 2 integration + Phase 3a implied consent)
- Phase 3a replaces the static `["read", "compose"]` default with vector-based + heuristic implied consent derivation
- Tests: `npx vitest run src/consent/` — 148 passing, 16 skipped (sqlite-vec not in test env)
- Prior summaries: `plans/phase-0-1-summary.md`, `plans/phase-2-summary.md`

## Files Delivered (Phase 3a)

### New Files

```
src/consent/
  implied-consent-seed.ts          # 95 curated canonical request patterns
  implied-consent-heuristic.ts     # 8 deterministic keyword/regex rules
  implied-consent-store.ts         # SQLite + sqlite-vec persistent pattern store
  implied-consent.ts               # Orchestrator: vector search + heuristic + fallback
  implied-consent-heuristic.test.ts  # 15 tests
  implied-consent-store.test.ts      # 13 tests (sqlite-vec guarded)
  implied-consent.test.ts            # 8 tests (sqlite-vec guarded)
```

### Modified Files

```
src/consent/
  integration.ts       # initializeConsentForRun now async, calls deriveImpliedEffects
  integration.test.ts  # Updated for async + added derivation fallback test
  index.ts             # Barrel updated with all Phase 3a exports

src/config/
  types.openclaw.ts    # Added ConsentConfig type with impliedEffects section
  zod-schema.ts        # Added consent.impliedEffects Zod validation

src/agents/
  pi-embedded-runner/run/attempt.ts  # Updated to await initializeConsentForRun

src/plugins/
  registry.ts          # Fixed registerTool opts type to use OpenClawPluginToolOptions

docs/.generated/
  config-baseline.json   # Regenerated for consent schema addition
  config-baseline.jsonl  # Regenerated for consent schema addition
```

## Architecture Overview

```
Request text
    │
    ▼
deriveImpliedEffects()  ◄── entry point (implied-consent.ts)
    │
    ├── mode: "heuristic" ──► deriveEffectsFromHeuristic() ──► EffectClass[]
    │
    ├── mode: "vector" ──► deriveVectorEffects() ──► EffectClass[]
    │                          │
    │                          ├── resolveEmbeddingProvider()
    │                          ├── getOrCreateStore() → singleton ConsentPatternStore
    │                          ├── provider.embedQuery(requestText) → Float32Array
    │                          └── store.searchSimilarPatterns(vec, topK, threshold)
    │
    └── mode: "both" (default) ──► union(vector, heuristic)

    Fallback chain: vector failure → heuristic → ["read", "compose"]
```

## implied-consent-seed.ts

95 curated canonical patterns organized by primary effect category:

| Category        | Count | Example                                      | Effects                        |
| --------------- | ----- | -------------------------------------------- | ------------------------------ |
| Read-only       | 15    | "Summarize this document"                    | [read, compose]                |
| File writing    | 12    | "Write a new file called utils.ts"           | [read, compose, persist]       |
| Communication   | 8     | "Send a message to the team channel"         | [disclose]                     |
| Shell execution | 10    | "Run this command in the terminal"           | [exec]                         |
| Deletion        | 8     | "Delete the temporary files"                 | [irreversible, persist]        |
| Network         | 8     | "Fetch the page at this URL"                 | [network, read]                |
| Elevated        | 6     | "Configure the gateway settings"             | [elevated]                     |
| Audience-expand | 4     | "Broadcast the announcement to all channels" | [audience-expand, disclose]    |
| Compound        | 11    | "Write a script and run it"                  | [read, compose, persist, exec] |

Exported as `CONSENT_SEED_PATTERNS: readonly ConsentSeedEntry[]`. Each entry: `{ text: string, effects: readonly EffectClass[] }`.

## implied-consent-heuristic.ts

8 keyword/regex rules with `\b` word boundaries and `/i` case-insensitive matching:

| Rule               | Pattern (abbreviated)                                          | Effects                  |
| ------------------ | -------------------------------------------------------------- | ------------------------ |
| Execution          | run, execute, exec, spawn, start, build, install, deploy, ...  | [exec]                   |
| File writing       | write, create, save, edit, update, modify, refactor, ...       | [read, compose, persist] |
| Deletion           | delete, remove, drop, wipe, purge, destroy, clean up, ...      | [irreversible]           |
| Communication      | send, email, message, notify, post, reply, slack, ...          | [disclose]               |
| Audience expansion | invite, add user/member, broadcast, publicly, everyone         | [audience-expand]        |
| Network            | search the web, fetch, download, curl, http, api call, ...     | [network, read]          |
| Elevated           | cron, schedule, gateway, admin, configure system, webhook, ... | [elevated]               |
| Physical           | turn on/off, actuate, motor, servo, gpio, hardware, ...        | [physical]               |

Default (no match): `["read", "compose"]`. When any rule matches, `read` and `compose` are always included.

Exported: `deriveEffectsFromHeuristic(requestText: string): EffectClass[]`.

## implied-consent-store.ts

### Database

Location: `~/.openclaw/consent/consent-patterns.sqlite` (700/600 perms).

PRAGMA: `journal_mode=WAL`, `foreign_keys=ON`.

### Schema

**`meta`** — key-value store for schema version and embedding dimension.

**`patterns`** — canonical request text patterns:

```
id INTEGER PRIMARY KEY AUTOINCREMENT
text TEXT NOT NULL (unique index)
effects TEXT NOT NULL (JSON array of EffectClass strings)
source TEXT NOT NULL DEFAULT 'seed' ('seed' | 'learned' | 'admin')
confidence REAL NOT NULL DEFAULT 1.0
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
```

**`pattern_embeddings`** — vec0 virtual table (sqlite-vec):

```
pattern_id INTEGER PRIMARY KEY
embedding float[<DIM>] distance_metric=cosine
```

Dimension is dynamic (determined at runtime from the embedding provider). Stored in meta as `embedding_dimension`. If the dimension changes, the vec0 table is dropped, rebuilt, and the `seeded` flag is reset so patterns are re-embedded.

### Public Types

- **ConsentPatternSource**: `"seed" | "learned" | "admin"`
- **ConsentPattern**: `{ id, text, effects, source, confidence, createdAt, updatedAt }`
- **PatternSearchResult**: `{ pattern, distance }`
- **ConsentPatternStore**: interface with all CRUD + search + meta + close methods
- **OpenStoreParams**: `{ dbPath, embeddingDimension, injectedDb?, skipVecExtension? }`

### Functions

**`openConsentPatternStore(params)`** → `Promise<ConsentPatternStore>`

- Creates/opens SQLite db, loads sqlite-vec extension, ensures schema, prepares statements
- `injectedDb` and `skipVecExtension` for testing

**`seedConsentPatternStore({ store, seedData, embedder })`** → `Promise<number>`

- Batch-embeds all seed texts via `embedder(texts: string[]): Promise<number[][]>`
- Upserts each pattern with its embedding
- Marks store as seeded (skips on subsequent calls)
- Returns count of inserted patterns

**`resolveConsentStorePath(stateDir)`** → `string`

- Deterministic: `${stateDir}/consent/consent-patterns.sqlite`

**`resolveDefaultConsentStorePath()`** → `Promise<string>`

- Async: imports `resolveStateDir` from config, then calls `resolveConsentStorePath`

### Store API Methods

| Method                  | Signature                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `insertPattern`         | `(params) → ConsentPattern` — validates embedding dimension                           |
| `upsertPattern`         | `(params) → ConsentPattern` — validates embedding dimension, updates existing by text |
| `getPatternById`        | `(id) → ConsentPattern \| undefined`                                                  |
| `getPatternByText`      | `(text) → ConsentPattern \| undefined`                                                |
| `getAllPatterns`        | `() → ConsentPattern[]`                                                               |
| `deletePattern`         | `(id) → boolean` — deletes embedding too                                              |
| `searchSimilarPatterns` | `(embedding, k, threshold) → PatternSearchResult[]`                                   |
| `getEmbeddingDimension` | `() → number \| undefined`                                                            |
| `getPatternCount`       | `() → number`                                                                         |
| `getMeta` / `setMeta`   | key-value metadata                                                                    |
| `close`                 | closes the db connection                                                              |

## implied-consent.ts (Orchestrator)

### Types

- **ImpliedConsentMode**: `"vector" | "heuristic" | "both"`
- **ImpliedConsentConfig**: `{ provider?, model?, threshold?, topK?, mode? }`
- **DeriveImpliedEffectsParams**: `{ requestText, consentConfig?, stateDir?, embeddingProvider?, store? }`

### Constants

| Constant          | Value               |
| ----------------- | ------------------- |
| DEFAULT_THRESHOLD | 0.35                |
| DEFAULT_TOP_K     | 5                   |
| DEFAULT_MODE      | "both"              |
| DEFAULT_EFFECTS   | ["read", "compose"] |

### Main Function

**`deriveImpliedEffects(params)`** → `Promise<EffectClass[]>`

1. If `mode === "heuristic"` → return `deriveEffectsFromHeuristic(requestText)` immediately
2. Otherwise attempt `deriveVectorEffects(...)`:
   - Resolve embedding provider (injected or via `listMemoryEmbeddingProviders()` auto-select)
   - Get/create singleton store (lazy init: probe dimension → open store → seed)
   - `provider.embedQuery(requestText)` → Float32Array
   - `store.searchSimilarPatterns(vec, topK, threshold)` → union all matched pattern effects
3. If `mode === "both"` → union vector results with heuristic results; on vector failure, heuristic only
4. If `mode === "vector"` → return vector results; on failure, fall back to heuristic as safety net

### Embedding Provider Resolution

`resolveEmbeddingProvider(config)`:

- Imports `listMemoryEmbeddingProviders()` dynamically
- `provider: "auto"` (default): selects adapter with lowest `autoSelectPriority`
- Explicit provider ID: uses `getMemoryEmbeddingProvider(id)`
- Calls `adapter.create({ config: loadConfig(), model })` → `result.provider`

### Store Lifecycle

Singleton per process:

- `_storePromise`: lazily created on first call, reused thereafter
- `_storeSeeded`: flag to avoid re-seeding
- `initStore()`: resolves db path → probe embedding dimension → `openConsentPatternStore()`
- `ensureSeeded()`: calls `seedConsentPatternStore()` with `CONSENT_SEED_PATTERNS` and `provider.embedBatch`

### Testing Seam (`__testing`)

`resetStore()` — clears `_storePromise` and `_storeSeeded`; `storeSeeded` (getter); `mergeEffects(...arrays)`

## integration.ts Changes

**`initializeConsentForRun`** is now `async`:

```typescript
export async function initializeConsentForRun(
  params: CreatePurchaseOrderParams & { env?: NodeJS.ProcessEnv },
): Promise<ConsentRunContext | undefined>;
```

When `params.impliedEffects` is not provided:

1. Dynamically imports `deriveImpliedEffects` from `./implied-consent.js`
2. Loads `consent.impliedEffects` config from the main config (if available)
3. Calls `deriveImpliedEffects({ requestText, stateDir, consentConfig })`
4. On any failure, falls back to `FALLBACK_IMPLIED_EFFECTS` (`["read", "compose"]`)

When `params.impliedEffects` IS provided, it is used directly (no derivation).

`DEFAULT_IMPLIED_EFFECTS` renamed to `FALLBACK_IMPLIED_EFFECTS` in testing seam.

## Configuration

### types.openclaw.ts

```typescript
export type ConsentConfig = {
  impliedEffects?: {
    provider?: string; // Embedding provider ID. Default: "auto"
    model?: string; // Embedding model override
    threshold?: number; // Cosine distance threshold. Default: 0.35
    topK?: number; // Number of similar patterns. Default: 5
    mode?: "vector" | "heuristic" | "both"; // Default: "both"
  };
};
```

Added as `consent?: ConsentConfig` on `OpenClawConfig`.

### zod-schema.ts

All fields validated:

- `threshold`: `z.number().min(0).max(2)`
- `topK`: `z.number().int().min(1)`
- `mode`: `z.union([z.literal("vector"), z.literal("heuristic"), z.literal("both")])`
- Entire `consent` and `impliedEffects` objects use `.strict()`

## Test Summary

| File                              | Tests | Skipped | Coverage                                                       |
| --------------------------------- | ----- | ------- | -------------------------------------------------------------- |
| implied-consent-heuristic.test.ts | 15    | 0       | All 8 rules, compounds, case, dedup, defaults                  |
| implied-consent-store.test.ts     | 13    | 11      | Schema, CRUD, vector search, threshold, dim validation, seed   |
| implied-consent.test.ts           | 8     | 5       | Vector derivation, both-mode merging, fallback, heuristic-only |
| integration.test.ts               | 17    | 0       | PO, enforcement, init (async), verify, e2e, fallback           |

Skipped tests are guarded with `describe.runIf(sqliteAvailable && vecAvailable)` — they require the sqlite-vec native extension, which is not present in the default test environment. They pass when sqlite-vec is available.

## Design Decisions

1. **Vector + heuristic dual path**: vector search gives semantic understanding of novel phrasings; heuristic gives deterministic, explainable, always-available baseline. "both" mode unions them for best coverage.

2. **sqlite-vec over separate vector DB**: single portable file, existing codebase dependency (memory-host-sdk already uses it), no additional service to manage.

3. **Singleton store per process**: consent pattern store is opened once and reused. Seeding happens once. Avoids per-request db open overhead.

4. **Dimension probing**: embedding dimension is determined at runtime by embedding a probe string, not hardcoded. Supports any embedding model transparently.

5. **Dimension change handling**: if the embedding provider changes (different model → different dimension), the vec0 table is dropped and rebuilt, and the seeded flag is reset so all patterns are re-embedded automatically.

6. **Lazy dynamic imports**: `implied-consent.js`, `config.js`, and `memory-embedding-providers.js` are all dynamically imported to avoid circular dependencies and keep the consent module tree-shakeable.

7. **Graceful degradation chain**: vector search failure → heuristic → static default. The system never blocks on consent infrastructure failures.

8. **Config passthrough**: `consent.impliedEffects` config keys are loaded from the main config inside `initializeConsentForRun` and passed to the orchestrator, so users can tune threshold/topK/mode/provider without code changes.

9. **Seed data as code**: the 95 seed patterns live in `implied-consent-seed.ts` as a typed constant, not in an external file. This ensures type safety, version control, and easy contribution.

10. **Conservative seed set**: seed patterns are intentionally broad and conservative. The binder's ceiling checks and system prohibitions catch over-granting downstream, so it's safer to derive more effects than fewer.

## What Remains in Phase 3

### 3b. Change Order (Explicit Consent) Flow

- Create `src/consent/change-order.ts` for CO request/resolve lifecycle
- Gateway protocol schemas in `src/gateway/protocol/schema/consent.ts`
- Generalize `ExecApprovalManager` into consent elicitation
- When `verifyToolConsent` returns `allowed: false` in enforce mode, the orchestrator triggers a CO instead of hard refusal
- On CO grant: `mintSuccessorWorkOrder` → `transitionWorkOrder` → retry tool
- On CO deny: agent must replan within current WO or refuse
- UI surface for consent approval (displays in effect terms)

### 3c. Consent Record Persistence

- Create `src/consent/consent-store.ts`
- Store per-session at `~/.openclaw/agents/<agentId>/consent/`
- Persist `ConsentRecord` and `EAARecord` for anchor verification and audit
- Records used by binder's `verifyConsentAnchorAgainstRecords` for explicit/eaa anchor validation

### 3d. Revocation and Withdrawal

- Wire into `/cancel` and session reset flows
- Invalidate active WOs on revocation
- Clear consent records on withdrawal
- Emit scope chain events for observability (Phase 6 forward compat)
