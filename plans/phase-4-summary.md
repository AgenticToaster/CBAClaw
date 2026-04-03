# CBA Phase 4 Implementation Summary (In Progress)

Token-optimized handoff for Phase 4b/4c/4d implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- CBA module: `src/consent/` (Phase 0-1 types/binder/scope-chain + Phase 2 integration + Phase 3 consent lifecycle + Phase 4a EAA triggers)
- Tests: `npx vitest run src/consent/` — 275 passing, 16 skipped (sqlite-vec not in test env)
- Prior summaries: `plans/phase-0-1-summary.md`, `plans/phase-2-summary.md`, `plans/phase-3-summary.md`

## Files Delivered (Phase 4a — EAA Trigger Detection)

### New Files

```
src/consent/
  eaa-triggers.ts          # 8 trigger detectors, DutyConstraint, evaluateEAATriggers (575 LOC)
  eaa-triggers.test.ts     # 55 tests
```

### Modified Files

```
src/consent/
  index.ts                 # Barrel updated with Phase 4a exports
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
    └── triggered → runElevatedActionAnalysis() (Phase 4b, not yet implemented)
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

#### Testing Seam (`__testing`)

`setNow(fn)`, `restoreNow()`, `HIGH_RISK_EFFECTS`, `AMBIGUITY_DISTANCE_THRESHOLD`, `BASE_SEVERITY`, `DANGEROUS_TOOL_NAMES`, `DANGEROUS_TOOL_SEVERITY`, plus all 8 individual detector functions.

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

## Default Duty Constraints

| ID                         | Protects        | Conflicting Effects          | Criticality |
| -------------------------- | --------------- | ---------------------------- | ----------- |
| duty-evidence-preservation | evidence        | irreversible, persist        | strong      |
| duty-confidentiality       | confidentiality | disclose, audience-expand    | strong      |
| duty-safety                | safety          | exec, physical, irreversible | inviolable  |
| duty-privacy               | privacy         | disclose, persist, network   | strong      |
| duty-oversight             | oversight       | elevated, exec               | strong      |

## Test Summary (Phase 4a)

| File                 | Tests | Skipped | Coverage                                                                            |
| -------------------- | ----- | ------- | ----------------------------------------------------------------------------------- |
| eaa-triggers.test.ts | 55    | 0       | All 8 detectors, composite evaluation, default duties, severity scaling, edge cases |

**Full consent suite: 275 passing, 16 skipped** (skipped tests require sqlite-vec native extension).

## Design Decisions (Phase 4a)

1. **8 detectors, 7 categories**: Detectors 4 (novelty/external trust) and 5 (dangerous tool) both emit `novelty-uncertainty`. The evaluator deduplicates categories in the result. This keeps the trigger vocabulary compact while allowing independent detection logic.

2. **Dangerous tools from security module**: Rather than maintaining a separate dangerous-tools list, the trigger module imports `DEFAULT_GATEWAY_HTTP_TOOL_DENY` from `src/security/dangerous-tools.ts`. Single source of truth for tool risk classification.

3. **Duty collision uses default constraints when none provided**: Callers can pass custom `dutyConstraints` for testing or specialized scenarios. When omitted, the 5 default system duties apply. The safety duty is `inviolable` — it cannot be overridden even by explicit user consent.

4. **Severity is max, not sum**: The composite severity is the maximum across all fired triggers, not a weighted sum. This prevents artificial inflation when many low-risk triggers fire simultaneously, and ensures a single high-severity trigger (like emergency or inviolable duty collision) drives the EAA depth.

5. **Testable clock seam**: `detectIrreversibility` uses a module-level `_now()` function overridable via `__testing.setNow()`. This makes consent record expiry checks deterministic in tests. Other detectors don't use time-dependent logic so don't need the seam.

6. **`insufficient-evidence` as distinct category**: Rather than folding "no context" into effect-ambiguity, it's a separate trigger. The semantic distinction matters: effect-ambiguity means the request is unclear; insufficient-evidence means the request may be clear but the system lacks the operational history to judge risk. Phase 4b can use this distinction to select different EAA analysis depths.

7. **`activeWO` accepted but not read**: The `EvaluateEAATriggersParams` includes `activeWO` for interface stability with Phase 4b/4c, which will need WO chain analysis. Phase 4a detectors don't examine the WO directly — they use `consentRecords` and `toolProfile` instead.

8. **Emergency trigger requires physical + urgency**: Both conditions must be present. Physical effects alone don't trigger emergency mode (that's a future/robotics concern). Urgency keywords alone don't trigger it for non-physical effects (that would conflate user impatience with genuine emergency).

## What Remains

### Phase 4b: EAA Adjudication Loop (`src/consent/eaa.ts`)

- 6-step structured adjudication: classify action, constrained discovery, evaluate (LLM inference), select least invasive action, choose outcome, produce artifacts.
- Two output artifacts: `EAAAdjudicationResult` (bounded, for binder) and `EAAReasoningRecord` (opaque, for audit).
- `EAAInferenceFn` injection for the LLM evaluation step.
- Failure handling: LLM failure → refuse fallback, low confidence → request-consent, inviolable duty collision → refuse.

### Phase 4c: EAA Integration (`src/consent/eaa-integration.ts`)

- `handleConsentFailure`: orchestration wiring from `verifyToolConsent` failure path through precedent check → EAA trigger evaluation → EAA/CO routing.
- EAA-to-CO handoff for `request-consent` outcome.
- Binder anchor verification for EAA anchors.
- Successor WO minting from adjudication results.

### Phase 4d: System Prompt Updates

- Effect awareness block in system prompt.
- Consent boundary recognition instructions.
- CO participation instructions.
- EAA slow-down awareness.
- Refusal-as-discretion framing.
