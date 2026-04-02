# CBA Phase 0-1 Implementation Summary

Token-optimized handoff for Phase 2 implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- All CBA code: `src/consent/` (new module, not yet wired into openclaw runtime)
- Upstream code: untouched — no openclaw source files modified
- Shared dep: `src/shared/global-singleton.ts` (`resolveGlobalSingleton<T>(key, create)`)
- Tests: `npx vitest run src/consent/` — 102 passing
- Conceptual doc: `plans/Consent_20Bound_20Agency.docx.pdf`
- Full plan: `plans/consent-bound_agency_sac_51bf982e.plan.md`

## Files Delivered

```
src/consent/
  types.ts            # All type definitions (Phase 0 + 1)
  effect-registry.ts  # Tool→EffectClass[] map (30+ tools)
  binder.ts           # Deterministic WO minter + JWS token system
  scope-chain.ts      # AsyncLocalStorage consent scope
  index.ts            # Barrel (public API surface)
  *.test.ts           # 3 test files, 102 tests
```

## Type System (types.ts)

### Effect Classes (closed union)

`read | compose | persist | disclose | audience-expand | irreversible | exec | network | elevated | physical`

Runtime array: `EFFECT_CLASSES`. Profile: `ToolEffectProfile { effects, trustTier?, description? }`. Tiers: `in-process | sandboxed | external`.

### Contract Artifacts

- **PurchaseOrder**: `{ id, requestText, senderId, senderIsOwner, channel?, chatType?, sessionKey?, agentId?, impliedEffects, timestamp }`
- **WorkOrder**: `{ id, predecessorId?, requestContextId, grantedEffects (readonly), constraints (readonly), stepRef?, consentAnchors (readonly), mintedAt, expiresAt?, immutable: true, token (JWS string) }`
- **ChangeOrder**: `{ id, currentWoId, requestContextId, requestedEffects, reason, effectDescription, status, createdAt, resolvedAt?, successorWoId? }`
- **WOConstraint**: discriminated union on `kind`: `time-bound { expiresAt }`, `audience { allowedTargets[] }`, `max-invocations { maxInvocations }`, `custom { label, payload }`
- **ConsentAnchor**: discriminated union on `kind`: `implied { poId }`, `explicit { consentRecordId }`, `eaa { eaaRecordId }`, `policy { policyId }`
- **ConsentRecord**: `{ id, poId, woId, effectClasses, decision, timestamp, expiresAt?, metadata? }`
- **EAARecord**: `{ id, poId, woId, triggerReason, outcome, recommendedEffects, recommendedConstraints, createdAt, reasoning? }`
- **EAAOutcome**: `proceed | request-consent | constrained-comply | emergency-act | refuse | escalate`

### Binder I/O

- **BinderMintInput**: `{ po, policies: StandingPolicyStub[], systemProhibitions }` — policies accepted but not enforced (Phase 5 stub)
- **BinderRequalifyInput**: `{ currentWO, po, stepEffectProfile, newAnchors, additionalEffects, policies, systemProhibitions, constraints? }`
- **BinderResult**: `{ ok: true, wo } | { ok: false, code: BinderRefusalCode, reason }`
- **BinderRefusalCode**: `system-prohibited | no-consent-anchor | invalid-consent-anchor | ceiling-exceeded | expired | integrity-violation`
- **WOVerificationResult**: `{ ok: true } | { ok: false, code, reason, missingEffects[] }`
- **WOVerificationFailureCode**: `effect-not-granted | wo-expired | constraint-violated | integrity-failed`
- **WOIntegrityResult**: `{ ok: true } | { ok: false, reason }`
- **WODecodeResult**: `{ ok: true, wo } | { ok: false, reason }`

### Scope State

- **ConsentScopeState**: `{ po, activeWO, woChain (readonly), consentRecords[], eaaRecords[] }`
- **StandingPolicyStub**: `{ id, policyClass, effectScope }` — minimal shape for binder interface forward compat

## Effect Registry (effect-registry.ts)

Map of 30+ core tool names → `{ effects, trustTier, description }`. Key mappings:

| Tool category          | Effects                      | Tier       |
| ---------------------- | ---------------------------- | ---------- |
| read, glob, grep, ls   | [read]                       | in-process |
| write, fs_write, edit  | [persist] or [read, persist] | in-process |
| exec, spawn, shell     | [exec, irreversible]         | in-process |
| web_search, web_fetch  | [network, read]              | external   |
| message, sessions_send | [disclose]                   | in-process |
| fs_delete              | [irreversible, persist]      | in-process |
| gateway                | [elevated]                   | in-process |
| nodes                  | [elevated, exec]             | external   |

Unknown tools get conservative default: `[read, compose, persist, network]` at `external` tier.

Exports: `getToolEffectProfile(name)`, `isToolInRegistry(name)`, `getAllRegisteredProfiles()`. All return defensive copies.

## Binder (binder.ts)

### Core Functions

**`mintInitialWorkOrder(input: BinderMintInput): BinderResult`**

- Grants = PO.impliedEffects minus systemProhibitions
- Adds default 30-min TTL (`DEFAULT_WO_TTL_MS = 1_800_000`)
- Attaches `{ kind: "implied", poId }` anchor
- Seals with JWS token + deep freeze

**`mintSuccessorWorkOrder(input: BinderRequalifyInput): BinderResult`**

- Verifies currentWO integrity first (returns `integrity-violation` on failure)
- Checks currentWO expiry
- Validates newAnchors are structurally valid
- Combined effects = currentWO.grantedEffects ∪ additionalEffects, minus systemProhibitions
- Ceiling check: intersect with stepEffectProfile.effects
- Carries forward all anchors from currentWO + newAnchors

**`verifyToolAgainstWO(toolName, toolProfile | undefined, activeWO): WOVerificationResult`**

- Order: integrity check → expiry → effect coverage → constraint checks
- Falls back to registry lookup when toolProfile is undefined
- `checkWOConstraints` currently enforces `time-bound` only; audience/count/custom deferred to runtime wrapper

**`verifyConsentAnchorAgainstRecords(anchor, neededEffects, consentRecords, eaaRecords)`**

- implied: always valid
- explicit: record must exist, decision === "granted", not expired, covers needed effects
- eaa: record must exist, outcome in {proceed, constrained-comply, emergency-act}
- policy: stub-accepted (Phase 5)

### JWS Token System

Header: `{"alg":"HS256","typ":"wo+jwt"}` (constant, pre-encoded).

**Signing key**: module-level `_signingKey: Buffer`, defaults to `randomBytes(32)` per process.

- `configureSigningKey(key: Buffer | string)`: sets shared key, min 256-bit, accepts base64 string
- Production: MUST call at startup with shared secret for cross-boundary verification

**Token lifecycle**:

- `sealWorkOrder(draft)` → `extractWOPayloadFields` → `deterministicStringify` → `createJwt` → `deepFreezeWorkOrder`
- `verifyWorkOrderIntegrity(wo)` → verify JWT signature + compare current WO payload against token payload (detects both forgery and in-memory tampering)
- `decodeWorkOrderToken(token)` → verify JWT + validate required fields structurally + reconstruct frozen WO

**Payload fields** (extracted by `extractWOPayloadFields`, excludes `token` and `immutable`):
`id, requestContextId, grantedEffects, constraints, consentAnchors, mintedAt` (always), `predecessorId, stepRef, expiresAt` (when defined).

**`deterministicStringify(value)`**: recursive JSON with sorted keys at every nesting level. Handles null, undefined (→"null"), primitives, arrays (order-preserving), objects (key-sorted). Critical for cross-boundary payload comparison.

**`deepFreezeWorkOrder(wo)`**: freezes WO + grantedEffects array + constraints array + each constraint + audience.allowedTargets + custom.payload (recursive via `deepFreezeObject`) + consentAnchors array + each anchor.

### Testing Seam (`__testing`)

```
setNow(fn), setGenerateId(fn), setSigningKey(key: Buffer),
restore(), sealWorkOrder(draft), extractWOPayloadFields(wo),
deterministicStringify(value), DEFAULT_WO_TTL_MS
```

## Scope Chain (scope-chain.ts)

Singleton `AsyncLocalStorage<ConsentScopeState>` via `resolveGlobalSingleton(Symbol.for("openclaw.consentScope"), ...)`.

**Lifecycle**: `withConsentScope(state, run)` → `getConsentScope()` / `requireConsentScope()` (throws if missing)

**Transition**: `transitionWorkOrder(successorWO)`:

- Verifies outgoing WO integrity (throws on failure — hard security boundary)
- Verifies incoming successor integrity (throws on failure)
- Appends outgoing to immutable `woChain`, sets `activeWO = successor`

**Mutations**: `addConsentRecord(record)`, `addEAARecord(record)` — push to scope arrays.

**Queries**: `getActiveWorkOrder()`, `getActivePurchaseOrder()`, `getWorkOrderChain()`, `getConsentRecords()`, `getEAARecords()` — all return undefined outside scope.

**Factory**: `createInitialConsentScopeState(po, initialWO)` → `{ po, activeWO, woChain: [], consentRecords: [], eaaRecords: [] }`

## Design Decisions and Considerations

1. **JWS over HMAC**: initial implementation used per-process HMAC. Redesigned to JWS Compact Serialization (HS256) for cross-boundary portability. Any JWT library in any language can verify the token given the shared key.

2. **Configurable signing key**: defaults to random per-process (dev mode). Production requires `configureSigningKey()` at startup. Phase 2 must wire this into startup config (env var or config path).

3. **Deep freeze as defense-in-depth**: WOs are frozen at mint time. JWT integrity check is the authoritative tamper detector; freeze prevents casual in-process mutation. Freeze covers nested structures (audience targets, custom payloads).

4. **Binder verifies its own inputs**: `mintSuccessorWorkOrder` verifies currentWO integrity before inheriting grants. This is independent of scope-chain checks — the binder trusts nothing.

5. **Fail-closed design**: `verifyToolAgainstWO` checks integrity before any grant logic. Missing token, bad signature, or payload mismatch = immediate rejection.

6. **`StandingPolicyStub`**: binder interface accepts `policies` for forward compatibility but does not enforce them. Phase 5 will replace the stub with full `StandingPolicy` type.

7. **Constraint enforcement split**: `time-bound` enforced by binder/verification. `audience`, `max-invocations`, `custom` require runtime context (tool args, invocation counter) — designed to be enforced by the tool execution wrapper in Phase 2.

8. **`BinderRefusalCode` "integrity-violation"**: replaces the originally-defined "constraint-violation" which was dead code. Now used by successor minting when currentWO fails integrity check.

9. **`decodeWorkOrderToken` structural validation**: payload fields are validated for presence and type before reconstruction. Guards against key-compromise or cross-version drift producing WOs with undefined required fields.

## What Phase 2 Must Do

Per plan section "Phase 2: Integration with Tool Execution Pipeline":

### 2a. WO Minting at Agent Run Start

- In `src/agents/pi-embedded-runner/run/attempt.ts`: after deriving request context, build a `PurchaseOrder` and call `mintInitialWorkOrder`
- Wrap the agent run in `withConsentScope(createInitialConsentScopeState(po, wo), ...)`
- Wire `configureSigningKey` into startup (from config or env var `CBA_SIGNING_KEY`)
- `impliedEffects` derivation is stubbed — Phase 3a builds the heuristic analyzer, Phase 2 can use a conservative default (e.g., `["read", "compose"]` for all requests)

### 2b. Before-Tool-Call WO Verification

- In `src/agents/pi-tools.before-tool-call.ts`: call `verifyToolAgainstWO(toolName, toolProfile, activeWO)`
- On `ok: true` → proceed
- On `effect-not-granted` → structured refusal to orchestrator (requalify, request CO, or refuse)
- On `integrity-failed` → hard stop
- On `wo-expired` / `constraint-violated` → refuse with specific reason
- Plan calls for configurable enforcement: `consent.enforcement: "log" | "warn" | "enforce"` — initial integration should log/warn, not hard-enforce

### 2c. Plugin Tool Effect Profile Registration

- Extend `OpenClawPluginToolOptions` in `src/plugins/types.ts` with optional `effectProfile: ToolEffectProfile`
- `resolvePluginTools` in `src/plugins/tools.ts` propagates to tool metadata
- This is additive/optional — tools without profiles fall back to registry or conservative default

### Key openclaw Files to Modify

- `src/agents/pi-embedded-runner/run/attempt.ts` — PO derivation + initial WO + scope wrapping
- `src/agents/pi-tools.before-tool-call.ts` — WO verification hook
- `src/plugins/types.ts` — `effectProfile` on tool options
- `src/plugins/tools.ts` — propagate effect profiles
- `src/agents/tools/common.ts` — `effectProfile` on `AnyAgentTool`

### Phase 2 Does NOT Need To

- Build implied-consent heuristics (Phase 3a)
- Build Change Order request/resolve flow (Phase 3b)
- Build EAA triggers or adjudication (Phase 4)
- Enforce standing policies (Phase 5)
- Enforce audience/count/custom constraints at tool execution time (can stub)
