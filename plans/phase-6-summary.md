# CBA Phase 6 Implementation Summary

Token-optimized handoff for Phase 7 implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- CBA module: `src/consent/` (Phase 0-1 types/binder/scope-chain + Phase 2 integration + Phase 3 consent lifecycle + Phase 4 EAA + Phase 5 standing policies + Phase 6 observability)
- Tests: `npx vitest run src/consent/` — 643 passing, 16 skipped (sqlite-vec not in test env)
- Prior summaries: `plans/phase-0-1-summary.md`, `plans/phase-2-summary.md`, `plans/phase-3-summary.md`, `plans/phase-4-summary.md`, `plans/phase-5-summary.md`

## Files Delivered (Phase 6a + 6b + 6d)

### New Files

```
src/consent/
  events.ts              # Scope chain event model, event bus, 21 factory helpers (780 LOC)
  events.test.ts         # 34 tests
  receipts.ts            # Action receipts at 3 detail levels (537 LOC)
  receipts.test.ts       # 28 tests
  metrics.ts             # In-process counters, histograms, event bus auto-collection (402 LOC)
  metrics.test.ts        # 24 tests
```

### Modified Files

```
src/consent/
  index.ts               # Barrel updated with Phase 6a + 6b + 6d exports
```

## Phase 6a Architecture: Scope Chain Event Model

```
ConsentEventType (21 event types)
├── WO lifecycle
│     ├── wo.minted       (WO created with grants/constraints/anchors)
│     ├── wo.expired       (WO TTL exceeded)
│     └── wo.superseded    (WO replaced by successor, diff of added/removed effects)
├── CO lifecycle
│     ├── co.requested     (CO created for missing effects)
│     ├── co.granted       (CO approved, successor WO minted)
│     ├── co.denied        (CO rejected)
│     ├── co.expired       (CO TTL exceeded)
│     └── co.withdrawn     (CO withdrawn by agent)
├── EAA lifecycle
│     ├── eaa.started      (EAA adjudication begins with triggers)
│     └── eaa.completed    (EAA finishes with outcome + duration)
├── Effect execution
│     └── effect.executed  (tool invoked with success/failure)
├── Consent lifecycle
│     ├── consent.granted  (consent record created via CO/precedent/policy/implied)
│     ├── consent.revoked  (user-initiated revocation)
│     └── consent.withdrawn (agent-initiated withdrawal)
├── Policy lifecycle
│     ├── policy.applied   (policy used as consent anchor in WO)
│     ├── policy.escalated (policy escalation rule fired)
│     ├── policy.proposed  (self-minted policy proposed)
│     └── policy.confirmed (self-minted policy confirmed by user)
└── Breach lifecycle
      ├── breach.detected   (consent violation found)
      ├── breach.contained  (breach isolated)
      └── breach.remediated (breach resolved)
```

### events.ts

#### Exported Types

- **`ConsentEventType`**: union of 21 string literal event type discriminants
- **`ConsentEventBase`**: common fields: `id` (UUID), `type`, `timestamp` (epoch ms), `poId`, optional `agentId` and `sessionKey`
- **`ConsentEvent`**: discriminated union of all 21 specific event types
- **`ConsentEventListener`**: `(event: ConsentEvent) => void`
- **`TypedConsentEventListener<T>`**: `(event: Extract<ConsentEvent, { type: T }>) => void`

All 21 event payload types are individually exported:

| Event Type              | Payload Fields (beyond base)                                               |
| ----------------------- | -------------------------------------------------------------------------- |
| `WOMintedEvent`         | `woId`, `predecessorWoId?`, `grantedEffects`, `constraints`, `anchorKinds` |
| `WOExpiredEvent`        | `woId`, `grantedEffects`, `mintedAt`, `expiresAt`                          |
| `WOSupersededEvent`     | `predecessorWoId`, `successorWoId`, `addedEffects`, `removedEffects`       |
| `CORequestedEvent`      | `coId`, `woId`, `requestedEffects`, `toolName`, `effectDescription`        |
| `COGrantedEvent`        | `coId`, `grantedEffects`, `successorWoId`                                  |
| `CODeniedEvent`         | `coId`, `deniedEffects`                                                    |
| `COExpiredEvent`        | `coId`                                                                     |
| `COWithdrawnEvent`      | `coId`                                                                     |
| `EAAStartedEvent`       | `toolName`, `triggerCategories`, `severity`                                |
| `EAACompletedEvent`     | `eaaRecordId`, `outcome`, `toolName`, `durationMs`                         |
| `EffectExecutedEvent`   | `woId`, `toolName`, `effectClasses`, `success`                             |
| `ConsentGrantedEvent`   | `consentRecordId`, `effectClasses`, `source`                               |
| `ConsentRevokedEvent`   | `revokedEffects`, `revokedRecordCount`, `reason`                           |
| `ConsentWithdrawnEvent` | `withdrawalReason`, `affectedEffects`, `explanation`                       |
| `PolicyAppliedEvent`    | `policyId`, `policyClass`, `grantedEffects`, `woId`                        |
| `PolicyEscalatedEvent`  | `policyId`, `escalationAction`, `reason`                                   |
| `PolicyProposedEvent`   | `policyId`, `effectScope`, `rationale`                                     |
| `PolicyConfirmedEvent`  | `policyId`, `effectScope`                                                  |
| `BreachDetectedEvent`   | `woId`, `toolName`, `violationType`, `details`                             |
| `BreachContainedEvent`  | `breachEventId`, `containmentAction`                                       |
| `BreachRemediatedEvent` | `breachEventId`, `remediationAction`                                       |

#### Exported Functions

| Function                   | Signature                                | Description                          |
| -------------------------- | ---------------------------------------- | ------------------------------------ |
| `subscribeToConsentEvents` | `(listener) → () => void`                | Global listener, returns unsubscribe |
| `subscribeToEventType`     | `<T>(type, listener) → () => void`       | Typed listener for single event type |
| `emitConsentEvent`         | `(event: ConsentEvent) → void`           | Emit to global + typed listeners     |
| `buildEventBase`           | `(type, poId, opts?) → ConsentEventBase` | Build common event fields            |
| `emitWOMinted`             | `(params) → void`                        | Emit wo.minted                       |
| `emitWOExpired`            | `(params) → void`                        | Emit wo.expired                      |
| `emitWOSuperseded`         | `(params) → void`                        | Emit wo.superseded                   |
| `emitCORequested`          | `(params) → void`                        | Emit co.requested                    |
| `emitCOGranted`            | `(params) → void`                        | Emit co.granted                      |
| `emitCODenied`             | `(params) → void`                        | Emit co.denied                       |
| `emitCOExpired`            | `(params) → void`                        | Emit co.expired                      |
| `emitCOWithdrawn`          | `(params) → void`                        | Emit co.withdrawn                    |
| `emitEAAStarted`           | `(params) → void`                        | Emit eaa.started                     |
| `emitEAACompleted`         | `(params) → void`                        | Emit eaa.completed                   |
| `emitEffectExecuted`       | `(params) → void`                        | Emit effect.executed                 |
| `emitConsentGranted`       | `(params) → void`                        | Emit consent.granted                 |
| `emitConsentRevoked`       | `(params) → void`                        | Emit consent.revoked                 |
| `emitConsentWithdrawn`     | `(params) → void`                        | Emit consent.withdrawn               |
| `emitPolicyApplied`        | `(params) → void`                        | Emit policy.applied                  |
| `emitPolicyEscalated`      | `(params) → void`                        | Emit policy.escalated                |
| `emitPolicyProposed`       | `(params) → void`                        | Emit policy.proposed                 |
| `emitPolicyConfirmed`      | `(params) → void`                        | Emit policy.confirmed                |
| `emitBreachDetected`       | `(params) → void`                        | Emit breach.detected                 |
| `emitBreachContained`      | `(params) → void`                        | Emit breach.contained                |
| `emitBreachRemediated`     | `(params) → void`                        | Emit breach.remediated               |

### Event Bus Architecture

```
emitConsentEvent(event)
    │
    ├── 1. Iterate _globalListeners (Set<ConsentEventListener>)
    │       └── try { listener(event) } catch { log.debug }
    │
    └── 2. Lookup _typedListeners (Map<ConsentEventType, Set>)
            └── If event.type has typed listeners:
                  └── try { listener(event) } catch { log.debug }
```

- Synchronous, in-process event delivery.
- Fail-safe: listener exceptions are caught and logged, never propagated.
- Decoupled from gateway broadcast — bridge by subscribing a forwarding listener.
- Module-level listener sets survive across consent scopes within a process.
- Testing seam: `__testing.clearAllListeners()` for test isolation.

## Phase 6b Architecture: Action Receipts

```
generateReceipt(params)
    │
    ├── 1. Collect effectsExercised from all actions (deduplicated)
    │
    ├── 2. Determine detail level (auto or override)
    │       │
    │       ├── "report" if: breachDetected || emergencyActUsed || eaaInvoked
    │       ├── "receipt" if: changeOrderResolved || policyApplied || hasHighRisk
    │       └── "confirmation" otherwise
    │
    ├── 3. Build consent chain from final WO anchors + consent records
    │
    └── 4. Assemble receipt at determined level
            │
            ├── confirmation: base only
            ├── receipt: base + changeOrders + policiesApplied
            └── report: base + changeOrders + policiesApplied
                         + eaaAdjudications + woChain + eventLog
                         + breachDetected + breachActions
```

### receipts.ts

#### Exported Types

- **`ReceiptDetailLevel`**: `"confirmation" | "receipt" | "report"`
- **`ActionReceiptBase`**: common fields (id, level, generatedAt, poId, finalWoId, agentId?, sessionKey?, actionsSummary, effectsExercised, consentChain, activeConstraints, errors)
- **`ConfirmationReceipt`**: `ActionReceiptBase & { level: "confirmation" }`
- **`ActionReceipt`**: `ActionReceiptBase & { level: "receipt", changeOrders, policiesApplied }`
- **`ActionReport`**: `ActionReceiptBase & { level: "report", changeOrders, policiesApplied, eaaAdjudications, woChain, eventLog, breachDetected, breachActions }`
- **`AnyReceipt`**: `ConfirmationReceipt | ActionReceipt | ActionReport`
- **`ActionSummaryEntry`**: `{ action, effects, success, outcome }`
- **`ConsentChainEntry`**: `{ kind, refId, coveredEffects }`
- **`ChangeOrderSummary`**: `{ coId, requestedEffects, status, resolvedAt? }`
- **`PolicySummary`**: `{ policyId, policyClass, effectScope }`
- **`EAAAdjudicationSummary`**: `{ eaaRecordId, outcome, triggerCategories, severity, toolName }`
- **`WOChainEntry`**: `{ woId, grantedEffects, mintedAt, anchorKinds }`
- **`ReceiptError`**: `{ source, message, isConsentViolation }`
- **`DetermineDetailLevelParams`**: `{ eaaInvoked, breachDetected, emergencyActUsed, changeOrderResolved, policyApplied, effectsExercised }`
- **`GenerateReceiptParams`**: full parameter set including optional `eaaAdjudications` override

#### Exported Functions

| Function               | Signature                        | Description                            |
| ---------------------- | -------------------------------- | -------------------------------------- |
| `determineDetailLevel` | `(params) → ReceiptDetailLevel`  | Auto-select receipt level from context |
| `generateReceipt`      | `(params) → AnyReceipt`          | Construct receipt at appropriate level |
| `formatReceiptAsText`  | `(receipt: AnyReceipt) → string` | Human-readable text representation     |

### High-Risk Effects (Receipt Level Escalation)

| Effect Class      | Escalates to "receipt" |
| ----------------- | ---------------------- |
| `irreversible`    | Yes                    |
| `elevated`        | Yes                    |
| `disclose`        | Yes                    |
| `audience-expand` | Yes                    |
| `exec`            | Yes                    |
| `physical`        | Yes                    |
| `read`            | No                     |
| `compose`         | No                     |
| `persist`         | No                     |
| `network`         | No                     |

### EAA Adjudication Summary Fallback

`GenerateReceiptParams` accepts an optional `eaaAdjudications: EAAAdjudicationSummary[]` field. When provided, these pre-built summaries take precedence over auto-building from `eaaRecords`. The fallback `buildEAASummaries` defaults `toolName` to `""` and `severity` to `0` because `EAARecord` lacks those fields. Callers with richer context (e.g., the orchestration layer) should pass pre-built summaries for complete reports.

## Phase 6d Architecture: Consent Flow Metrics

```
Metric Collection
├── Direct API
│     ├── incrementCounter(name, amount?)
│     ├── recordHistogramValue(name, value, bounds?)
│     ├── recordCOByEffect(effects, decision)
│     ├── recordEAAOutcome(outcome)
│     ├── recordVerificationFailure()
│     └── recordPolicyBypass()
│
├── Auto-Collection via Event Bus
│     └── startMetricsCollection()
│           └── subscribes metricsEventHandler to consent events
│                 └── maps each event type → appropriate counter/histogram
│
└── Snapshot
      └── getMetricsSnapshot() → MetricsSnapshot
            ├── counters: Record<string, number>
            ├── histograms: Record<string, {count, sum, min, max, mean, buckets}>
            ├── coByEffect: Record<EffectClass, {requested, granted, denied}>
            └── eaaOutcomes: Record<EAAOutcome, number>
```

### metrics.ts

#### Exported Types

- **`MetricCounter`**: `{ value, increment(amount?) }`
- **`MetricHistogram`**: `{ count, sum, min, max, mean, buckets, record(value) }`
- **`HistogramBucket`**: `{ le: number, count: number }`
- **`MetricsSnapshot`**: JSON-serializable point-in-time snapshot of all metrics

#### Exported Constants

| Constant       | Description                                   |
| -------------- | --------------------------------------------- |
| `METRIC_NAMES` | 25 well-known metric name strings (see below) |

#### Well-Known Metrics

| Metric Name                    | Type      | Collected From              |
| ------------------------------ | --------- | --------------------------- |
| `consent.wo.minted`            | Counter   | `wo.minted` event           |
| `consent.wo.expired`           | Counter   | `wo.expired` event          |
| `consent.wo.superseded`        | Counter   | `wo.superseded` event       |
| `consent.co.requested`         | Counter   | `co.requested` event        |
| `consent.co.granted`           | Counter   | `co.granted` event          |
| `consent.co.denied`            | Counter   | `co.denied` event           |
| `consent.co.expired`           | Counter   | `co.expired` event          |
| `consent.co.withdrawn`         | Counter   | `co.withdrawn` event        |
| `consent.eaa.started`          | Counter   | `eaa.started` event         |
| `consent.eaa.completed`        | Counter   | `eaa.completed` event       |
| `consent.eaa.duration_ms`      | Histogram | `eaa.completed` event       |
| `consent.effect.executed`      | Counter   | `effect.executed` (success) |
| `consent.effect.failed`        | Counter   | `effect.executed` (failure) |
| `consent.consent.granted`      | Counter   | `consent.granted` event     |
| `consent.consent.revoked`      | Counter   | `consent.revoked` event     |
| `consent.consent.withdrawn`    | Counter   | `consent.withdrawn` event   |
| `consent.policy.applied`       | Counter   | `policy.applied` event      |
| `consent.policy.escalated`     | Counter   | `policy.escalated` event    |
| `consent.policy.proposed`      | Counter   | `policy.proposed` event     |
| `consent.policy.confirmed`     | Counter   | `policy.confirmed` event    |
| `consent.verification.failure` | Counter   | Direct API                  |
| `consent.policy.bypass`        | Counter   | Direct API                  |
| `consent.breach.detected`      | Counter   | `breach.detected` event     |
| `consent.breach.contained`     | Counter   | `breach.contained` event    |
| `consent.breach.remediated`    | Counter   | `breach.remediated` event   |

#### EAA Duration Histogram Buckets (ms)

`[50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]`

#### Exported Functions

| Function                    | Signature                       | Description                            |
| --------------------------- | ------------------------------- | -------------------------------------- |
| `incrementCounter`          | `(name, amount?) → void`        | Increment a named counter              |
| `recordHistogramValue`      | `(name, value, bounds?) → void` | Record a value in a histogram          |
| `recordCOByEffect`          | `(effects, decision) → void`    | Track CO by effect class               |
| `recordEAAOutcome`          | `(outcome) → void`              | Track EAA outcome distribution         |
| `recordVerificationFailure` | `() → void`                     | Increment verification failure counter |
| `recordPolicyBypass`        | `() → void`                     | Increment policy bypass counter        |
| `getMetricsSnapshot`        | `() → MetricsSnapshot`          | Point-in-time JSON snapshot            |
| `startMetricsCollection`    | `() → () => void`               | Subscribe to event bus, return unsub   |
| `resetMetrics`              | `() → void`                     | Clear all metrics (testing only)       |

### Event-to-Metric Mapping

The `metricsEventHandler` maps all 21 event types to metric updates:

- `co.requested`: increments CO counter + `recordCOByEffect(requestedEffects, "requested")`
- `co.granted`: increments CO counter + `recordCOByEffect(grantedEffects, "granted")`
- `co.denied`: increments CO counter + `recordCOByEffect(deniedEffects, "denied")`
- `eaa.completed`: increments counter + `recordEAAOutcome(outcome)` + `recordHistogramValue(durationMs)`
- `effect.executed`: branches on `success` → `EFFECT_EXECUTED` or `EFFECT_FAILED`
- All other event types: increment the corresponding named counter

## Test Summary

| File             | Tests | Skipped | Coverage                                                                                                         |
| ---------------- | ----- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| events.test.ts   | 34    | 0       | Bus lifecycle, typed listeners, error isolation, buildEventBase, all 21 factory helpers                          |
| receipts.test.ts | 28    | 0       | Detail level determination, receipt generation (all 3 levels), formatting, consent chain, WO chain, EAA override |
| metrics.test.ts  | 24    | 0       | Counters, histograms, CO-by-effect, EAA outcomes, snapshot, reset, event bus auto-collection                     |

**Full consent test suite: 643 passing, 16 skipped** (skipped tests require sqlite-vec native extension).

## Design Decisions

### Phase 6a

1. **In-process event bus, not gateway broadcast**: the event model is a lightweight synchronous bus within the consent module, not tied to the gateway event broadcast system. This keeps the consent layer self-contained and testable. Callers bridge into the gateway (or any other transport) by subscribing a forwarding listener — the consent module does not depend on gateway infrastructure.

2. **Fail-safe emission**: listener exceptions are caught and logged at debug level, never propagated into the consent pipeline. A misbehaving observer cannot disrupt consent flow correctness.

3. **One factory per event type**: every event type has a dedicated `emit*` function that handles `buildEventBase` and type-safe payload construction. This eliminates manual event assembly errors and provides a grep-friendly API surface.

4. **Module-level listener registry**: listeners are stored in module-level `Set`/`Map` collections, not per-scope. This means a single metrics collector or audit logger can observe all consent scopes within a process. Per-scope filtering is done by listeners using the `poId`/`sessionKey` fields on each event.

5. **ConsentGrantedEvent source discrimination**: the `consent.granted` event carries a `source` field (`"change-order" | "precedent" | "policy" | "implied"`) to distinguish how consent was obtained, enabling metrics and audit to track the consent acquisition path.

### Phase 6b

6. **Three-level receipt model**: the confirmation/receipt/report levels map directly to operational risk tiers. Low-risk operations (read, compose under implied consent) get lightweight confirmations. Non-routine operations (explicit CO, policy bypass, high-risk effects) get standard receipts with CO and policy details. High-stakes operations (EAA, breach, emergency-act) get full reports with WO chain reconstruction, EAA adjudication details, and event logs.

7. **Auto-determination with override**: `determineDetailLevel` encodes a deterministic priority ladder (breach/emergency/EAA → report → CO/policy/high-risk → receipt → confirmation). Callers can override when they have context the auto-detection doesn't capture.

8. **EAA adjudication summary fallback**: `EAARecord` (from `types.ts`) lacks `toolName` and `severity` — it stores `triggerReason` as a semicolon-delimited string. The `buildEAASummaries` fallback defaults these to empty/zero. Callers with richer context (the orchestration layer, which has access to the full `EAAAdjudicationResult`) should pass pre-built `eaaAdjudications` for complete reports. This avoids enriching the core `EAARecord` type for audit-only data.

9. **Consent chain from WO anchors**: `buildConsentChain` reconstructs the consent provenance chain from the final WO's `consentAnchors` array, cross-referencing consent records for covered effects. This provides a compact audit trail without storing full WO token payloads in the receipt.

10. **Immutable receipts**: receipts are plain data objects generated once and not mutated afterward. The `id` and `generatedAt` fields anchor the receipt in time for durable audit storage.

### Phase 6d

11. **No external dependencies**: metrics are plain in-process counters and histograms with no Prometheus, StatsD, or OpenTelemetry dependency. `getMetricsSnapshot()` returns a JSON-serializable object that consumers bridge to their preferred observability backend.

12. **Monotonic counters with explicit reset**: counters only increase. The `resetMetrics()` function is marked as testing-only. This prevents accidental counter loss in production and makes snapshot deltas reliable.

13. **Dual recording path**: metrics can be populated via the direct API (`incrementCounter`, `recordCOByEffect`, etc.) or via the event bus auto-collector (`startMetricsCollection`). The direct API is for events not yet emitted through the event bus (e.g., `recordVerificationFailure`, `recordPolicyBypass`). The auto-collector handles the 21 event bus types.

14. **Per-effect CO tracking**: CO metrics are broken down by effect class, not just aggregate counts. This enables operators to identify which effect classes drive the most consent friction (e.g., "exec accounts for 60% of denied COs").

15. **Cumulative histogram buckets**: histogram buckets use cumulative counts (each bucket counts observations ≤ its bound). This follows the Prometheus histogram convention and enables percentile estimation from the snapshot.

16. **Safe re-subscription**: `startMetricsCollection` unsubscribes any previous listener before subscribing a new one. This prevents duplicate counting if the function is called multiple times (e.g., during hot-reload or re-initialization).

## Phase 6c: Gateway Protocol Extensions (Deferred)

Phase 6c (gateway protocol extensions for consent methods) was scoped in the plan but deferred from this implementation round. The event model, receipts, and metrics provide the in-process observability foundation. Gateway protocol integration (consent status queries, policy management, CO resolution via gateway) will build on the event bus subscription model — a forwarding listener bridges consent events into gateway broadcast, and gateway methods call the existing consent API functions.

## Phase 6 Sub-Phase Status

| Sub-Phase | Scope                       | Status    |
| --------- | --------------------------- | --------- |
| 6a        | Scope chain event model     | Completed |
| 6b        | Action receipts (3 levels)  | Completed |
| 6c        | Gateway protocol extensions | Deferred  |
| 6d        | Consent flow metrics        | Completed |

## What Remains

### Phase 6c: Gateway Protocol Extensions (Deferred)

- Gateway protocol schema additions: WO, CO, consent record, EAA record schemas in `src/gateway/protocol/schema/consent.ts`
- New gateway methods: `consent.wo.current`, `consent.chain.query`, `consent.co.request`, `consent.co.resolve`, `consent.revoke`
- Operator scope: `operator.consent` for consent management methods
- Event bus → gateway broadcast bridge listener

### Phase 7+ (Future)

- Breach containment + remediation protocol (`src/consent/remediation.ts`)
- WO chain visualization for debugging consent flows
- Consent dashboard / observability UI integration via metrics snapshot
- Standing policy management gateway methods
