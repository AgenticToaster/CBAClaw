/**
 * Consent Scope Chain (AsyncLocalStorage)
 *
 * Carries the active consent contract state through the agent execution.
 * Modeled on the existing gateway-request-scope.ts pattern using
 * resolveGlobalSingleton so the same ALS instance survives module reloads.
 *
 * Created at agent run start (when the PO is derived and initial WO minted),
 * and read by the before-tool-call hook to verify each tool invocation
 * against the active Work Order.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { verifyWorkOrderIntegrity } from "./binder.js";
import type {
  ConsentRecord,
  ConsentScopeState,
  EAARecord,
  PurchaseOrder,
  WorkOrder,
} from "./types.js";

// ---------------------------------------------------------------------------
// Singleton ALS Instance
// ---------------------------------------------------------------------------

const CONSENT_SCOPE_KEY: unique symbol = Symbol.for("openclaw.consentScope");

const consentScope = resolveGlobalSingleton<AsyncLocalStorage<ConsentScopeState>>(
  CONSENT_SCOPE_KEY,
  () => new AsyncLocalStorage<ConsentScopeState>(),
);

// ---------------------------------------------------------------------------
// Scope Lifecycle
// ---------------------------------------------------------------------------

/**
 * Run work under a consent scope. Called at agent run start after the PO
 * is derived and the initial WO is minted.
 */
export function withConsentScope<T>(state: ConsentScopeState, run: () => T): T {
  return consentScope.run(state, run);
}

/**
 * Return the current consent scope state, or undefined if not inside
 * a consent-scoped execution context.
 */
export function getConsentScope(): ConsentScopeState | undefined {
  return consentScope.getStore();
}

/**
 * Return the current consent scope state, throwing if not inside a
 * consent-scoped execution context. Use this in paths that structurally
 * require a scope (e.g., tool execution hooks).
 */
export function requireConsentScope(): ConsentScopeState {
  const state = consentScope.getStore();
  if (!state) {
    throw new Error(
      "Consent scope not available. This code path requires an active " +
        "consent scope (set up at agent run start via withConsentScope).",
    );
  }
  return state;
}

// ---------------------------------------------------------------------------
// Scope Mutations (immutable WO chain, mutable record collections)
// ---------------------------------------------------------------------------

/**
 * Transition the active WO to a successor. The predecessor is appended
 * to the immutable woChain for audit. This is the only way to change
 * the active WO after initial minting.
 *
 * Verifies the integrity of the outgoing WO before archiving it, and
 * verifies the integrity of the incoming successor before accepting it.
 * A tampered WO at either position throws -- this is a hard security
 * boundary, not a recoverable refusal.
 *
 * Must be called from within a consent scope context.
 */
export function transitionWorkOrder(successorWO: WorkOrder): void {
  const state = requireConsentScope();

  const outgoing = verifyWorkOrderIntegrity(state.activeWO);
  if (!outgoing.ok) {
    throw new Error(
      `Cannot transition: outgoing WO integrity check failed (${outgoing.reason}). ` +
        "This indicates the active Work Order was tampered with after minting.",
    );
  }

  const incoming = verifyWorkOrderIntegrity(successorWO);
  if (!incoming.ok) {
    throw new Error(
      `Cannot transition: incoming successor WO integrity check failed (${incoming.reason}). ` +
        "Only binder-minted Work Orders may be used as successors.",
    );
  }

  state.woChain = [...state.woChain, state.activeWO];
  state.activeWO = successorWO;
}

/**
 * Add a consent record to the current scope's collection.
 * Records are used by the binder for anchor verification.
 */
export function addConsentRecord(record: ConsentRecord): void {
  const state = requireConsentScope();
  state.consentRecords.push(record);
}

/**
 * Add an EAA record to the current scope's collection.
 */
export function addEAARecord(record: EAARecord): void {
  const state = requireConsentScope();
  state.eaaRecords.push(record);
}

// ---------------------------------------------------------------------------
// Scope Queries
// ---------------------------------------------------------------------------

/**
 * Get the active Work Order from the current consent scope.
 * Returns undefined if no consent scope is active.
 */
export function getActiveWorkOrder(): WorkOrder | undefined {
  return consentScope.getStore()?.activeWO;
}

/**
 * Get the Purchase Order from the current consent scope.
 * Returns undefined if no consent scope is active.
 */
export function getActivePurchaseOrder(): PurchaseOrder | undefined {
  return consentScope.getStore()?.po;
}

/**
 * Get the full WO chain (all predecessors) from the current consent scope.
 * Returns undefined if no consent scope is active.
 */
export function getWorkOrderChain(): readonly WorkOrder[] | undefined {
  return consentScope.getStore()?.woChain;
}

/**
 * Get all consent records from the current consent scope.
 */
export function getConsentRecords(): readonly ConsentRecord[] | undefined {
  return consentScope.getStore()?.consentRecords;
}

/**
 * Get all EAA records from the current consent scope.
 */
export function getEAARecords(): readonly EAARecord[] | undefined {
  return consentScope.getStore()?.eaaRecords;
}

// ---------------------------------------------------------------------------
// Factory: Create initial scope state from PO and WO
// ---------------------------------------------------------------------------

/**
 * Build the initial ConsentScopeState from a Purchase Order and the
 * binder-minted initial Work Order. Use with withConsentScope().
 */
export function createInitialConsentScopeState(
  po: PurchaseOrder,
  initialWO: WorkOrder,
): ConsentScopeState {
  return {
    po,
    activeWO: initialWO,
    woChain: [],
    consentRecords: [],
    eaaRecords: [],
  };
}
