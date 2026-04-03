# CBA Phase 4 Implementation Summary (In Progress)

Token-optimized handoff for Phase 4c/4d implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- CBA module: `src/consent/` (Phase 0-1 types/binder/scope-chain + Phase 2 integration + Phase 3 consent lifecycle + Phase 4a EAA triggers + Phase 4b EAA adjudication)
- Tests: `npx vitest run src/consent/` — 330 passing, 16 skipped (sqlite-vec not in test env)
- Prior summaries: `plans/phase-0-1-summary.md`, `plans/phase-2-summary.md`, `plans/phase-3-summary.md`

## Files Delivered (Phase 4a + 4b)

### New Files

```
src/consent/
  eaa-triggers.ts          # 8 trigger detectors, DutyConstraint, evaluateEAATriggers (575 LOC)
  eaa-triggers.test.ts     # 55 tests
  eaa.ts                   # 6-step adjudication loop, runElevatedActionAnalysis (825 LOC)
  eaa.test.ts              # 58 tests
```

### Modified Files

```
src/consent/
  index.ts                 # Barrel updated with Phase 4a + 4b exports
```

## Phase 4a Architecture

```
verifyToolConsent() → "effect-not-granted"
    │
    ▼
evaluateEAATriggers({po, activeWO, toolName, toolProfile, ambiguity?, consentRecords, dutyConstraints?})
    │
    ├── detectStandingAmbiguity()      → standing-ambiguity
    ├── detectEffectAmbiguity()        → effect-ambiguity
    ├── detectDutyCollision()          → duty-collision
    ├── detectNoveltyUncertainty()     → novelty-uncertainty
    ├── detectDangerousTool()          → novelty-uncertainty
    ├── detectInsufficientEvidence()   → insufficient-evidence
    ├── detectIrreversibility()        → irreversibility
    └── detectEmergencyTimePressure()  → emergency-time-pressure
    │
    ▼
EAATriggerResult { triggered, categories[], severity (0–1), summary }
    │
    ├── not triggered → requestChangeOrder() (Phase 3b CO flow)
    │
    └── triggered → runElevatedActionAnalysis() (Phase 4b)
```

## Phase 4b Architecture

```
runElevatedActionAnalysis({po, activeWO, toolName, toolProfile, triggerResult,
                           consentRecords, eaaRecords, dutyConstraints, infer})
    │
    ├── Step 1: classifyAction()           → ActionClassification
    │     - ActionCategory: routine | sensitive | high-risk | emergency
    │     - AffectedParty[]: requestor, named-third-party, bystander, unknown
    │
    ├── Step 2: gatherDiscoveryContext()    → Record<string, unknown>
    │     - deterministic: PO metadata, tool profile, WO grants, prior EAA,
    │       granted consent (with expiry), active duties
    │
    ├── Step 3: infer() + validateEvaluation()  → EAAEvaluation
    │     - delegated to injected EAAInferenceFn
    │     - standing confidence (0–1), risk (likelihood, severity), duty analysis,
    │       confidence gating (overall, insufficient evidence areas)
    │     - structural validation: numeric bounds, severity enum
    │
    ├── Step 4: selectAlternatives()       → ActionAlternative[]
    │     - ranked by invasivenessScore (lower = less intrusive)
    │     - refuse (0), escalate (0.1), request-consent (0.2),
    │       constrained-comply (0.3+), emergency-act (0.9), proceed (0.3+)
    │     - hard gates: inviolable blocks proceed/constrained/request-consent
    │       (but NOT emergency-act), critical risk blocks constrained-comply,
    │       proceed requires confidence >= 0.7, risk <= minor, severity < 0.8
    │
    ├── Step 5: chooseOutcome()            → ActionAlternative
    │     Priority ladder:
    │       emergency-time-pressure + emergency-act available → emergency-act
    │       inviolable collision (non-emergency) → refuse
    │       confidence < 0.3 → request-consent (or refuse)
    │       confidence >= 0.7, risk ≤ minor → proceed
    │       moderate confidence → constrained-comply
    │       fallback → request-consent → refuse
    │
    └── Step 6: produceArtifacts()         → {adjudication, reasoning, eaaRecord}
          Three cross-referenced artifacts sharing the same ID:
          - EAAAdjudicationResult: bounded schema for binder
          - EAAReasoningRecord: full audit bundle
          - EAARecord: for consent store persistence
```

### eaa-triggers.ts

#### Constants

| Constant                       | Value                                                                       |
| ------------------------------ | --------------------------------------------------------------------------- |
| `HIGH_RISK_EFFECTS`            | Set of 6: irreversible, elevated, disclose, audience-expand, exec, physical |
| `AMBIGUITY_DISTANCE_THRESHOLD` | 0.6                                                                         |
| `BASE_SEVERITY`                | Record mapping each category to default severity (0.5–1.0)                  |
| `DANGEROUS_TOOL_NAMES`         | Set from `DEFAULT_GATEWAY_HTTP_TOOL_DENY` (13 tools)                        |
| `DANGEROUS_TOOL_SEVERITY`      | 0.8                                                                         |

#### Exported Types

- **`EAATriggerCategory`**: `"standing-ambiguity" | "effect-ambiguity" | "insufficient-evidence" | "duty-collision" | "emergency-time-pressure" | "novelty-uncertainty" | "irreversibility"`
- **`EAATriggerResult`**: `{ triggered: boolean, categories: EAATriggerCategory[], severity: number, summary: string }`
- **`DutyConstraint`**: `{ id, protects: DutyProtectionTarget, conflictingEffects: EffectClass[], criticality: DutyCriticality, description }`
- **`DutyProtectionTarget`**: `"evidence" | "confidentiality" | "safety" | "privacy" | "oversight"`
- **`DutyCriticality`**: `"advisory" | "strong" | "inviolable"`
- **`EvaluateEAATriggersParams`**: `{ po, activeWO, toolName, toolProfile, ambiguity?, consentRecords, dutyConstraints? }`

#### Exported Functions

| Function              | Signature                                                | Description                                                         |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `evaluateEAATriggers` | `(params: EvaluateEAATriggersParams) → EAATriggerResult` | Runs all 8 detectors, deduplicates categories, returns max severity |

#### Exported Constants

| Constant                   | Type                        | Description                                                                  |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `DEFAULT_DUTY_CONSTRAINTS` | `readonly DutyConstraint[]` | 5 core system duties (evidence, confidentiality, safety, privacy, oversight) |

### eaa.ts

#### Constants

| Constant                    | Value              |
| --------------------------- | ------------------ |
| `LOW_CONFIDENCE_THRESHOLD`  | 0.3                |
| `EMERGENCY_TTL_MS`          | 300000 (5 minutes) |
| `CONSTRAINED_COMPLY_TTL_MS` | 900000 (15 min)    |
| `HIGH_RISK_EFFECTS`         | Same 6 as Phase 4a |

#### Exported Types

- **`ActionClassification`**: `{ primaryEffects: EffectClass[], affectedParties: AffectedParty[], actionCategory: ActionCategory }`
- **`ActionCategory`**: `"routine" | "sensitive" | "high-risk" | "emergency"`
- **`AffectedParty`**: `{ role: "requestor" | "named-third-party" | "bystander" | "unknown", identifier?, affectedInterests: string[] }`
- **`EAAEvaluation`**: `{ standingAssessment: {confidence, concerns}, riskAssessment: {likelihood, severity, mitigating, aggravating}, dutyAnalysis: {applicableDuties, conflicts: DutyConflict[]}, confidenceGating: {overallConfidence, insufficientEvidenceAreas} }`
- **`RiskSeverity`**: `"negligible" | "minor" | "moderate" | "serious" | "critical"`
- **`DutyConflict`**: `{ duty, conflictsWith, resolution }`
- **`ActionAlternative`**: `{ description, outcomeType: EAAOutcome, effectClasses, constraints: WOConstraint[], invasivenessScore }`
- **`EAAAdjudicationResult`**: `{ outcome: EAAOutcome, recommendedEffects, recommendedConstraints, eaaRecordRef }`
- **`EAAReasoningRecord`**: `{ id, triggerCategories, triggerSeverity, classification, discoveryContext, evaluation, alternatives, selectedAlternative, justification, evidenceRefs, createdAt }`
- **`EAARunParams`**: `{ po, activeWO, toolName, toolProfile, triggerResult, consentRecords, eaaRecords, dutyConstraints, infer }`
- **`EAARunResult`**: `{ ok: true, adjudication, reasoning, eaaRecord } | { ok: false, reason, fallbackOutcome }`
- **`EAAInferenceFn`**: `(params: {classification, discoveryContext, triggerCategories, dutyConstraints}) → Promise<EAAEvaluation>`

#### Exported Functions

| Function                    | Signature                                        | Description                       |
| --------------------------- | ------------------------------------------------ | --------------------------------- |
| `runElevatedActionAnalysis` | `(params: EAARunParams) → Promise<EAARunResult>` | Full 6-step EAA adjudication loop |

#### Testing Seam (`__testing`)

`setNow(fn)`, `setGenerateId(fn)`, `restore()`, `LOW_CONFIDENCE_THRESHOLD`, `EMERGENCY_TTL_MS`, `CONSTRAINED_COMPLY_TTL_MS`, plus all step functions: `classifyAction`, `gatherDiscoveryContext`, `validateEvaluation`, `selectAlternatives`, `chooseOutcome`, `produceArtifacts`, `buildJustification`, `checkInviolableDutyCollision`, `computeInvasivenessScore`, `computeConstrainedEffects`, `computeMinimalEmergencyEffects`.

## Trigger Rules (Detail)

### 1. Standing Ambiguity (`detectStandingAmbiguity`)

- **Fires when**: `po.senderIsOwner === false`
- **Severity**: base 0.5, +0.15 for group/public `chatType`, +0.15 for high-risk effects. Capped at 1.0.
- **Reason format**: `"Standing ambiguity: requestor is not the agent owner; group/public channel context (group); high-risk effects involved"`

### 2. Effect Ambiguity (`detectEffectAmbiguity`)

- **Fires when**: `ambiguity.ambiguous === true` AND `ambiguity.bestDistance > 0.6` AND tool effects include any HIGH_RISK_EFFECTS.
- **Severity**: base 0.6, scaled up by `(bestDistance - 0.6) / 1.4 * 0.4`. Capped at 1.0.
- **Depends on**: Phase 3b `assessRequestAmbiguity` output.
- **Reason format**: `"Effect ambiguity: request underspecified (distance=0.850, matches=0) with high-risk effects [exec, irreversible]"`

### 3. Duty Collision (`detectDutyCollision`)

- **Fires when**: any `DutyConstraint.conflictingEffects` overlap with `toolProfile.effects`.
- **Defaults to**: `DEFAULT_DUTY_CONSTRAINTS` when `dutyConstraints` param is not provided.
- **Severity**: max criticality score among collisions (advisory=0.5, strong=0.7, inviolable=1.0).
- **Reason format**: `"Duty collision: confidentiality (strong): [disclose]; evidence (strong): [irreversible, persist]"`

### 4. Novelty/External Trust (`detectNoveltyUncertainty`)

- **Fires when**: `toolProfile.trustTier === "external"` AND effects include any of: disclose, irreversible, persist, exec, physical.
- **Severity**: 0.6 (base novelty-uncertainty).
- **Reason format**: `"Novelty/trust uncertainty: external tool with effects [disclose, persist]"`

### 5. Dangerous Tool (`detectDangerousTool`)

- **Fires when**: `toolName` is in `DANGEROUS_TOOL_NAMES` (sourced from `DEFAULT_GATEWAY_HTTP_TOOL_DENY`).
- **Category**: `novelty-uncertainty` (merged with trigger 4 in deduplication).
- **Severity**: 0.8.
- **Reason format**: `"Dangerous tool: \"exec\" is on the restricted tool list"`

### 6. Insufficient Evidence (`detectInsufficientEvidence`)

- **Fires when**: tool has HIGH_RISK_EFFECTS AND `consentRecords.length === 0` AND `ambiguity === undefined`.
- **Severity**: 0.5 (base insufficient-evidence).
- **Reason format**: `"Insufficient evidence: high-risk effects with no consent history and no ambiguity assessment available for risk judgment"`

### 7. Irreversibility (`detectIrreversibility`)

- **Fires when**: `toolProfile.effects` includes `"irreversible"` AND no prior granted, non-expired consent record covers the `"irreversible"` effect class.
- **Severity**: 0.7 (base irreversibility).
- **Uses**: testable `_now()` clock seam for deterministic expiry checks.
- **Reason format**: `"Irreversibility: action cannot be undone and no prior explicit consent covers irreversible effects"`

### 8. Emergency Time Pressure (`detectEmergencyTimePressure`)

- **Fires when**: `toolProfile.effects` includes `"physical"` AND `po.requestText` matches urgency regex (`/\b(emergency|urgent|immediately|asap|critical|danger|life.?threatening)\b/i`).
- **Severity**: 1.0 (always maximum).
- **Reason format**: `"Emergency time pressure: physical effects with time-critical context; requires immediate action with strict post-hoc accountability"`

## Outcome Selection Rules (Phase 4b)

### Outcome Priority Ladder (`chooseOutcome`)

1. **Emergency override**: if `emergency-time-pressure` trigger is active AND `emergency-act` is in alternatives → select `emergency-act`. This overrides even inviolable duty collisions.
2. **Inviolable refusal**: if inviolable duty collision exists (non-emergency) → `refuse`.
3. **Low confidence**: if `overallConfidence < 0.3` → `request-consent` (or `refuse` if unavailable).
4. **High confidence + low risk**: if `overallConfidence >= 0.7` AND severity is negligible/minor → `proceed`.
5. **Moderate path**: if `constrained-comply` is available → `constrained-comply`.
6. **Fallback**: `request-consent` → `refuse`.

### Alternative Generation Gates (`selectAlternatives`)

| Outcome              | Always available | Blocked by inviolable | Additional gates                                         |
| -------------------- | ---------------- | --------------------- | -------------------------------------------------------- |
| `refuse`             | Yes              | No                    | —                                                        |
| `escalate`           | Yes              | No                    | —                                                        |
| `request-consent`    | No               | Yes                   | —                                                        |
| `constrained-comply` | No               | Yes                   | confidence >= 0.3, risk != critical                      |
| `emergency-act`      | No               | **No**                | classification == emergency                              |
| `proceed`            | No               | Yes                   | confidence >= 0.7, risk <= minor, trigger severity < 0.8 |

### Failure Handling

| Condition                         | Behavior                               |
| --------------------------------- | -------------------------------------- |
| LLM inference throws              | `ok: false`, fallbackOutcome: `refuse` |
| Evaluation structurally invalid   | `ok: false`, fallbackOutcome: `refuse` |
| Low confidence (< 0.3)            | `request-consent` outcome              |
| Inviolable duty collision         | `refuse` (unless emergency)            |
| Emergency + inviolable            | `emergency-act` with 5-min time bound  |
| Serious risk + constrained-comply | Strips `irreversible` from effect set  |

## Default Duty Constraints

| ID                         | Protects        | Conflicting Effects          | Criticality |
| -------------------------- | --------------- | ---------------------------- | ----------- |
| duty-evidence-preservation | evidence        | irreversible, persist        | strong      |
| duty-confidentiality       | confidentiality | disclose, audience-expand    | strong      |
| duty-safety                | safety          | exec, physical, irreversible | inviolable  |
| duty-privacy               | privacy         | disclose, persist, network   | strong      |
| duty-oversight             | oversight       | elevated, exec               | strong      |

## Test Summary

| File                 | Tests | Skipped | Coverage                                                                    |
| -------------------- | ----- | ------- | --------------------------------------------------------------------------- |
| eaa-triggers.test.ts | 55    | 0       | All 8 detectors, composite evaluation, default duties, severity, edge cases |
| eaa.test.ts          | 58    | 0       | All 6 steps, outcome selection, failure handling, artifact integrity, e2e   |

**Full consent suite: 330 passing, 16 skipped** (skipped tests require sqlite-vec native extension).

## Design Decisions

### Phase 4a

1. **8 detectors, 7 categories**: Detectors 4 (novelty/external trust) and 5 (dangerous tool) both emit `novelty-uncertainty`. The evaluator deduplicates categories in the result. This keeps the trigger vocabulary compact while allowing independent detection logic.

2. **Dangerous tools from security module**: Rather than maintaining a separate dangerous-tools list, the trigger module imports `DEFAULT_GATEWAY_HTTP_TOOL_DENY` from `src/security/dangerous-tools.ts`. Single source of truth for tool risk classification.

3. **Duty collision uses default constraints when none provided**: Callers can pass custom `dutyConstraints` for testing or specialized scenarios. When omitted, the 5 default system duties apply. The safety duty is `inviolable` — it cannot be overridden even by explicit user consent.

4. **Severity is max, not sum**: The composite severity is the maximum across all fired triggers, not a weighted sum. This prevents artificial inflation when many low-risk triggers fire simultaneously, and ensures a single high-severity trigger (like emergency or inviolable duty collision) drives the EAA depth.

5. **Testable clock seam**: `detectIrreversibility` uses a module-level `_now()` function overridable via `__testing.setNow()`. This makes consent record expiry checks deterministic in tests. Other detectors don't use time-dependent logic so don't need the seam.

6. **`insufficient-evidence` as distinct category**: Rather than folding "no context" into effect-ambiguity, it's a separate trigger. The semantic distinction matters: effect-ambiguity means the request is unclear; insufficient-evidence means the request may be clear but the system lacks the operational history to judge risk. Phase 4b uses this distinction to select different EAA analysis depths.

7. **`activeWO` accepted but not read (Phase 4a)**: The `EvaluateEAATriggersParams` includes `activeWO` for interface stability with Phase 4b, which uses it in discovery context. Phase 4a detectors don't examine the WO directly.

8. **Emergency trigger requires physical + urgency**: Both conditions must be present. Physical effects alone don't trigger emergency mode. Urgency keywords alone don't trigger it for non-physical effects.

### Phase 4b

9. **Emergency overrides inviolable duty collision**: The plan states "If a duty collision is inviolable and _cannot be resolved_, EAA always returns refuse." Emergency-act IS a resolution — minimal action with strict time bounds and mandatory post-hoc accountability. The `chooseOutcome` priority ladder checks for emergency BEFORE checking for inviolable collision, and `selectAlternatives` does not gate `emergency-act` on `!hasInviolableDutyCollision`.

10. **Injected inference function**: The LLM evaluation step (Step 3) is a typed `EAAInferenceFn` injected by the caller. This keeps the EAA loop testable (mock inference in tests) and decoupled from any specific LLM provider. The caller is responsible for constructing the prompt, calling the model, and validating the response against a zod schema. The loop validates the result structurally as a defense-in-depth layer.

11. **Invasiveness scoring is a simplified heuristic**: The `computeInvasivenessScore` function uses effect risk weight (count of HIGH_RISK_EFFECTS \* 0.15) plus severity weight (negligible=0 to critical=1.0) with a base of 0.3. Duty violations and affected-party impact flow through the outcome selection logic, not the score.

12. **Three cross-referenced artifacts**: All three output artifacts (adjudication, reasoning, EAA record) share the same UUID. This enables the binder to verify the EAA anchor (by record ID), the audit system to retrieve full reasoning (by reasoning ID), and the consent store to persist the record (by EAA record ID) — all via a single reference.

13. **Evidence refs include tool profile**: `buildEvidenceRefs` emits `tool:<toolName>`, `consent:<recordId>`, and `duty:<constraintId>` as evidence pointers. This satisfies the plan's requirement for "consent record IDs, policy IDs, tool profiles consulted."

14. **Constrained-comply strips irreversible at serious risk**: When risk severity is "serious" and `constrained-comply` is selected, the recommended effect set drops `irreversible`. This implements the principle of least invasive sufficient action — if the effect is high-risk and the situation is serious, don't recommend it in the constrained path.

## What Remains

### Phase 4c: EAA Integration (`src/consent/eaa-integration.ts`)

- `handleConsentFailure`: orchestration wiring from `verifyToolConsent` failure path through precedent check → EAA trigger evaluation → EAA/CO routing.
- EAA-to-CO handoff for `request-consent` outcome.
- Binder anchor verification for EAA anchors.
- Successor WO minting from adjudication results.
- Persist EAARecord to consent store, add to scope chain, build ConsentAnchor of kind "eaa".

### Phase 4d: System Prompt Updates

- Effect awareness block in system prompt.
- Consent boundary recognition instructions.
- CO participation instructions.
- EAA slow-down awareness.
- Refusal-as-discretion framing.
