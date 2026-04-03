# CBA Phase 3 Implementation Summary (Complete)

Token-optimized handoff for Phase 4 implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- CBA module: `src/consent/` (Phase 0-1 types/binder/scope-chain + Phase 2 integration + Phase 3 implied consent, change orders, consent records, revocation)
- Tests: `npx vitest run src/consent/` — 220 passing, 16 skipped (sqlite-vec not in test env)
- Prior summaries: `plans/phase-0-1-summary.md`, `plans/phase-2-summary.md`

## Files Delivered (Phase 3a — Implied Consent Derivation)

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

## Files Delivered (Phase 3b — Change Order Flow)

### New Files

```
src/consent/
  change-order.ts        # CO lifecycle: request, resolve, expire, withdraw, ambiguity detection (443 LOC)
  change-order.test.ts   # 28 tests
```

### Modified Files

```
src/consent/
  index.ts               # Barrel updated with Phase 3b exports
```

## Files Delivered (Phase 3c — Consent Record Persistence)

### New Files

```
src/consent/
  consent-store.ts       # Per-session SQLite store for ConsentRecord + EAARecord (611 LOC)
  consent-store.test.ts  # 25 tests
```

### Modified Files

```
src/consent/
  index.ts               # Barrel updated with Phase 3c exports
```

## Files Delivered (Phase 3d — Revocation and Withdrawal)

### New Files

```
src/consent/
  revocation.ts          # User revocation, agent withdrawal, session reset (366 LOC)
  revocation.test.ts     # 19 tests
```

### Modified Files

```
src/consent/
  index.ts               # Barrel updated with Phase 3d exports
```

## Phase 3a Architecture

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

## Phase 3b Architecture: Change Order Flow

```
verifyToolConsent() → "effect-not-granted"
    │
    ▼
requestChangeOrder()
    │
    ├── findPatternsForEffects()    ◄── reverse pattern lookup for description
    ├── generateEffectDescription() ◄── human-readable CO approval text
    ├── assessRequestAmbiguity()    ◄── vector distance ambiguity signal
    │
    ▼
ChangeOrder { id, status: "pending", requestedEffects, effectDescription }
    │
    ├── UI/gateway surface presents CO to user
    │
    ▼
resolveChangeOrder()
    │
    ├── decision: "denied"  → agent replans within current WO
    │
    └── decision: "granted"
         ├── addConsentRecord()  ◄── explicit consent anchor
         ├── verifyConsentAnchorAgainstRecords()
         ├── mintSuccessorWorkOrder()  ◄── WO' with expanded grants
         ├── transitionWorkOrder()  ◄── scope chain updated
         └── return successorWO for tool retry
```

### change-order.ts

#### Constants

| Constant                      | Value                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DEFAULT_AMBIGUITY_THRESHOLD` | 0.6                                                                                                       |
| `EFFECT_DESCRIPTIONS`         | Record<EffectClass, string> — human-readable per-effect descriptions                                      |
| `HIGH_RISK_EFFECTS`           | Set of 6 elevated-risk effect classes (irreversible, elevated, disclose, audience-expand, exec, physical) |

#### Exported Types

- **`AmbiguityAssessment`**: `{ ambiguous: boolean, bestDistance: number, matchCount: number }`
- **`RequestChangeOrderParams`**: `{ currentWO, po, missingEffects, toolName, toolEffectProfile?, reason, patternStore?, ambiguity? }`
- **`RequestChangeOrderResult`**: `{ ok: true, changeOrder } | { ok: false, reason }`
- **`ResolveChangeOrderParams`**: `{ changeOrderId, decision: "granted" | "denied", constraints?, consentExpiresInMs? }`
- **`ResolveChangeOrderResult`**: `{ ok: true, changeOrder, successorWO? } | { ok: false, reason }`

#### Exported Functions

| Function                    | Signature                                                     | Description                                                           |
| --------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `findPatternsForEffects`    | `(store, effects, limit?) → PatternSearchResult[]`            | Reverse lookup: find patterns whose effects overlap requested effects |
| `generateEffectDescription` | `(missingEffects, patternExamples?, ambiguityInfo?) → string` | Builds human-readable CO description without LLM                      |
| `assessRequestAmbiguity`    | `(params) → Promise<AmbiguityAssessment>`                     | Vector distance-based ambiguity detection                             |
| `requestChangeOrder`        | `(params) → RequestChangeOrderResult`                         | Creates pending CO with effect description                            |
| `resolveChangeOrder`        | `(params) → ResolveChangeOrderResult`                         | Resolves CO: grant mints successor WO, deny removes CO                |
| `getPendingChangeOrder`     | `(id) → ChangeOrder \| undefined`                             | Lookup pending CO by ID                                               |
| `getAllPendingChangeOrders` | `() → ChangeOrder[]`                                          | All pending COs                                                       |
| `expireChangeOrder`         | `(id) → boolean`                                              | Timeout expiry for stale COs                                          |
| `withdrawChangeOrder`       | `(id) → boolean`                                              | Agent-initiated CO cancellation                                       |

#### Testing Seam (`__testing`)

`clearPendingOrders()`, `pendingOrderCount`, `EFFECT_DESCRIPTIONS`, `HIGH_RISK_EFFECTS`, `DEFAULT_AMBIGUITY_THRESHOLD`

## Phase 3c Architecture: Consent Record Persistence

```
ConsentRecord / EAARecord
    │
    ▼
ConsentRecordStore (SQLite, per-session)
    │
    ├── insertConsentRecord() / insertEAARecord()
    ├── getConsentRecord() / getEAARecord()
    ├── getConsentRecordsByPO() / getConsentRecordsByDecision()
    ├── updateConsentDecision()  ◄── revocation updates
    ├── findConsentPrecedent()   ◄── exact effect-set match, non-expired
    ├── findSimilarConsentPrecedent()  ◄── vec0 embedding similarity
    ├── upsertConsentEmbedding()
    └── clearAll()  ◄── session reset
```

### consent-store.ts

#### Database

Location: `~/.openclaw/agents/<agentId>/consent/consent-records.sqlite` (700/600 perms).

PRAGMA: `journal_mode=WAL`, `foreign_keys=ON`.

#### Schema

**`meta`** — key-value store for schema version.

**`consent_records`**:

```
id TEXT PRIMARY KEY
po_id TEXT NOT NULL (indexed)
wo_id TEXT NOT NULL
effect_classes TEXT NOT NULL (JSON array of EffectClass)
decision TEXT NOT NULL (indexed) — "granted" | "denied" | "revoked"
timestamp INTEGER NOT NULL
expires_at INTEGER (nullable)
metadata TEXT (nullable, JSON)
```

**`eaa_records`**:

```
id TEXT PRIMARY KEY
po_id TEXT NOT NULL (indexed)
wo_id TEXT NOT NULL
trigger_reason TEXT NOT NULL
outcome TEXT NOT NULL
recommended_effects TEXT NOT NULL (JSON array)
recommended_constraints TEXT NOT NULL (JSON array)
created_at INTEGER NOT NULL
reasoning TEXT (nullable)
```

**`consent_embeddings`** — vec0 virtual table (optional, requires sqlite-vec):

```
record_id TEXT PRIMARY KEY
embedding float[<DIM>] distance_metric=cosine
```

#### Exported Types

- **`ConsentRecordStore`**: interface with all CRUD + precedent search + clear + close methods
- **`OpenConsentRecordStoreParams`**: `{ dbPath, embeddingDimension?, injectedDb?, skipVecExtension? }`

#### Exported Functions

| Function                               | Signature                                | Description                                           |
| -------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `openConsentRecordStore`               | `(params) → Promise<ConsentRecordStore>` | Opens/creates store, loads sqlite-vec, ensures schema |
| `resolveConsentRecordStorePath`        | `(stateDir, agentId) → string`           | Deterministic path resolution                         |
| `resolveDefaultConsentRecordStorePath` | `(agentId) → Promise<string>`            | Uses config's resolveStateDir                         |

#### Precedent Reuse

**Exact match** (`findConsentPrecedent`): queries granted records ordered by `timestamp DESC`, returns the first whose effect set is a superset of the requested effects and is not expired.

**Similarity search** (`findSimilarConsentPrecedent`): queries vec0 embeddings for the k-nearest consent record embeddings, filters by distance threshold + decision="granted" + non-expired + effect superset. Threshold default: 0.25.

## Phase 3d Architecture: Revocation and Withdrawal

```
User "/cancel" or session reset
    │
    ├── revokeConsent({ scope: "all" | "effects", effects? })
    │       ├── Mark matching granted records as "revoked" (in-memory + persistent store)
    │       ├── Add revocation audit ConsentRecord
    │       ├── Mint restricted WO (read-only baseline)
    │       │   └── systemProhibitions = revokedEffects \ {"read"}
    │       └── transitionWorkOrder(restrictedWO)
    │
    ├── resetConsentSession(persistentStore?)
    │       ├── Clear all in-memory consent + EAA records
    │       └── Clear persistent store if provided
    │
    └── Agent self-assessment
         │
         ▼
    withdrawCommitment({ withdrawalReason, explanation, affectedEffects? })
            ├── Add withdrawal audit ConsentRecord (metadata.source = "agent-withdrawal")
            ├── Compute remaining effects after withdrawal
            ├── Mint restricted WO preserving "read" as minimum
            │   └── systemProhibitions = affectedEffects \ {"read"}
            ├── transitionWorkOrder(restrictedWO)
            └── Return structured explanation to user
```

### revocation.ts

#### Exported Types

- **`RevocationScope`**: `"all" | "effects"`
- **`RevokeConsentParams`**: `{ scope, effects?, reason?, persistentStore? }`
- **`RevocationResult`**: `{ ok: true, restrictedWO, revokedRecordCount } | { ok: false, reason }`
- **`WithdrawalReason`**: `"constraint-change" | "duty-conflict" | "capability-insufficient" | "safety-concern" | "other"`
- **`WithdrawCommitmentParams`**: `{ withdrawalReason, explanation, affectedEffects?, persistentStore? }`
- **`WithdrawalResult`**: `{ ok: true, restrictedWO, explanation } | { ok: false, reason }`
- **`SessionResetResult`**: `{ clearedRecords, clearedEAARecords }`

#### Exported Functions

| Function              | Signature                                 | Description                                                      |
| --------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `revokeConsent`       | `(params) → RevocationResult`             | User revocation: invalidates WO, transitions to restricted scope |
| `withdrawCommitment`  | `(params) → WithdrawalResult`             | Agent withdrawal: narrows scope, explains to user                |
| `resetConsentSession` | `(persistentStore?) → SessionResetResult` | Clears all consent state for session                             |

#### Key Design: Read Baseline Preservation

Both `revokeConsent` and `withdrawCommitment` always preserve `"read"` as a minimum effect. When constructing `systemProhibitions`, `"read"` is filtered out so the agent can always communicate refusals. The restricted PO is minted with `impliedEffects: ["read"]` (revocation) or `impliedEffects: minimalEffects` (withdrawal, which always includes "read").

#### Withdrawal Descriptions

| Reason                    | Description                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| `constraint-change`       | Operating constraints have changed since the original commitment.             |
| `duty-conflict`           | Continuing would create a conflict between competing obligations.             |
| `capability-insufficient` | The agent lacks the capability or authorization to complete this work safely. |
| `safety-concern`          | Continuing poses a safety or integrity risk that cannot be mitigated.         |
| `other`                   | The agent is unable to continue with the current scope of work.               |

## Phase 3a Details (Reference)

### implied-consent-seed.ts

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

### implied-consent-heuristic.ts

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

### implied-consent-store.ts

Store API, schema, and functions documented in Phase 3a delivery above.

### implied-consent.ts (Orchestrator)

Mode/config/function details documented in Phase 3a delivery above.

### integration.ts Changes

`initializeConsentForRun` is now `async`. When `params.impliedEffects` is not provided, it dynamically imports `deriveImpliedEffects` and derives effects from the request text. On failure, falls back to `["read", "compose"]`.

## Test Summary (Full Phase 3)

| File                              | Tests | Skipped | Coverage                                                                 |
| --------------------------------- | ----- | ------- | ------------------------------------------------------------------------ |
| implied-consent-heuristic.test.ts | 15    | 0       | All 8 rules, compounds, case, dedup, defaults                            |
| implied-consent-store.test.ts     | 13    | 11      | Schema, CRUD, vector search, threshold, dim validation, seed             |
| implied-consent.test.ts           | 8     | 5       | Vector derivation, both-mode merging, fallback, heuristic-only           |
| integration.test.ts               | 17    | 0       | PO, enforcement, init (async), verify, e2e, fallback                     |
| change-order.test.ts              | 28    | 0       | CO creation, grant/deny, successor WO, expiry, ambiguity, pattern lookup |
| consent-store.test.ts             | 25    | 0       | CRUD, round-trip, precedent matching, expiry filtering, clear            |
| revocation.test.ts                | 19    | 0       | Revoke all/targeted, withdrawal reasons, session reset, persistent store |

**Total: 220 passing, 16 skipped** (skipped tests require sqlite-vec native extension).

## Design Decisions (Phase 3b/3c/3d)

1. **Module-level pending order map**: COs are tracked in a module-level `Map<string, ChangeOrder>`. Cleared per session. COs are keyed by UUID so concurrent requests don't collide.

2. **No LLM for CO descriptions**: Effect descriptions are built from static `EFFECT_DESCRIPTIONS` map + optional pattern store reverse lookup. This avoids adding inference latency to the consent elicitation path.

3. **Ambiguity as vector distance**: `assessRequestAmbiguity` uses the consent pattern store's similarity search. When the closest match exceeds the threshold (default 0.6), the request is flagged as ambiguous. This feeds into CO description enrichment and future EAA triggers (Phase 4).

4. **Per-session SQLite for consent records**: Each session gets its own database file under `~/.openclaw/agents/<agentId>/consent/`. This provides natural session isolation, easy cleanup on reset, and avoids cross-session data leakage.

5. **Precedent reuse avoids redundant COs**: Before triggering a CO, callers can check `findConsentPrecedent` (exact effect match) or `findSimilarConsentPrecedent` (embedding similarity). If a prior granted, non-expired record covers the needed effects, it can be reused as an implicit anchor.

6. **Read baseline preservation**: Revocation and withdrawal always preserve `"read"` as a minimum effect. The agent must always be able to communicate refusals or explain its state, even when all other effects are revoked.

7. **Dual revocation model**: User revocation (`revokeConsent`) invalidates from the requestor side. Agent withdrawal (`withdrawCommitment`) narrows scope from the agent side with categorized reasons and structured explanations. Both produce auditable consent records.

8. **Persistent store is optional**: All revocation/withdrawal functions accept `persistentStore?`. In-memory scope records are always updated; persistent writes are best-effort. This keeps the revocation path non-blocking even if the store is unavailable.

9. **Session reset preserves WO**: `resetConsentSession` clears consent and EAA records but leaves the active WO in place (it expires via TTL). Future tool calls must re-acquire consent through new COs.

## What Remains

### Phase 4: Elevated Action Analysis (EAA)

- EAA trigger detection from ambiguity signal and high-risk effect combinations
- LLM-based analysis of elevated actions with structured reasoning
- EAA outcome integration into binder (approve/modify/refuse recommendations)
- EAA record creation and persistence through consent store
- Constraint recommendation from EAA outcomes

### Phase 5: Standing Policy Framework

- Policy definition, storage, and lifecycle
- Policy evaluation during WO minting
- Policy-based automatic consent anchors
- Policy conflict resolution

### Phase 6: Observability and Audit

- Scope chain event emission
- Consent decision audit log
- WO chain visualization
- Consent flow metrics
