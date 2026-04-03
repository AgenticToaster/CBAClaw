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
  BinderPolicy,
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
export type { PolicyEmbedder } from "./binder.js";
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

// Phase 4a: EAA Trigger Detection
export type {
  DutyConstraint,
  DutyCriticality,
  DutyProtectionTarget,
  EAATriggerCategory,
  EAATriggerResult,
  EvaluateEAATriggersParams,
} from "./eaa-triggers.js";
export { DEFAULT_DUTY_CONSTRAINTS, evaluateEAATriggers } from "./eaa-triggers.js";

// Phase 4c: EAA Integration into Orchestration Pipeline
export type { ConsentFailureResolution, HandleConsentFailureParams } from "./eaa-integration.js";
export { handleConsentFailure } from "./eaa-integration.js";

// Phase 4b: EAA Adjudication Loop
export type {
  ActionAlternative,
  ActionCategory,
  ActionClassification,
  AffectedParty,
  DutyConflict,
  EAAAdjudicationResult,
  EAAEvaluation,
  EAAInferenceFn,
  EAAReasoningRecord,
  EAARunParams,
  EAARunResult,
  RiskSeverity,
} from "./eaa.js";
export { runElevatedActionAnalysis } from "./eaa.js";

// Phase 5a: Standing Policy Type System
export type {
  EscalationCondition,
  EscalationContext,
  EscalationRule,
  PolicyApplicabilityPredicate,
  PolicyClass,
  PolicyExpiry,
  PolicyMatchContext,
  PolicyProvenance,
  PolicyRevocationSemantics,
  PolicyStatus,
  StandingPolicy,
} from "./policy.js";
export {
  buildContextEmbeddingText,
  buildPolicyEmbeddingText,
  DEFAULT_SYSTEM_POLICIES,
  evaluateEscalationRules,
  filterApplicablePolicies,
  isExpired,
  isFullStandingPolicy,
  meetsTrustTier,
  recordAndCheckUsage,
} from "./policy.js";

// Phase 5a/5f: Trust Tier Derivation
export type { ToolSource } from "./policy.js";
export { deriveTrustTier } from "./policy.js";

// Phase 5b: Policy Store (Persistence + Vector Similarity)
export type { OpenPolicyStoreParams, PolicyStore } from "./policy-store.js";
export {
  openPolicyStore,
  resolveDefaultPolicyStorePath,
  resolvePolicyStorePath,
} from "./policy-store.js";

// Phase 5e: Self-Minted Policy Proposal
export type {
  CheckCOPromotionParams,
  COPromotionResult,
  PolicyProposal,
  PolicyProposalParams,
} from "./policy-proposal.js";
export {
  analyzeForPolicyProposals,
  checkCOForPolicyPromotion,
  createSelfMintedPolicy,
} from "./policy-proposal.js";
