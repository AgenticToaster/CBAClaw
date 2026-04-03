import { afterEach, describe, expect, it } from "vitest";
import { __testing as binderTesting } from "./binder.js";
import {
  createPurchaseOrder,
  initializeConsentForRun,
  resolveConsentEnforcementMode,
  verifyToolConsent,
  __testing as integrationTesting,
} from "./integration.js";
import {
  enterConsentScope,
  createInitialConsentScopeState,
  getActiveWorkOrder,
  getConsentScope,
  withConsentScope,
} from "./scope-chain.js";
import type { PurchaseOrder, WorkOrder } from "./types.js";

const FIXED_TIME = 1_700_000_000_000;
let idCounter = 0;

function setupDeterministicBinder(): void {
  binderTesting.setNow(() => FIXED_TIME);
  binderTesting.setGenerateId(() => `test-id-${++idCounter}`);
  binderTesting.setSigningKey(Buffer.alloc(32, 0xab));
}

afterEach(() => {
  binderTesting.restore();
  integrationTesting.resetSigningKeyConfigured();
  idCounter = 0;
});

// ---------------------------------------------------------------------------
// createPurchaseOrder
// ---------------------------------------------------------------------------

describe("createPurchaseOrder", () => {
  it("creates a PO from basic params with default implied effects", () => {
    const po = createPurchaseOrder({
      requestText: "What time is it?",
      senderId: "user-1",
      senderIsOwner: true,
    });

    expect(po.id).toBeTruthy();
    expect(po.requestText).toBe("What time is it?");
    expect(po.senderId).toBe("user-1");
    expect(po.senderIsOwner).toBe(true);
    expect(po.impliedEffects).toEqual(["read", "compose"]);
    expect(po.timestamp).toBeGreaterThan(0);
  });

  it("includes optional context fields when provided", () => {
    const po = createPurchaseOrder({
      requestText: "Send a message",
      senderId: "user-2",
      senderIsOwner: false,
      channel: "telegram",
      chatType: "group",
      sessionKey: "sess-abc",
      agentId: "agent-1",
    });

    expect(po.channel).toBe("telegram");
    expect(po.chatType).toBe("group");
    expect(po.sessionKey).toBe("sess-abc");
    expect(po.agentId).toBe("agent-1");
  });

  it("uses provided impliedEffects when given", () => {
    const po = createPurchaseOrder({
      requestText: "Delete the file",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "irreversible", "persist"],
    });

    expect(po.impliedEffects).toEqual(["read", "irreversible", "persist"]);
  });

  it("creates a defensive copy of impliedEffects", () => {
    const effects = ["read", "compose"] as const;
    const po = createPurchaseOrder({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: [...effects],
    });

    expect(po.impliedEffects).toEqual(["read", "compose"]);
    expect(po.impliedEffects).not.toBe(effects);
  });
});

// ---------------------------------------------------------------------------
// resolveConsentEnforcementMode
// ---------------------------------------------------------------------------

describe("resolveConsentEnforcementMode", () => {
  it("defaults to 'log' when env var is not set", () => {
    expect(resolveConsentEnforcementMode({})).toBe("log");
  });

  it("returns 'warn' when CBA_ENFORCEMENT=warn", () => {
    expect(resolveConsentEnforcementMode({ CBA_ENFORCEMENT: "warn" })).toBe("warn");
  });

  it("returns 'enforce' when CBA_ENFORCEMENT=enforce", () => {
    expect(resolveConsentEnforcementMode({ CBA_ENFORCEMENT: "enforce" })).toBe("enforce");
  });

  it("returns 'log' when CBA_ENFORCEMENT=log", () => {
    expect(resolveConsentEnforcementMode({ CBA_ENFORCEMENT: "log" })).toBe("log");
  });

  it("defaults to 'log' for invalid values", () => {
    expect(resolveConsentEnforcementMode({ CBA_ENFORCEMENT: "invalid" })).toBe("log");
    expect(resolveConsentEnforcementMode({ CBA_ENFORCEMENT: "" })).toBe("log");
  });
});

// ---------------------------------------------------------------------------
// initializeConsentForRun
// ---------------------------------------------------------------------------

describe("initializeConsentForRun", () => {
  it("creates a consent context with PO, WO, and scope state", async () => {
    setupDeterministicBinder();

    const ctx = await initializeConsentForRun({
      requestText: "Read a file",
      senderId: "user-1",
      senderIsOwner: true,
      channel: "telegram",
      sessionKey: "sess-1",
      agentId: "agent-1",
      impliedEffects: ["read", "compose"],
      env: {},
    });

    expect(ctx).toBeDefined();
    expect(ctx!.po.requestText).toBe("Read a file");
    expect(ctx!.po.senderId).toBe("user-1");
    expect(ctx!.wo.id).toBeTruthy();
    expect(ctx!.wo.grantedEffects).toEqual(["read", "compose"]);
    expect(ctx!.wo.immutable).toBe(true);
    expect(ctx!.wo.token).toBeTruthy();
    expect(ctx!.enforcement).toBe("log");
    expect(ctx!.scopeState.po).toBe(ctx!.po);
    expect(ctx!.scopeState.activeWO).toBe(ctx!.wo);
    expect(ctx!.scopeState.woChain).toEqual([]);
  });

  it("returns undefined when all implied effects are system-prohibited", async () => {
    setupDeterministicBinder();

    const ctx = await initializeConsentForRun({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: [],
      env: {},
    });

    expect(ctx).toBeUndefined();
  });

  it("resolves enforcement mode from env", async () => {
    setupDeterministicBinder();

    const ctx = await initializeConsentForRun({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      env: { CBA_ENFORCEMENT: "enforce" },
    });

    expect(ctx).toBeDefined();
    expect(ctx!.enforcement).toBe("enforce");
  });

  it("configures signing key from CBA_SIGNING_KEY env var", async () => {
    const key = Buffer.alloc(32, 0xcc).toString("base64");

    const ctx = await initializeConsentForRun({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      env: { CBA_SIGNING_KEY: key },
    });

    expect(ctx).toBeDefined();
    expect(integrationTesting.signingKeyConfigured).toBe(true);
  });

  it("uses explicit impliedEffects and skips derivation when provided", async () => {
    setupDeterministicBinder();

    const ctx = await initializeConsentForRun({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      env: {},
    });

    expect(ctx).toBeDefined();
    expect(ctx!.wo.grantedEffects).toEqual(["read", "compose"]);
  });

  it("falls back to heuristic derivation when no embedding provider is available", async () => {
    setupDeterministicBinder();

    // No explicit impliedEffects → triggers deriveImpliedEffects → no embedding
    // provider → falls back to heuristic. "Run the tests" matches the exec rule.
    const ctx = await initializeConsentForRun({
      requestText: "Run the tests",
      senderId: "user-1",
      senderIsOwner: true,
      env: {},
    });

    expect(ctx).toBeDefined();
    // Heuristic for "Run" → exec + read + compose
    expect(ctx!.wo.grantedEffects).toContain("exec");
    expect(ctx!.wo.grantedEffects).toContain("read");
    expect(ctx!.wo.grantedEffects).toContain("compose");
  });
});

// ---------------------------------------------------------------------------
// verifyToolConsent
// ---------------------------------------------------------------------------

describe("verifyToolConsent", () => {
  function makeScopedWO(effects: string[]): WorkOrder {
    setupDeterministicBinder();
    return binderTesting.sealWorkOrder({
      id: "wo-test",
      requestContextId: "po-test",
      grantedEffects: effects as WorkOrder["grantedEffects"],
      constraints: [],
      consentAnchors: [{ kind: "implied", poId: "po-test" }],
      mintedAt: FIXED_TIME,
      expiresAt: FIXED_TIME + 30 * 60 * 1000,
      immutable: true,
      token: "",
    });
  }

  function makePO(): PurchaseOrder {
    return {
      id: "po-test",
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      timestamp: FIXED_TIME,
    };
  }

  it("returns allowed when no consent scope is active", () => {
    const result = verifyToolConsent("read");
    expect(result.allowed).toBe(true);
  });

  it("returns allowed when tool effects are covered by WO grants", () => {
    const wo = makeScopedWO(["read", "compose"]);
    const po = makePO();
    const state = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(state, () => {
      return verifyToolConsent("read", { effects: ["read"], trustTier: "in-process" });
    });

    expect(result.allowed).toBe(true);
  });

  it("allows in 'log' mode when effects are not covered", () => {
    const wo = makeScopedWO(["read", "compose"]);
    const po = makePO();
    const state = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(state, () => {
      return verifyToolConsent(
        "exec",
        { effects: ["exec", "irreversible"], trustTier: "in-process" },
        "log",
      );
    });

    expect(result.allowed).toBe(true);
  });

  it("allows in 'warn' mode when effects are not covered", () => {
    const wo = makeScopedWO(["read", "compose"]);
    const po = makePO();
    const state = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(state, () => {
      return verifyToolConsent(
        "exec",
        { effects: ["exec", "irreversible"], trustTier: "in-process" },
        "warn",
      );
    });

    expect(result.allowed).toBe(true);
  });

  it("blocks in 'enforce' mode when effects are not covered", () => {
    const wo = makeScopedWO(["read", "compose"]);
    const po = makePO();
    const state = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(state, () => {
      return verifyToolConsent(
        "exec",
        { effects: ["exec", "irreversible"], trustTier: "in-process" },
        "enforce",
      );
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("exec");
      expect(result.result.ok).toBe(false);
    }
  });

  it("falls back to effect registry when no profile is provided", () => {
    const wo = makeScopedWO(["read", "compose", "persist", "network"]);
    const po = makePO();
    const state = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(state, () => {
      // "write" is in the registry with effects: ["persist"]
      return verifyToolConsent("write", undefined, "enforce");
    });

    expect(result.allowed).toBe(true);
  });

  it("blocks unknown tools in enforce mode when effects are missing", () => {
    const wo = makeScopedWO(["read"]);
    const po = makePO();
    const state = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(state, () => {
      // Unknown tools get conservative default: ["read", "compose", "persist", "network"]
      return verifyToolConsent("unknown_custom_tool", undefined, "enforce");
    });

    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enterConsentScope
// ---------------------------------------------------------------------------

describe("enterConsentScope", () => {
  it("binds consent state so getActiveWorkOrder returns it", () => {
    setupDeterministicBinder();
    const po: PurchaseOrder = {
      id: "po-enter",
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read"],
      timestamp: FIXED_TIME,
    };
    const wo = binderTesting.sealWorkOrder({
      id: "wo-enter",
      requestContextId: "po-enter",
      grantedEffects: ["read"],
      constraints: [],
      consentAnchors: [{ kind: "implied", poId: "po-enter" }],
      mintedAt: FIXED_TIME,
      immutable: true,
      token: "",
    });
    const state = createInitialConsentScopeState(po, wo);

    // enterConsentScope uses ALS.enterWith which binds to the current
    // execution context. Wrap in withConsentScope to contain the binding
    // and prevent leaking into other tests.
    withConsentScope(createInitialConsentScopeState(po, wo), () => {
      // Override the outer scope with enterConsentScope — this is the
      // production-like usage (attempt.ts calls enterConsentScope, not
      // withConsentScope, because wrapping ~2000 LOC in a callback is
      // impractical).
      enterConsentScope(state);
      const scope = getConsentScope();
      expect(scope).toBeDefined();
      expect(scope!.po.id).toBe("po-enter");
      expect(scope!.activeWO.id).toBe("wo-enter");
      expect(getActiveWorkOrder()?.id).toBe("wo-enter");
    });
  });

  it("makes consent scope visible to verifyToolConsent", () => {
    setupDeterministicBinder();
    const po: PurchaseOrder = {
      id: "po-verify",
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read"],
      timestamp: FIXED_TIME,
    };
    const wo = binderTesting.sealWorkOrder({
      id: "wo-verify",
      requestContextId: "po-verify",
      grantedEffects: ["read"],
      constraints: [],
      consentAnchors: [{ kind: "implied", poId: "po-verify" }],
      mintedAt: FIXED_TIME,
      expiresAt: FIXED_TIME + 30 * 60 * 1000,
      immutable: true,
      token: "",
    });
    const state = createInitialConsentScopeState(po, wo);

    // Use enterConsentScope (the production path) inside a containment scope
    withConsentScope(createInitialConsentScopeState(po, wo), () => {
      enterConsentScope(state);
      const outcome = verifyToolConsent(
        "read",
        { effects: ["read"], trustTier: "in-process" },
        "enforce",
      );
      expect(outcome.allowed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: initializeConsentForRun → verifyToolConsent
// ---------------------------------------------------------------------------

describe("end-to-end consent flow", () => {
  it("initializes consent and verifies tool calls within scope", async () => {
    setupDeterministicBinder();

    const ctx = await initializeConsentForRun({
      requestText: "Read my files",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      env: { CBA_ENFORCEMENT: "enforce" },
    });

    expect(ctx).toBeDefined();

    const results = withConsentScope(ctx!.scopeState, () => {
      const readResult = verifyToolConsent(
        "read",
        { effects: ["read"], trustTier: "in-process" },
        ctx!.enforcement,
      );
      const writeResult = verifyToolConsent(
        "write",
        { effects: ["persist"], trustTier: "in-process" },
        ctx!.enforcement,
      );
      return { readResult, writeResult };
    });

    expect(results.readResult.allowed).toBe(true);
    expect(results.writeResult.allowed).toBe(false);
  });

  it("allows all tools in log mode regardless of coverage", async () => {
    setupDeterministicBinder();

    const ctx = await initializeConsentForRun({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      env: { CBA_ENFORCEMENT: "log" },
    });

    expect(ctx).toBeDefined();

    const result = withConsentScope(ctx!.scopeState, () => {
      return verifyToolConsent(
        "exec",
        { effects: ["exec", "irreversible"], trustTier: "in-process" },
        ctx!.enforcement,
      );
    });

    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 5i: Policy-loaded initialization
// ---------------------------------------------------------------------------

describe("initializeConsentForRun with policy store (5i)", () => {
  it("loads active policies from store and passes them to binder", async () => {
    setupDeterministicBinder();

    const mockPolicyStore = {
      expireStalePolicies: () => 0,
      getActivePolicies: () => [
        {
          id: "user-pol-persist",
          class: "user" as const,
          effectScope: ["persist"] as const,
          applicability: {},
          escalationRules: [],
          expiry: { currentUses: 0 },
          revocationSemantics: "immediate" as const,
          provenance: { author: "user:test", createdAt: FIXED_TIME },
          description: "Allow persist",
          status: "active" as const,
        },
      ],
    };

    const ctx = await initializeConsentForRun({
      requestText: "save a file",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      env: {},
      policyStore: mockPolicyStore as never,
    });

    expect(ctx).toBeDefined();
    // System policy grants read+compose; user policy adds persist
    expect(ctx!.wo.grantedEffects).toContain("read");
    expect(ctx!.wo.grantedEffects).toContain("compose");
    expect(ctx!.wo.grantedEffects).toContain("persist");
    expect(ctx!.activePolicies.length).toBeGreaterThan(0);
    expect(ctx!.policyStore).toBeDefined();
  });

  it("returns activePolicies=[] and no policyStore when no store is provided", async () => {
    setupDeterministicBinder();

    const ctx = await initializeConsentForRun({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      env: {},
    });

    expect(ctx).toBeDefined();
    expect(ctx!.activePolicies).toEqual([]);
    expect(ctx!.policyStore).toBeUndefined();
    // No system policies loaded → exactly the implied effects
    expect(ctx!.wo.grantedEffects).toEqual(["read", "compose"]);
  });

  it("expires stale policies before loading", async () => {
    setupDeterministicBinder();
    let expiredCalled = false;

    const mockPolicyStore = {
      expireStalePolicies: () => {
        expiredCalled = true;
        return 2;
      },
      getActivePolicies: () => [],
    };

    await initializeConsentForRun({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read"],
      env: {},
      policyStore: mockPolicyStore as never,
    });

    expect(expiredCalled).toBe(true);
  });

  it("handles policy store errors gracefully", async () => {
    setupDeterministicBinder();

    const mockPolicyStore = {
      expireStalePolicies: () => {
        throw new Error("DB connection failed");
      },
      getActivePolicies: () => [],
    };

    const ctx = await initializeConsentForRun({
      requestText: "test",
      senderId: "user-1",
      senderIsOwner: true,
      impliedEffects: ["read", "compose"],
      env: {},
      policyStore: mockPolicyStore as never,
    });

    // Should still succeed — policy loading errors are non-fatal
    expect(ctx).toBeDefined();
    expect(ctx!.wo.grantedEffects).toEqual(["read", "compose"]);
  });
});
