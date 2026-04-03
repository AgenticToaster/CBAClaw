/**
 * Consent Revocation and Agent Withdrawal
 *
 * Handles two cancellation patterns:
 *
 * 1. **Requestor Revocation**: The user revokes consent, invalidating active
 *    WOs and stopping future work dependent on revoked terms. Wired into
 *    the existing /cancel and session reset flows.
 *
 * 2. **Agent Withdrawal**: When constraints change or duties conflict, the
 *    agent can withdraw commitment and explain why.
 *
 * Both paths produce auditable records and leave the scope in a well-defined
 * terminal state.
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mintInitialWorkOrder } from "./binder.js";
import type { ConsentRecordStore } from "./consent-store.js";
import { addConsentRecord, getConsentScope, transitionWorkOrder } from "./scope-chain.js";
import type {
  ConsentDecision,
  ConsentRecord,
  EffectClass,
  PurchaseOrder,
  WorkOrder,
} from "./types.js";

const log = createSubsystemLogger("consent/revocation");

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export type RevocationResult =
  | {
      ok: true;
      /** The new minimal WO (read-only baseline). */
      restrictedWO: WorkOrder;
      /** Number of consent records marked as revoked. */
      revokedRecordCount: number;
    }
  | { ok: false; reason: string };

export type RevocationScope = "all" | "effects";

export type RevokeConsentParams = {
  /** Which effects to revoke. "all" revokes everything; "effects" revokes specific effect classes. */
  scope: RevocationScope;
  /** Specific effects to revoke (required when scope is "effects"). */
  effects?: EffectClass[];
  /** Reason for revocation (logged for audit). */
  reason?: string;
  /** Persistent store to mark records in (optional). */
  persistentStore?: ConsentRecordStore;
};

/**
 * Revoke consent, invalidating the active WO and replacing it with a
 * minimal WO that only permits read + compose (or no effects if those
 * were specifically revoked).
 *
 * All in-scope consent records are marked as "revoked". The WO chain
 * is preserved for audit.
 *
 * Must be called from within a consent scope context.
 */
export function revokeConsent(params: RevokeConsentParams): RevocationResult {
  const scope = getConsentScope();
  if (!scope) {
    return { ok: false, reason: "No active consent scope to revoke" };
  }

  const { po } = scope;
  const now = Date.now();
  const revokeReason = params.reason ?? "User-initiated revocation";

  // Determine which effects to revoke
  let revokedEffects: Set<EffectClass>;
  if (params.scope === "all") {
    revokedEffects = new Set(scope.activeWO.grantedEffects);
  } else {
    if (!params.effects || params.effects.length === 0) {
      return { ok: false, reason: "No effects specified for targeted revocation" };
    }
    revokedEffects = new Set(params.effects);
  }

  // Mark all consent records covering revoked effects as revoked
  let revokedRecordCount = 0;
  for (const record of scope.consentRecords) {
    if (record.decision !== "granted") {
      continue;
    }
    const hasRevokedEffect = record.effectClasses.some((e) => revokedEffects.has(e));
    if (hasRevokedEffect) {
      (record as { decision: ConsentDecision }).decision = "revoked";
      revokedRecordCount++;

      if (params.persistentStore) {
        try {
          params.persistentStore.updateConsentDecision(record.id, "revoked", now);
        } catch (err) {
          log.debug(`failed to update persistent record on revocation: ${String(err)}`);
        }
      }
    }
  }

  // Create a revocation consent record for the audit trail
  const revocationRecord: ConsentRecord = {
    id: randomUUID(),
    poId: po.id,
    woId: scope.activeWO.id,
    effectClasses: [...revokedEffects],
    decision: "revoked",
    timestamp: now,
    metadata: {
      source: "user-revocation",
      reason: revokeReason,
      scope: params.scope,
    },
  };
  addConsentRecord(revocationRecord);

  if (params.persistentStore) {
    try {
      params.persistentStore.insertConsentRecord(revocationRecord);
    } catch (err) {
      log.debug(`failed to persist revocation record: ${String(err)}`);
    }
  }

  // Mint a restricted WO. The baseline ["read"] is always preserved as the
  // minimum operational capability so the agent can still communicate refusals.
  // System prohibitions exclude "read" to avoid a terminal state.
  const prohibitions = [...revokedEffects].filter((e) => e !== "read");
  const restrictedPO: PurchaseOrder = {
    ...po,
    impliedEffects: ["read"],
  };

  const mintResult = mintInitialWorkOrder({
    po: restrictedPO,
    policies: [],
    systemProhibitions: prohibitions,
  });

  if (!mintResult.ok) {
    // All effects prohibited; scope is terminal
    log.debug(
      `revocation resulted in terminal scope (all effects prohibited): ${mintResult.reason}`,
    );
    return {
      ok: false,
      reason: `Revocation left no permitted effects: ${mintResult.reason}`,
    };
  }

  transitionWorkOrder(mintResult.wo);

  log.debug(
    `consent revoked: effects=[${[...revokedEffects].join(",")}] ` +
      `revokedRecords=${revokedRecordCount} newWO=${mintResult.wo.id} ` +
      `remainingEffects=[${mintResult.wo.grantedEffects.join(",")}]`,
  );

  return {
    ok: true,
    restrictedWO: mintResult.wo,
    revokedRecordCount,
  };
}

// ---------------------------------------------------------------------------
// Agent Withdrawal
// ---------------------------------------------------------------------------

export type WithdrawalReason =
  | "constraint-change"
  | "duty-conflict"
  | "capability-insufficient"
  | "safety-concern"
  | "other";

export type WithdrawalResult =
  | {
      ok: true;
      /** The restricted WO after withdrawal. */
      restrictedWO: WorkOrder;
      /** Human-readable explanation for the user. */
      explanation: string;
    }
  | { ok: false; reason: string };

export type WithdrawCommitmentParams = {
  /** Categorized reason for withdrawal. */
  withdrawalReason: WithdrawalReason;
  /** Human-readable explanation for the user. */
  explanation: string;
  /** Effects the agent is withdrawing from (if not all). */
  affectedEffects?: EffectClass[];
  /** Persistent store to record the withdrawal in (optional). */
  persistentStore?: ConsentRecordStore;
};

/**
 * Human-readable descriptions for withdrawal reasons.
 */
const WITHDRAWAL_DESCRIPTIONS: Record<WithdrawalReason, string> = {
  "constraint-change": "Operating constraints have changed since the original commitment.",
  "duty-conflict": "Continuing would create a conflict between competing obligations.",
  "capability-insufficient":
    "The agent lacks the capability or authorization to complete this work safely.",
  "safety-concern": "Continuing poses a safety or integrity risk that cannot be mitigated.",
  other: "The agent is unable to continue with the current scope of work.",
};

/**
 * Agent-initiated withdrawal from current commitments. The agent signals
 * that it cannot or should not continue with the current scope of work.
 *
 * Unlike revocation (user-initiated), withdrawal is the agent's decision
 * to narrow or cease work. The user is informed with an explanation.
 *
 * Must be called from within a consent scope context.
 */
export function withdrawCommitment(params: WithdrawCommitmentParams): WithdrawalResult {
  const scope = getConsentScope();
  if (!scope) {
    return { ok: false, reason: "No active consent scope for withdrawal" };
  }

  const { po } = scope;
  const now = Date.now();

  const affectedEffects = params.affectedEffects ?? [...scope.activeWO.grantedEffects];

  // Record the withdrawal in the consent trail
  const withdrawalRecord: ConsentRecord = {
    id: randomUUID(),
    poId: po.id,
    woId: scope.activeWO.id,
    effectClasses: affectedEffects,
    decision: "revoked",
    timestamp: now,
    metadata: {
      source: "agent-withdrawal",
      withdrawalReason: params.withdrawalReason,
      explanation: params.explanation,
    },
  };
  addConsentRecord(withdrawalRecord);

  if (params.persistentStore) {
    try {
      params.persistentStore.insertConsentRecord(withdrawalRecord);
    } catch (err) {
      log.debug(`failed to persist withdrawal record: ${String(err)}`);
    }
  }

  // Mint a restricted WO excluding the affected effects. Always preserve
  // "read" as the minimum operational capability.
  const remainingEffects = scope.activeWO.grantedEffects.filter(
    (e) => !affectedEffects.includes(e),
  );
  const minimalEffects =
    remainingEffects.length > 0 ? [...remainingEffects] : (["read"] as EffectClass[]);
  if (!minimalEffects.includes("read")) {
    minimalEffects.push("read");
  }

  const prohibitions = affectedEffects.filter((e) => e !== "read");

  const restrictedPO: PurchaseOrder = {
    ...po,
    impliedEffects: minimalEffects,
  };

  const mintResult = mintInitialWorkOrder({
    po: restrictedPO,
    policies: [],
    systemProhibitions: prohibitions,
  });

  if (!mintResult.ok) {
    return {
      ok: false,
      reason: `Withdrawal left no viable effects: ${mintResult.reason}`,
    };
  }

  transitionWorkOrder(mintResult.wo);

  const baseExplanation = WITHDRAWAL_DESCRIPTIONS[params.withdrawalReason];
  const fullExplanation = `${baseExplanation} ${params.explanation}`;

  log.debug(
    `agent withdrawal: reason=${params.withdrawalReason} ` +
      `effects=[${affectedEffects.join(",")}] newWO=${mintResult.wo.id}`,
  );

  return {
    ok: true,
    restrictedWO: mintResult.wo,
    explanation: fullExplanation,
  };
}

// ---------------------------------------------------------------------------
// Session Reset
// ---------------------------------------------------------------------------

export type SessionResetResult = {
  /** Number of consent records cleared from scope. */
  clearedRecords: number;
  /** Number of EAA records cleared from scope. */
  clearedEAARecords: number;
};

/**
 * Reset the consent state for a session. Clears all in-memory consent and
 * EAA records from the scope. Optionally clears the persistent store too.
 *
 * Intended to be wired into the /cancel and session reset flows.
 * The active WO remains (it expires naturally via TTL), but all
 * accumulated consent grants are cleared so future tool calls must
 * re-acquire consent.
 */
export function resetConsentSession(persistentStore?: ConsentRecordStore): SessionResetResult {
  const scope = getConsentScope();
  if (!scope) {
    return { clearedRecords: 0, clearedEAARecords: 0 };
  }

  const clearedRecords = scope.consentRecords.length;
  const clearedEAARecords = scope.eaaRecords.length;

  // Clear in-memory records
  scope.consentRecords.length = 0;
  scope.eaaRecords.length = 0;

  // Clear persistent store if provided
  if (persistentStore) {
    try {
      persistentStore.clearAll();
    } catch (err) {
      log.debug(`failed to clear persistent consent store: ${String(err)}`);
    }
  }

  log.debug(
    `consent session reset: clearedRecords=${clearedRecords} ` +
      `clearedEAARecords=${clearedEAARecords}`,
  );

  return { clearedRecords, clearedEAARecords };
}
