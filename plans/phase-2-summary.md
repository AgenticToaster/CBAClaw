# CBA Phase 2 Implementation Summary

Token-optimized handoff for Phase 3 implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- CBA module: `src/consent/` (Phase 0-1 types/binder/scope-chain + Phase 2 integration)
- Phase 2 wires consent verification into the openclaw tool execution pipeline
- Tests: `npx vitest run src/consent/` — 126 passing (102 from Phase 0-1 + 24 new)

## Files Delivered (Phase 2)

### New Files

```
src/consent/
  integration.ts       # Pipeline integration: PO factory, WO init, enforcement, verification
  integration.test.ts  # 24 tests covering all integration surface
```

### Modified Files

```
src/consent/
  scope-chain.ts       # Added enterConsentScope() for surgical ALS binding
  index.ts             # Barrel updated with integration + enterConsentScope exports

src/agents/
  tools/common.ts      # Added effectProfile?: ToolEffectProfile to AnyAgentTool
  pi-tools.before-tool-call.ts  # CBA verification before tool execution
  pi-embedded-runner/run/attempt.ts  # PO/WO creation + scope binding at run start

src/plugins/
  types.ts             # Added effectProfile? to OpenClawPluginToolOptions
  tools.ts             # Propagates effectProfile from registry to resolved tools
  registry.ts          # Added effectProfile? to PluginToolRegistration
```

## integration.ts Surface

### Types

- **ConsentEnforcementMode**: `"log" | "warn" | "enforce"`
- **CreatePurchaseOrderParams**: `{ requestText, senderId, senderIsOwner, channel?, chatType?, sessionKey?, agentId?, impliedEffects? }`
- **ConsentRunContext**: `{ scopeState, po, wo, enforcement }`
- **ConsentVerificationOutcome**: `{ allowed: true } | { allowed: false, reason, result }`

### Functions

**`resolveConsentEnforcementMode(env?)`** → `ConsentEnforcementMode`

- Reads `CBA_ENFORCEMENT` env var, defaults to `"log"`

**`initializeSigningKey(env?)`** → `void`

- Reads `CBA_SIGNING_KEY` env var (base64), configures binder signing key
- Idempotent: only configures on first call
- Missing key: falls back to per-process random (dev mode)

**`createPurchaseOrder(params)`** → `PurchaseOrder`

- Builds PO from run context with `randomUUID` and `Date.now()`
- Default implied effects: `["read", "compose"]` (Phase 3a replaces with heuristic)

**`initializeConsentForRun(params)`** → `ConsentRunContext | undefined`

- Full init: signing key → PO → mintInitialWorkOrder → scope state
- Returns `undefined` on binder refusal (logged, non-fatal)
- Resolves enforcement mode from env

**`verifyToolConsent(toolName, toolEffectProfile?, enforcement?)`** → `ConsentVerificationOutcome`

- Reads active WO from AsyncLocalStorage
- No active scope → `{ allowed: true }` (consent not initialized)
- Falls back to effect registry when no profile provided
- Enforcement modes:
  - `"log"`: debug log, allow
  - `"warn"`: warn log, allow
  - `"enforce"`: block with structured reason + WOVerificationResult

### Testing Seam (`__testing`)

`signingKeyConfigured` (getter), `resetSigningKeyConfigured()`, `DEFAULT_IMPLIED_EFFECTS`

## scope-chain.ts Addition

**`enterConsentScope(state)`** → `void`

- Uses `AsyncLocalStorage.enterWith()` for binding without callback restructuring
- Scope persists for lifetime of current async context + all async descendants
- Used by `attempt.ts` where wrapping 1900+ lines in a callback is impractical

## attempt.ts Integration

Inserted after `resolveSessionAgentIds()` (line ~407), before tool creation:

```typescript
const consentCtx = initializeConsentForRun({
  requestText: params.prompt,
  senderId: params.senderId ?? "unknown",
  senderIsOwner: params.senderIsOwner ?? false,
  channel: params.messageChannel ?? params.messageProvider,
  sessionKey: sandboxSessionKey,
  agentId: sessionAgentId,
});
if (consentCtx) {
  enterConsentScope(consentCtx.scopeState);
}
```

Context flows through AsyncLocalStorage to all tool executions in the run.

## pi-tools.before-tool-call.ts Integration

Inside `wrapToolWithBeforeToolCallHook`, the wrapped `execute` function calls `verifyToolConsent` before the existing hook/loop-detection pipeline:

```typescript
const consentOutcome = verifyToolConsent(toolName, toolEffectProfile);
if (!consentOutcome.allowed) {
  throw new Error(consentOutcome.reason);
}
```

The tool's `effectProfile` (from `AnyAgentTool`) is captured at wrap time and passed to verification. Falls back to effect registry for tools without declared profiles.

## Plugin Effect Profile Flow

1. Plugin calls `api.registerTool(tool, { effectProfile: { effects: [...], trustTier: "..." } })`
2. `registry.ts` stores `effectProfile` on `PluginToolRegistration`
3. `resolvePluginTools` sets `tool.effectProfile = entry.effectProfile` on each resolved tool
4. `wrapToolWithBeforeToolCallHook` captures and passes to `verifyToolConsent`
5. Additive/optional: tools without profiles fall back to core effect registry

## AnyAgentTool Extension

```typescript
export type AnyAgentTool = AgentTool<any, unknown> & {
  ownerOnly?: boolean;
  displaySummary?: string;
  effectProfile?: ToolEffectProfile; // Phase 2
};
```

## Environment Variables

| Variable          | Purpose                                     | Default            |
| ----------------- | ------------------------------------------- | ------------------ |
| `CBA_SIGNING_KEY` | Base64 WO signing key (min 256-bit)         | Per-process random |
| `CBA_ENFORCEMENT` | Verification mode: `log`, `warn`, `enforce` | `log`              |

## Design Decisions

1. **`enterConsentScope` over callback wrapping**: attempt.ts is 1900+ lines; restructuring into a `withConsentScope` callback would be a massive diff. `enterWith` is the AsyncLocalStorage API designed for exactly this pattern.

2. **Verification in wrapper, not hook function**: WO verification lives in `wrapToolWithBeforeToolCallHook`'s execute wrapper (has access to `tool.effectProfile`), not in `runBeforeToolCallHook` (only has `toolName`). This runs before plugin hooks — no wasted work on blocked tools.

3. **Graceful degradation**: `initializeConsentForRun` returns `undefined` on failure; `verifyToolConsent` returns `allowed: true` when no scope is active. The system never blocks tools due to consent infrastructure failures.

4. **Default enforcement "log"**: Safe rollout. Production enables `"enforce"` via env var after validation.

5. **Default implied effects `["read", "compose"]`**: Conservative stub until Phase 3a's heuristic analyzer. Covers informational requests. Tools requiring persist/exec/disclose/etc. trigger verification failures (logged, not blocked in "log" mode).

6. **Import type for plugin types**: Used `import("../consent/types.js").ToolEffectProfile` inline type import in `plugins/types.ts` and `plugins/registry.ts` to avoid adding a top-level import to these high-traffic modules.

## What Phase 3 Must Do

### 3a. Implied Consent Derivation

- Create `src/consent/implied-consent.ts` with deterministic heuristics
- Replace `DEFAULT_IMPLIED_EFFECTS` in integration.ts with request text analysis
- Pattern: "write"/"edit" → add "persist", "send"/"email" → add "disclose", "run"/"execute" → add "exec", "delete" → add "irreversible", "search web" → add "network"
- Conservative: heuristics are a ceiling, not a floor

### 3b. Change Order Flow

- Create `src/consent/change-order.ts` for CO request/resolve
- Gateway protocol schemas in `src/gateway/protocol/schema/consent.ts`
- Generalize `ExecApprovalManager` into consent elicitation
- When `verifyToolConsent` returns `allowed: false`, orchestrator triggers CO instead of hard refusal
- On CO grant: `mintSuccessorWorkOrder` → `transitionWorkOrder` → retry tool

### 3c. Consent Record Persistence

- Create `src/consent/consent-store.ts`
- Store per-session at `~/.openclaw/agents/<agentId>/consent/`
- Records used by binder for anchor verification

### 3d. Revocation and Withdrawal

- Wire into `/cancel` and session reset flows
- Invalidate active WOs on revocation
