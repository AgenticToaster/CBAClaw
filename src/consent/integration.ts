/**
 * Consent-Bound Agency: Tool Execution Pipeline Integration
 *
 * Bridges the consent module (PO/WO/scope-chain/binder) into the openclaw
 * agent runtime. Phase 2 wires consent verification into the tool execution
 * pipeline with configurable enforcement modes for safe rollout.
 *
 * Key responsibilities:
 * - PurchaseOrder factory from agent run context
 * - Signing key initialization from environment
 * - Consent scope initialization for agent runs
 * - Before-tool-call WO verification with enforcement modes
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { configureSigningKey, mintInitialWorkOrder, verifyToolAgainstWO } from "./binder.js";
import { getToolEffectProfile } from "./effect-registry.js";
import { startMetricsCollection } from "./metrics.js";
import type { PolicyStore } from "./policy-store.js";
import { DEFAULT_SYSTEM_POLICIES } from "./policy.js";
import type { StandingPolicy } from "./policy.js";
import { createInitialConsentScopeState, getActiveWorkOrder } from "./scope-chain.js";
import type {
  BinderPolicy,
  ConsentScopeState,
  EffectClass,
  PurchaseOrder,
  ToolEffectProfile,
  WOVerificationResult,
  WorkOrder,
} from "./types.js";

const log = createSubsystemLogger("consent");

// ---------------------------------------------------------------------------
// Enforcement Mode
// ---------------------------------------------------------------------------

export type ConsentEnforcementMode = "log" | "warn" | "enforce";

const VALID_ENFORCEMENT_MODES = new Set<ConsentEnforcementMode>(["log", "warn", "enforce"]);

/**
 * Resolve the consent enforcement mode from environment.
 *
 * Reads `CBA_ENFORCEMENT` env var. Defaults to "log" for safe rollout.
 * In "log" mode, verification failures are logged at debug level and tool
 * execution proceeds. In "warn" mode, failures are logged at warn level.
 * In "enforce" mode, failures block tool execution.
 */
export function resolveConsentEnforcementMode(env?: NodeJS.ProcessEnv): ConsentEnforcementMode {
  const raw = (env ?? process.env).CBA_ENFORCEMENT;
  if (raw && VALID_ENFORCEMENT_MODES.has(raw as ConsentEnforcementMode)) {
    return raw as ConsentEnforcementMode;
  }
  return "log";
}

// ---------------------------------------------------------------------------
// Signing Key Initialization
// ---------------------------------------------------------------------------

let _signingKeyConfigured = false;

/**
 * Initialize the WO signing key from `CBA_SIGNING_KEY` environment variable.
 * Safe to call multiple times; only configures on the first invocation.
 *
 * If the env var is missing, the binder falls back to a per-process random
 * key (suitable for single-process dev but not cross-boundary verification).
 */
export function initializeSigningKey(env?: NodeJS.ProcessEnv): void {
  if (_signingKeyConfigured) {
    return;
  }
  const key = (env ?? process.env).CBA_SIGNING_KEY;
  if (key) {
    try {
      configureSigningKey(key);
      log.debug("consent signing key configured from CBA_SIGNING_KEY");
    } catch (err) {
      log.warn(`failed to configure consent signing key: ${String(err)}`);
    }
  } else {
    log.debug("no CBA_SIGNING_KEY set; using per-process random signing key");
  }
  _signingKeyConfigured = true;
}

// ---------------------------------------------------------------------------
// PurchaseOrder Factory
// ---------------------------------------------------------------------------

/**
 * Fallback implied effects when both vector search and heuristic derivation
 * fail. Conservative: read + compose covers informational requests.
 */
const FALLBACK_IMPLIED_EFFECTS: readonly EffectClass[] = ["read", "compose"];

export type CreatePurchaseOrderParams = {
  requestText: string;
  senderId: string;
  senderIsOwner: boolean;
  channel?: string;
  chatType?: string;
  sessionKey?: string;
  agentId?: string;
  /** Explicit implied effects. When set, skips vector/heuristic derivation. */
  impliedEffects?: EffectClass[];
  /** State dir override for the consent pattern store. */
  stateDir?: string;
};

/**
 * Build a PurchaseOrder from agent run context. The PO formalizes the
 * request that initiates the consent contract.
 *
 * When impliedEffects are provided explicitly, they are used directly.
 * Otherwise falls back to the static FALLBACK_IMPLIED_EFFECTS. For
 * dynamic derivation via vector search + heuristics, callers should
 * use initializeConsentForRun which runs deriveImpliedEffects first.
 */
export function createPurchaseOrder(params: CreatePurchaseOrderParams): PurchaseOrder {
  return {
    id: randomUUID(),
    requestText: params.requestText,
    senderId: params.senderId,
    senderIsOwner: params.senderIsOwner,
    channel: params.channel,
    chatType: params.chatType,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    impliedEffects: params.impliedEffects
      ? [...params.impliedEffects]
      : [...FALLBACK_IMPLIED_EFFECTS],
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Consent Scope Initialization
// ---------------------------------------------------------------------------

export type ConsentRunContext = {
  scopeState: ConsentScopeState;
  po: PurchaseOrder;
  wo: WorkOrder;
  enforcement: ConsentEnforcementMode;
  /** Active standing policies loaded at initialization (Phase 5i). */
  activePolicies: readonly StandingPolicy[];
  /** Policy store reference, if policies are enabled. */
  policyStore?: PolicyStore;
};

/**
 * Initialize the full consent context for an agent run. Derives implied
 * effects from the request text (vector search + heuristic), creates a PO,
 * mints the initial WO, and builds the scope state.
 *
 * When a policyStore is provided (Phase 5i), active policies are loaded,
 * stale policies are expired, and the combined policy set (active + system
 * defaults) is passed to the binder for initial WO minting.
 *
 * Returns undefined if initialization fails (binder refused the WO).
 * Callers should treat undefined as "consent not available" and proceed
 * without consent enforcement.
 */
export async function initializeConsentForRun(
  params: CreatePurchaseOrderParams & {
    env?: NodeJS.ProcessEnv;
    /** Pre-opened policy store (Phase 5i). Omit to auto-open from config. */
    policyStore?: PolicyStore;
  },
): Promise<ConsentRunContext | undefined> {
  initializeSigningKey(params.env);
  const enforcement = resolveConsentEnforcementMode(params.env);

  // Phase 3a: derive implied effects from request text unless explicitly set
  let impliedEffects = params.impliedEffects;
  let consentPoliciesConfig:
    | { enabled?: boolean; storePath?: string; embeddingDimension?: number }
    | undefined;
  if (!impliedEffects) {
    try {
      const { deriveImpliedEffects } = await import("./implied-consent.js");
      let consentConfig: Record<string, unknown> | undefined;
      try {
        const { loadConfig } = await import("../config/config.js");
        const cfg = loadConfig();
        consentConfig = cfg.consent?.impliedEffects as Record<string, unknown> | undefined;
        consentPoliciesConfig = cfg.consent?.policies;
      } catch {
        // Config unavailable during bootstrap; proceed with defaults
      }
      impliedEffects = await deriveImpliedEffects({
        requestText: params.requestText,
        stateDir: params.stateDir,
        consentConfig,
      });
    } catch (err) {
      log.warn(`implied effects derivation failed, using fallback: ${String(err)}`);
      impliedEffects = [...FALLBACK_IMPLIED_EFFECTS];
    }
  }

  // Phase 5i: auto-open policy store from config when policies are enabled
  // and no pre-opened store was provided.
  let policyStore = params.policyStore;
  if (!policyStore && consentPoliciesConfig?.enabled) {
    try {
      const { openPolicyStore, resolveDefaultPolicyStorePath, resolvePolicyStorePath } =
        await import("./policy-store.js");
      const dbPath = consentPoliciesConfig.storePath
        ? resolvePolicyStorePath(consentPoliciesConfig.storePath)
        : await resolveDefaultPolicyStorePath();
      policyStore = await openPolicyStore({
        dbPath,
        embeddingDimension: consentPoliciesConfig.embeddingDimension ?? 0,
      });
      log.debug(`policy store opened from config: ${dbPath}`);
    } catch (err) {
      log.warn(`failed to open policy store from config: ${String(err)}`);
    }
  }

  // Phase 5i: load active policies from store, expire stale ones.
  let allPolicies: BinderPolicy[] = [];
  let activePolicies: StandingPolicy[] = [];
  if (policyStore) {
    try {
      const expired = policyStore.expireStalePolicies();
      if (expired > 0) {
        log.debug(`expired ${expired} stale policies during initialization`);
      }
      activePolicies = policyStore.getActivePolicies();
      log.debug(`loaded ${activePolicies.length} active policies from store`);
      allPolicies = [...DEFAULT_SYSTEM_POLICIES, ...activePolicies];
    } catch (err) {
      log.warn(`failed to load policies from store: ${String(err)}`);
    }
  }

  const po = createPurchaseOrder({ ...params, impliedEffects });

  const result = mintInitialWorkOrder({
    po,
    policies: allPolicies,
    systemProhibitions: [],
  });

  if (!result.ok) {
    log.warn(
      `consent initialization failed: binder refused initial WO ` +
        `(code=${result.code}, reason=${result.reason})`,
    );
    return undefined;
  }

  const scopeState = createInitialConsentScopeState(po, result.wo);

  // Phase 6d: start metrics collection on first successful initialization
  startMetricsCollection();

  log.debug(
    `consent scope initialized: po=${po.id} wo=${result.wo.id} ` +
      `effects=[${result.wo.grantedEffects.join(",")}] enforcement=${enforcement}`,
  );

  return {
    scopeState,
    po,
    wo: result.wo,
    enforcement,
    activePolicies: allPolicies,
    policyStore,
  };
}

// ---------------------------------------------------------------------------
// Before-Tool-Call WO Verification
// ---------------------------------------------------------------------------

export type ConsentVerificationOutcome =
  | { allowed: true }
  | { allowed: false; reason: string; result: WOVerificationResult };

/**
 * Verify that the active Work Order permits a tool call. Called from the
 * before-tool-call hook.
 *
 * When no consent scope is active (e.g., consent not initialized or running
 * outside a consent-scoped context), returns allowed=true so the tool
 * proceeds without enforcement.
 *
 * The enforcement mode determines what happens on verification failure:
 * - "log": log at debug level, allow execution
 * - "warn": log at warn level, allow execution
 * - "enforce": block execution with structured refusal
 */
export function verifyToolConsent(
  toolName: string,
  toolEffectProfile?: ToolEffectProfile,
  enforcement?: ConsentEnforcementMode,
): ConsentVerificationOutcome {
  const activeWO = getActiveWorkOrder();
  if (!activeWO) {
    return { allowed: true };
  }

  const profile = toolEffectProfile ?? getToolEffectProfile(toolName);
  const result = verifyToolAgainstWO(toolName, profile, activeWO);

  if (result.ok) {
    return { allowed: true };
  }

  const mode = enforcement ?? resolveConsentEnforcementMode();

  switch (mode) {
    case "log":
      log.debug(`consent verification failed (log mode): ${result.reason}`);
      return { allowed: true };

    case "warn":
      log.warn(`consent verification failed: ${result.reason}`);
      return { allowed: true };

    case "enforce":
      return { allowed: false, reason: result.reason, result };
  }
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  get signingKeyConfigured(): boolean {
    return _signingKeyConfigured;
  },
  resetSigningKeyConfigured(): void {
    _signingKeyConfigured = false;
  },
  FALLBACK_IMPLIED_EFFECTS,
};
