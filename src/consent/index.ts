/**
 * Consent-Bound Agency: Public API
 *
 * Re-exports the core consent module surface for use by the rest of the
 * codebase. Consumers should import from this barrel rather than reaching
 * into individual files.
 */

// Types
export type {
  BinderMintInput,
  BinderRequalifyInput,
  BinderRefusalCode,
  BinderResult,
  ChangeOrder,
  ChangeOrderStatus,
  ConsentAnchor,
  ConsentDecision,
  ConsentRecord,
  ConsentScopeState,
  EAAOutcome,
  EAARecord,
  EffectClass,
  PurchaseOrder,
  StandingPolicyStub,
  ToolEffectProfile,
  TrustTier,
  WOAudienceConstraint,
  WOConstraint,
  WOCountConstraint,
  WOCustomConstraint,
  WODecodeResult,
  WOTimeConstraint,
  WOIntegrityResult,
  WOVerificationFailureCode,
  WOVerificationResult,
  WorkOrder,
} from "./types.js";
export { EFFECT_CLASSES } from "./types.js";

// Effect Registry
export {
  getAllRegisteredProfiles,
  getToolEffectProfile,
  isToolInRegistry,
} from "./effect-registry.js";

// Binder
export {
  configureSigningKey,
  decodeWorkOrderToken,
  mintInitialWorkOrder,
  mintSuccessorWorkOrder,
  verifyConsentAnchorAgainstRecords,
  verifyToolAgainstWO,
  verifyWorkOrderIntegrity,
} from "./binder.js";

// Scope Chain
export {
  addConsentRecord,
  addEAARecord,
  createInitialConsentScopeState,
  enterConsentScope,
  getActivePurchaseOrder,
  getActiveWorkOrder,
  getConsentRecords,
  getConsentScope,
  getEAARecords,
  getWorkOrderChain,
  requireConsentScope,
  transitionWorkOrder,
  withConsentScope,
} from "./scope-chain.js";

// Integration (Phase 2: Tool Execution Pipeline)
export type {
  ConsentEnforcementMode,
  ConsentRunContext,
  ConsentVerificationOutcome,
  CreatePurchaseOrderParams,
} from "./integration.js";
export {
  createPurchaseOrder,
  initializeConsentForRun,
  initializeSigningKey,
  resolveConsentEnforcementMode,
  verifyToolConsent,
} from "./integration.js";

// Phase 3a: Implied Consent Derivation
export type { ImpliedConsentConfig, ImpliedConsentMode } from "./implied-consent.js";
export { deriveImpliedEffects } from "./implied-consent.js";
export type {
  ConsentPattern,
  ConsentPatternSource,
  ConsentPatternStore,
  PatternSearchResult,
} from "./implied-consent-store.js";
export {
  openConsentPatternStore,
  resolveConsentStorePath,
  resolveDefaultConsentStorePath,
  seedConsentPatternStore,
} from "./implied-consent-store.js";
export { deriveEffectsFromHeuristic } from "./implied-consent-heuristic.js";
export { CONSENT_SEED_PATTERNS } from "./implied-consent-seed.js";
export type { ConsentSeedEntry } from "./implied-consent-seed.js";

// Phase 3b: Change Order Lifecycle
export type {
  AmbiguityAssessment,
  RequestChangeOrderParams,
  RequestChangeOrderResult,
  ResolveChangeOrderParams,
  ResolveChangeOrderResult,
} from "./change-order.js";
export {
  assessRequestAmbiguity,
  expireChangeOrder,
  findPatternsForEffects,
  generateEffectDescription,
  getAllPendingChangeOrders,
  getPendingChangeOrder,
  requestChangeOrder,
  resolveChangeOrder,
  withdrawChangeOrder,
} from "./change-order.js";

// Phase 3c: Consent Record Persistence
export type { ConsentRecordStore, OpenConsentRecordStoreParams } from "./consent-store.js";
export {
  openConsentRecordStore,
  resolveConsentRecordStorePath,
  resolveDefaultConsentRecordStorePath,
} from "./consent-store.js";

// Phase 3d: Revocation and Withdrawal
export type {
  RevocationResult,
  RevocationScope,
  RevokeConsentParams,
  SessionResetResult,
  WithdrawalReason,
  WithdrawalResult,
  WithdrawCommitmentParams,
} from "./revocation.js";
export { resetConsentSession, revokeConsent, withdrawCommitment } from "./revocation.js";
