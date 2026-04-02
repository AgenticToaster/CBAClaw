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
