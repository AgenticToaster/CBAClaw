/**
 * Action Receipts (Phase 6b)
 *
 * When a task completes (or a consent boundary is crossed), generates
 * structured accountability artifacts at three detail levels:
 *
 *  - **Confirmation** (routine): lightweight summary for low-risk operations
 *    that proceeded under implied consent or standing policies.
 *  - **Receipt** (non-routine): standard audit artifact for operations that
 *    required explicit consent (CO) or policy bypass.
 *  - **Report** (high-stakes/breach): full accountability artifact for
 *    operations that invoked EAA, triggered breach detection, or used
 *    emergency-act authority.
 *
 * Receipts are immutable once generated, timestamped, and carry enough
 * context to reconstruct the consent chain for audit without requiring
 * access to the full WO token payloads.
 */

import { randomUUID } from "node:crypto";
import type { ConsentEvent } from "./events.js";
import type {
  ChangeOrder,
  ConsentAnchor,
  ConsentRecord,
  EAAOutcome,
  EAARecord,
  EffectClass,
  WOConstraint,
  WorkOrder,
} from "./types.js";

// ---------------------------------------------------------------------------
// Receipt Detail Levels
// ---------------------------------------------------------------------------

export type ReceiptDetailLevel = "confirmation" | "receipt" | "report";

// ---------------------------------------------------------------------------
// Action Summary (shared across levels)
// ---------------------------------------------------------------------------

export type ActionSummaryEntry = {
  /** Tool or action name. */
  action: string;
  /** Effect classes produced by this action. */
  effects: EffectClass[];
  /** Whether the action succeeded. */
  success: boolean;
  /** Brief outcome description. */
  outcome: string;
};

// ---------------------------------------------------------------------------
// Consent Chain Summary
// ---------------------------------------------------------------------------

export type ConsentChainEntry = {
  /** Consent anchor kind. */
  kind: ConsentAnchor["kind"];
  /** Reference ID (consent record, EAA record, policy, or PO ID). */
  refId: string;
  /** What effects this anchor covered. */
  coveredEffects: EffectClass[];
};

// ---------------------------------------------------------------------------
// Receipt Types
// ---------------------------------------------------------------------------

/** Common fields on all receipt levels. */
export type ActionReceiptBase = {
  /** Unique receipt ID. */
  id: string;
  /** Detail level of this receipt. */
  level: ReceiptDetailLevel;
  /** When the receipt was generated. */
  generatedAt: number;
  /** Purchase Order ID for the request that produced this receipt. */
  poId: string;
  /** The final Work Order ID at receipt generation time. */
  finalWoId: string;
  /** Agent ID. */
  agentId?: string;
  /** Session key. */
  sessionKey?: string;
  /** High-level summary of what was done. */
  actionsSummary: ActionSummaryEntry[];
  /** What effect classes were exercised across all actions. */
  effectsExercised: EffectClass[];
  /** What consent was relied on (anchor chain). */
  consentChain: ConsentChainEntry[];
  /** Constraints that were active during execution. */
  activeConstraints: readonly WOConstraint[];
  /** Errors or anomalies encountered. */
  errors: ReceiptError[];
};

export type ReceiptError = {
  /** Tool or subsystem that produced the error. */
  source: string;
  /** Error description. */
  message: string;
  /** Whether this error is a consent violation. */
  isConsentViolation: boolean;
};

/** Confirmation: lightweight, routine operations. */
export type ConfirmationReceipt = ActionReceiptBase & {
  level: "confirmation";
};

/** Receipt: standard non-routine operations. */
export type ActionReceipt = ActionReceiptBase & {
  level: "receipt";
  /** Change Orders that were resolved during this request. */
  changeOrders: ChangeOrderSummary[];
  /** Policies that were used as consent anchors. */
  policiesApplied: PolicySummary[];
};

/** Report: full accountability for high-stakes operations. */
export type ActionReport = ActionReceiptBase & {
  level: "report";
  /** Change Orders that were resolved during this request. */
  changeOrders: ChangeOrderSummary[];
  /** Policies that were used as consent anchors. */
  policiesApplied: PolicySummary[];
  /** EAA adjudications that occurred. */
  eaaAdjudications: EAAAdjudicationSummary[];
  /** Full WO chain (IDs and granted effects at each step). */
  woChain: WOChainEntry[];
  /** Consent events emitted during this request. */
  eventLog: ConsentEvent[];
  /** Whether any breach was detected. */
  breachDetected: boolean;
  /** Breach containment/remediation actions if applicable. */
  breachActions: string[];
};

export type ChangeOrderSummary = {
  coId: string;
  requestedEffects: EffectClass[];
  status: string;
  resolvedAt?: number;
};

export type PolicySummary = {
  policyId: string;
  policyClass: string;
  effectScope: EffectClass[];
};

export type EAAAdjudicationSummary = {
  eaaRecordId: string;
  outcome: EAAOutcome;
  triggerCategories: string[];
  severity: number;
  toolName: string;
};

export type WOChainEntry = {
  woId: string;
  grantedEffects: readonly EffectClass[];
  mintedAt: number;
  anchorKinds: string[];
};

/** Union of all receipt types. */
export type AnyReceipt = ConfirmationReceipt | ActionReceipt | ActionReport;

// ---------------------------------------------------------------------------
// Receipt Detail Level Determination
// ---------------------------------------------------------------------------

export type DetermineDetailLevelParams = {
  /** Whether an EAA adjudication occurred. */
  eaaInvoked: boolean;
  /** Whether a breach was detected. */
  breachDetected: boolean;
  /** Whether an emergency-act outcome was used. */
  emergencyActUsed: boolean;
  /** Whether any Change Order was resolved. */
  changeOrderResolved: boolean;
  /** Whether any policy was used as a consent anchor. */
  policyApplied: boolean;
  /** Effect classes that were exercised. */
  effectsExercised: EffectClass[];
};

const HIGH_RISK_EFFECTS: ReadonlySet<EffectClass> = new Set([
  "irreversible",
  "elevated",
  "disclose",
  "audience-expand",
  "exec",
  "physical",
]);

/**
 * Determine the appropriate receipt detail level based on what happened
 * during the request. Higher-risk operations get more detailed receipts.
 */
export function determineDetailLevel(params: DetermineDetailLevelParams): ReceiptDetailLevel {
  if (params.breachDetected || params.emergencyActUsed || params.eaaInvoked) {
    return "report";
  }

  if (params.changeOrderResolved || params.policyApplied) {
    return "receipt";
  }

  const hasHighRisk = params.effectsExercised.some((e) => HIGH_RISK_EFFECTS.has(e));
  if (hasHighRisk) {
    return "receipt";
  }

  return "confirmation";
}

// ---------------------------------------------------------------------------
// Receipt Generation
// ---------------------------------------------------------------------------

export type GenerateReceiptParams = {
  poId: string;
  agentId?: string;
  sessionKey?: string;
  /** The final active WO at the end of the request. */
  finalWO: WorkOrder;
  /** All WOs in the chain (predecessors + final). */
  woChain: readonly WorkOrder[];
  /** Actions performed during this request. */
  actions: ActionSummaryEntry[];
  /** Consent records created/used during this request. */
  consentRecords: readonly ConsentRecord[];
  /** EAA records from this request. */
  eaaRecords: readonly EAARecord[];
  /**
   * Pre-built EAA adjudication summaries. When provided, these take
   * precedence over auto-building from eaaRecords (which lacks toolName
   * and severity). Callers with richer context should pass this.
   */
  eaaAdjudications?: EAAAdjudicationSummary[];
  /** Change Orders resolved during this request. */
  changeOrders?: ChangeOrder[];
  /** Policy IDs that were applied as consent anchors. */
  appliedPolicies?: PolicySummary[];
  /** Errors encountered. */
  errors?: ReceiptError[];
  /** Consent events collected during this request (for report level). */
  events?: ConsentEvent[];
  /** Breach detection flag. */
  breachDetected?: boolean;
  /** Breach actions taken. */
  breachActions?: string[];
  /** Whether emergency-act was used. */
  emergencyActUsed?: boolean;
  /** Override the detail level (otherwise auto-determined). */
  overrideLevel?: ReceiptDetailLevel;
};

/**
 * Generate an action receipt at the appropriate detail level.
 *
 * The level is auto-determined from the operation context unless
 * overrideLevel is set. Higher-risk operations produce more detailed
 * receipts automatically.
 */
export function generateReceipt(params: GenerateReceiptParams): AnyReceipt {
  const effectsExercised = deduplicateEffects(params.actions.flatMap((a) => a.effects));

  const level =
    params.overrideLevel ??
    determineDetailLevel({
      eaaInvoked: params.eaaRecords.length > 0,
      breachDetected: params.breachDetected ?? false,
      emergencyActUsed: params.emergencyActUsed ?? false,
      changeOrderResolved: (params.changeOrders ?? []).some(
        (co) => co.status === "granted" || co.status === "denied",
      ),
      policyApplied: (params.appliedPolicies ?? []).length > 0,
      effectsExercised,
    });

  const consentChain = buildConsentChain(params.finalWO, params.consentRecords);
  const errors = params.errors ?? [];

  const base: ActionReceiptBase = {
    id: randomUUID(),
    level,
    generatedAt: Date.now(),
    poId: params.poId,
    finalWoId: params.finalWO.id,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    actionsSummary: params.actions,
    effectsExercised,
    consentChain,
    activeConstraints: params.finalWO.constraints,
    errors,
  };

  switch (level) {
    case "confirmation":
      return base as ConfirmationReceipt;

    case "receipt":
      return {
        ...base,
        level: "receipt" as const,
        changeOrders: buildChangeOrderSummaries(params.changeOrders ?? []),
        policiesApplied: params.appliedPolicies ?? [],
      };

    case "report":
      return {
        ...base,
        level: "report" as const,
        changeOrders: buildChangeOrderSummaries(params.changeOrders ?? []),
        policiesApplied: params.appliedPolicies ?? [],
        eaaAdjudications: params.eaaAdjudications ?? buildEAASummaries(params.eaaRecords),
        woChain: buildWOChain(params.woChain, params.finalWO),
        eventLog: params.events ?? [],
        breachDetected: params.breachDetected ?? false,
        breachActions: params.breachActions ?? [],
      };
  }
}

// ---------------------------------------------------------------------------
// Receipt Formatting
// ---------------------------------------------------------------------------

/**
 * Format a receipt as a human-readable text summary.
 * Suitable for CLI output, chat responses, or log entries.
 */
export function formatReceiptAsText(receipt: AnyReceipt): string {
  const lines: string[] = [];

  const levelLabel =
    receipt.level === "confirmation"
      ? "Confirmation"
      : receipt.level === "receipt"
        ? "Receipt"
        : "Report";
  lines.push(`--- Action ${levelLabel} ---`);
  lines.push(`ID: ${receipt.id}`);
  lines.push(`Generated: ${new Date(receipt.generatedAt).toISOString()}`);
  lines.push(`Request: ${receipt.poId}`);
  lines.push("");

  lines.push("Actions:");
  for (const action of receipt.actionsSummary) {
    const status = action.success ? "OK" : "FAILED";
    lines.push(
      `  [${status}] ${action.action}: ${action.outcome} (effects: ${action.effects.join(", ")})`,
    );
  }
  lines.push("");

  lines.push(`Effects exercised: ${receipt.effectsExercised.join(", ") || "none"}`);
  lines.push("");

  lines.push("Consent chain:");
  for (const entry of receipt.consentChain) {
    lines.push(`  ${entry.kind}: ${entry.refId} → [${entry.coveredEffects.join(", ")}]`);
  }

  if (receipt.activeConstraints.length > 0) {
    lines.push("");
    lines.push("Active constraints:");
    for (const c of receipt.activeConstraints) {
      lines.push(
        `  ${c.kind}${c.kind === "time-bound" ? ` (expires: ${new Date(c.expiresAt).toISOString()})` : ""}`,
      );
    }
  }

  if (receipt.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of receipt.errors) {
      const violation = e.isConsentViolation ? " [CONSENT VIOLATION]" : "";
      lines.push(`  ${e.source}: ${e.message}${violation}`);
    }
  }

  if (receipt.level === "receipt" || receipt.level === "report") {
    const detailed = receipt as ActionReceipt;
    if (detailed.changeOrders.length > 0) {
      lines.push("");
      lines.push("Change Orders:");
      for (const co of detailed.changeOrders) {
        lines.push(`  ${co.coId}: ${co.status} [${co.requestedEffects.join(", ")}]`);
      }
    }
    if (detailed.policiesApplied.length > 0) {
      lines.push("");
      lines.push("Policies applied:");
      for (const p of detailed.policiesApplied) {
        lines.push(`  ${p.policyId} (${p.policyClass}): [${p.effectScope.join(", ")}]`);
      }
    }
  }

  if (receipt.level === "report") {
    const report = receipt;
    if (report.eaaAdjudications.length > 0) {
      lines.push("");
      lines.push("EAA Adjudications:");
      for (const eaa of report.eaaAdjudications) {
        lines.push(
          `  ${eaa.eaaRecordId}: ${eaa.outcome} (tool: ${eaa.toolName}, ` +
            `severity: ${eaa.severity.toFixed(2)}, triggers: ${eaa.triggerCategories.join(", ")})`,
        );
      }
    }
    if (report.woChain.length > 0) {
      lines.push("");
      lines.push("WO Chain:");
      for (const wo of report.woChain) {
        lines.push(
          `  ${wo.woId}: [${wo.grantedEffects.join(", ")}] ` +
            `(minted: ${new Date(wo.mintedAt).toISOString()}, anchors: ${wo.anchorKinds.join(", ")})`,
        );
      }
    }
    if (report.breachDetected) {
      lines.push("");
      lines.push("BREACH DETECTED");
      for (const action of report.breachActions) {
        lines.push(`  Action: ${action}`);
      }
    }
  }

  lines.push("--- End ---");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function deduplicateEffects(effects: EffectClass[]): EffectClass[] {
  return [...new Set(effects)];
}

function buildConsentChain(
  wo: WorkOrder,
  consentRecords: readonly ConsentRecord[],
): ConsentChainEntry[] {
  const entries: ConsentChainEntry[] = [];
  const recordMap = new Map(consentRecords.map((r) => [r.id, r]));

  for (const anchor of wo.consentAnchors) {
    switch (anchor.kind) {
      case "implied":
        entries.push({
          kind: "implied",
          refId: anchor.poId,
          coveredEffects: [],
        });
        break;
      case "explicit": {
        const record = recordMap.get(anchor.consentRecordId);
        entries.push({
          kind: "explicit",
          refId: anchor.consentRecordId,
          coveredEffects: record ? [...record.effectClasses] : [],
        });
        break;
      }
      case "eaa":
        entries.push({
          kind: "eaa",
          refId: anchor.eaaRecordId,
          coveredEffects: [],
        });
        break;
      case "policy":
        entries.push({
          kind: "policy",
          refId: anchor.policyId,
          coveredEffects: [],
        });
        break;
    }
  }

  return entries;
}

function buildChangeOrderSummaries(changeOrders: ChangeOrder[]): ChangeOrderSummary[] {
  return changeOrders.map((co) => ({
    coId: co.id,
    requestedEffects: [...co.requestedEffects],
    status: co.status,
    resolvedAt: co.resolvedAt,
  }));
}

/**
 * Fallback builder when the caller doesn't supply pre-built adjudication summaries.
 * EAARecord lacks toolName and severity; these default to empty/zero. Prefer
 * passing eaaAdjudications directly to generateReceipt for complete reports.
 */
function buildEAASummaries(eaaRecords: readonly EAARecord[]): EAAAdjudicationSummary[] {
  return eaaRecords.map((r) => ({
    eaaRecordId: r.id,
    outcome: r.outcome,
    triggerCategories: r.triggerReason.split("; "),
    severity: 0,
    toolName: "",
  }));
}

function buildWOChain(chain: readonly WorkOrder[], finalWO: WorkOrder): WOChainEntry[] {
  const allWOs = [...chain, finalWO];
  return allWOs.map((wo) => ({
    woId: wo.id,
    grantedEffects: wo.grantedEffects,
    mintedAt: wo.mintedAt,
    anchorKinds: wo.consentAnchors.map((a) => a.kind),
  }));
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  HIGH_RISK_EFFECTS,
  buildConsentChain,
  buildChangeOrderSummaries,
  buildEAASummaries,
  buildWOChain,
  deduplicateEffects,
};
