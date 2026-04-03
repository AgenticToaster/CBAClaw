import { describe, expect, it } from "vitest";
import {
  buildContextEmbeddingText,
  buildPolicyEmbeddingText,
  DEFAULT_SYSTEM_POLICIES,
  deriveTrustTier,
  evaluateEscalationRules,
  filterApplicablePolicies,
  isExpired,
  isFullStandingPolicy,
  meetsTrustTier,
  recordAndCheckUsage,
  __testing,
  type EscalationContext,
  type EscalationRule,
  type PolicyMatchContext,
  type StandingPolicy,
} from "./policy.js";
import type { EffectClass, StandingPolicyStub } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestPolicy(overrides?: Partial<StandingPolicy>): StandingPolicy {
  return {
    id: "test-policy-1",
    class: "user",
    effectScope: ["persist", "network"],
    applicability: {},
    escalationRules: [],
    expiry: { currentUses: 0 },
    revocationSemantics: "immediate",
    provenance: { author: "user-1", createdAt: 1_700_000_000_000 },
    description: "Test user policy for persist and network effects.",
    status: "active",
    ...overrides,
  };
}

function createTestStub(overrides?: Partial<StandingPolicyStub>): StandingPolicyStub {
  return {
    id: "stub-1",
    policyClass: "user",
    effectScope: ["read"],
    ...overrides,
  };
}

function createTestContext(overrides?: Partial<PolicyMatchContext>): PolicyMatchContext {
  return {
    senderId: "user-1",
    senderIsOwner: true,
    ...overrides,
  };
}

function createEscalationContext(overrides?: Partial<EscalationContext>): EscalationContext {
  return {
    toolName: "test-tool",
    toolProfile: { effects: ["read"], trustTier: "in-process" },
    po: { senderId: "user-1", senderIsOwner: true },
    recentInvocationCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isFullStandingPolicy type guard
// ---------------------------------------------------------------------------

describe("isFullStandingPolicy", () => {
  it("returns true for a full StandingPolicy", () => {
    const policy = createTestPolicy();
    expect(isFullStandingPolicy(policy)).toBe(true);
  });

  it("returns false for a StandingPolicyStub", () => {
    const stub = createTestStub();
    expect(isFullStandingPolicy(stub)).toBe(false);
  });

  it("discriminates correctly when both types are in an array", () => {
    const items: (StandingPolicyStub | StandingPolicy)[] = [
      createTestStub(),
      createTestPolicy(),
      createTestStub({ id: "stub-2" }),
    ];

    const full = items.filter(isFullStandingPolicy);
    expect(full).toHaveLength(1);
    expect(full[0].id).toBe("test-policy-1");
  });

  it("returns false for object with applicability but no status", () => {
    const partial = { id: "p", policyClass: "user" as const, effectScope: [], applicability: {} };
    expect(isFullStandingPolicy(partial as StandingPolicyStub)).toBe(false);
  });

  it("returns false for object with status but no applicability", () => {
    const partial = { id: "p", policyClass: "user" as const, effectScope: [], status: "active" };
    expect(isFullStandingPolicy(partial as StandingPolicyStub)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// meetsTrustTier
// ---------------------------------------------------------------------------

describe("meetsTrustTier", () => {
  it("in-process meets all tiers", () => {
    expect(meetsTrustTier("in-process", "external")).toBe(true);
    expect(meetsTrustTier("in-process", "sandboxed")).toBe(true);
    expect(meetsTrustTier("in-process", "in-process")).toBe(true);
  });

  it("sandboxed meets sandboxed and external but not in-process", () => {
    expect(meetsTrustTier("sandboxed", "external")).toBe(true);
    expect(meetsTrustTier("sandboxed", "sandboxed")).toBe(true);
    expect(meetsTrustTier("sandboxed", "in-process")).toBe(false);
  });

  it("external only meets external", () => {
    expect(meetsTrustTier("external", "external")).toBe(true);
    expect(meetsTrustTier("external", "sandboxed")).toBe(false);
    expect(meetsTrustTier("external", "in-process")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------

describe("isExpired", () => {
  it("returns false when no expiry conditions set", () => {
    expect(isExpired({ currentUses: 0 })).toBe(false);
  });

  it("returns true when expiresAt is in the past", () => {
    const pastTs = Date.now() - 1000;
    expect(isExpired({ expiresAt: pastTs, currentUses: 0 })).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    const futureTs = Date.now() + 60_000;
    expect(isExpired({ expiresAt: futureTs, currentUses: 0 })).toBe(false);
  });

  it("uses provided now timestamp for comparison", () => {
    const now = 1_700_000_000_000;
    expect(isExpired({ expiresAt: now - 1, currentUses: 0 }, now)).toBe(true);
    expect(isExpired({ expiresAt: now + 1, currentUses: 0 }, now)).toBe(false);
  });

  it("returns true when expiresAt equals now (boundary)", () => {
    const now = 1_700_000_000_000;
    expect(isExpired({ expiresAt: now, currentUses: 0 }, now)).toBe(true);
  });

  it("returns true when currentUses reaches maxUses", () => {
    expect(isExpired({ maxUses: 5, currentUses: 5 })).toBe(true);
  });

  it("returns true when currentUses exceeds maxUses", () => {
    expect(isExpired({ maxUses: 5, currentUses: 7 })).toBe(true);
  });

  it("returns false when currentUses is below maxUses", () => {
    expect(isExpired({ maxUses: 10, currentUses: 3 })).toBe(false);
  });

  it("returns true when either time or uses condition triggers", () => {
    const now = 1_700_000_000_000;
    // Not expired by time, but expired by uses
    expect(isExpired({ expiresAt: now + 60_000, maxUses: 2, currentUses: 2 }, now)).toBe(true);
    // Expired by time, not by uses
    expect(isExpired({ expiresAt: now - 1, maxUses: 100, currentUses: 0 }, now)).toBe(true);
  });

  it("returns true when maxUses is 0 (zero-use policy)", () => {
    expect(isExpired({ maxUses: 0, currentUses: 0 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterApplicablePolicies
// ---------------------------------------------------------------------------

describe("filterApplicablePolicies", () => {
  it("returns empty array when no policies provided", () => {
    const result = filterApplicablePolicies([], createTestContext());
    expect(result).toEqual([]);
  });

  it("skips StandingPolicyStub entries", () => {
    const stub = createTestStub();
    const result = filterApplicablePolicies([stub], createTestContext());
    expect(result).toEqual([]);
  });

  it("skips non-active policies", () => {
    const revoked = createTestPolicy({ status: "revoked" });
    const pending = createTestPolicy({ id: "p2", status: "pending-confirmation" });
    const expired = createTestPolicy({ id: "p3", status: "expired" });
    const result = filterApplicablePolicies([revoked, pending, expired], createTestContext());
    expect(result).toEqual([]);
  });

  it("skips policies that have expired by time", () => {
    const now = 1_700_000_000_000;
    const policy = createTestPolicy({
      expiry: { expiresAt: now - 1000, currentUses: 0 },
    });
    const result = filterApplicablePolicies([policy], createTestContext());
    expect(result).toEqual([]);
  });

  it("returns active policies with empty applicability (universal)", () => {
    const policy = createTestPolicy();
    const result = filterApplicablePolicies([policy], createTestContext());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("test-policy-1");
  });

  // Channel filtering
  it("matches when context channel is in applicability channels", () => {
    const policy = createTestPolicy({
      applicability: { channels: ["telegram", "discord"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ channel: "telegram" }));
    expect(result).toHaveLength(1);
  });

  it("excludes when context channel is not in applicability channels", () => {
    const policy = createTestPolicy({
      applicability: { channels: ["telegram"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ channel: "slack" }));
    expect(result).toEqual([]);
  });

  it("excludes when applicability requires channel but context has none", () => {
    const policy = createTestPolicy({
      applicability: { channels: ["telegram"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ channel: undefined }));
    expect(result).toEqual([]);
  });

  // Chat type filtering
  it("matches when context chatType is in applicability chatTypes", () => {
    const policy = createTestPolicy({
      applicability: { chatTypes: ["dm", "group"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ chatType: "dm" }));
    expect(result).toHaveLength(1);
  });

  it("excludes when context chatType is not in applicability chatTypes", () => {
    const policy = createTestPolicy({
      applicability: { chatTypes: ["dm"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ chatType: "public" }));
    expect(result).toEqual([]);
  });

  // Sender ID filtering
  it("matches when senderId is in applicability senderIds", () => {
    const policy = createTestPolicy({
      applicability: { senderIds: ["user-1", "user-2"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ senderId: "user-2" }));
    expect(result).toHaveLength(1);
  });

  it("excludes when senderId is not in applicability senderIds", () => {
    const policy = createTestPolicy({
      applicability: { senderIds: ["user-1"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ senderId: "user-3" }));
    expect(result).toEqual([]);
  });

  // requireOwner filtering
  it("matches when requireOwner is true and sender is owner", () => {
    const policy = createTestPolicy({
      applicability: { requireOwner: true },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ senderIsOwner: true }));
    expect(result).toHaveLength(1);
  });

  it("excludes when requireOwner is true and sender is not owner", () => {
    const policy = createTestPolicy({
      applicability: { requireOwner: true },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ senderIsOwner: false }));
    expect(result).toEqual([]);
  });

  // Time window filtering
  it("matches when current hour is within time window", () => {
    const policy = createTestPolicy({
      applicability: { timeWindow: { startHour: 9, endHour: 17 } },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ currentHour: 12 }));
    expect(result).toHaveLength(1);
  });

  it("excludes when current hour is outside time window", () => {
    const policy = createTestPolicy({
      applicability: { timeWindow: { startHour: 9, endHour: 17 } },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ currentHour: 20 }));
    expect(result).toEqual([]);
  });

  it("handles overnight time windows (e.g., 22:00 to 06:00)", () => {
    const policy = createTestPolicy({
      applicability: { timeWindow: { startHour: 22, endHour: 6 } },
    });
    // 23:00 should be in window
    expect(filterApplicablePolicies([policy], createTestContext({ currentHour: 23 }))).toHaveLength(
      1,
    );
    // 02:00 should be in window
    expect(filterApplicablePolicies([policy], createTestContext({ currentHour: 2 }))).toHaveLength(
      1,
    );
    // 12:00 should be outside window
    expect(filterApplicablePolicies([policy], createTestContext({ currentHour: 12 }))).toEqual([]);
  });

  // Tool name filtering
  it("matches when toolName is in applicability toolNames", () => {
    const policy = createTestPolicy({
      applicability: { toolNames: ["web_fetch", "web_search"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ toolName: "web_fetch" }));
    expect(result).toHaveLength(1);
  });

  it("excludes when toolName is not in applicability toolNames", () => {
    const policy = createTestPolicy({
      applicability: { toolNames: ["web_fetch"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ toolName: "exec" }));
    expect(result).toEqual([]);
  });

  it("excludes when applicability requires toolName but context has none", () => {
    const policy = createTestPolicy({
      applicability: { toolNames: ["web_fetch"] },
    });
    const result = filterApplicablePolicies([policy], createTestContext({ toolName: undefined }));
    expect(result).toEqual([]);
  });

  // Trust tier filtering
  it("matches when tool trust tier meets minimum", () => {
    const policy = createTestPolicy({
      applicability: { minTrustTier: "sandboxed" },
    });
    const result = filterApplicablePolicies(
      [policy],
      createTestContext({ toolTrustTier: "in-process" }),
    );
    expect(result).toHaveLength(1);
  });

  it("excludes when tool trust tier is below minimum", () => {
    const policy = createTestPolicy({
      applicability: { minTrustTier: "in-process" },
    });
    const result = filterApplicablePolicies(
      [policy],
      createTestContext({ toolTrustTier: "sandboxed" }),
    );
    expect(result).toEqual([]);
  });

  it("excludes when applicability requires trust tier but context has none", () => {
    const policy = createTestPolicy({
      applicability: { minTrustTier: "sandboxed" },
    });
    const result = filterApplicablePolicies(
      [policy],
      createTestContext({ toolTrustTier: undefined }),
    );
    expect(result).toEqual([]);
  });

  // Combined filter
  it("matches when all filter conditions are satisfied", () => {
    const policy = createTestPolicy({
      applicability: {
        channels: ["telegram"],
        chatTypes: ["dm"],
        requireOwner: true,
        toolNames: ["web_fetch"],
        minTrustTier: "sandboxed",
        timeWindow: { startHour: 9, endHour: 17 },
      },
    });
    const result = filterApplicablePolicies(
      [policy],
      createTestContext({
        channel: "telegram",
        chatType: "dm",
        senderIsOwner: true,
        toolName: "web_fetch",
        toolTrustTier: "in-process",
        currentHour: 12,
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("excludes when any single filter condition fails", () => {
    const policy = createTestPolicy({
      applicability: {
        channels: ["telegram"],
        requireOwner: true,
      },
    });
    // Channel matches but owner doesn't
    const result = filterApplicablePolicies(
      [policy],
      createTestContext({
        channel: "telegram",
        senderIsOwner: false,
      }),
    );
    expect(result).toEqual([]);
  });

  it("filters mixed array of stubs and full policies", () => {
    const stub = createTestStub();
    const activePolicy = createTestPolicy({ id: "active" });
    const revokedPolicy = createTestPolicy({ id: "revoked", status: "revoked" });
    const result = filterApplicablePolicies(
      [stub, activePolicy, revokedPolicy],
      createTestContext(),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("active");
  });

  it("skips policies that have expired by max uses", () => {
    const policy = createTestPolicy({
      expiry: { maxUses: 5, currentUses: 5 },
    });
    const result = filterApplicablePolicies([policy], createTestContext());
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isInTimeWindow (via __testing)
// ---------------------------------------------------------------------------

describe("isInTimeWindow", () => {
  it("returns true when hour is within standard window", () => {
    expect(__testing.isInTimeWindow(12, 9, 17)).toBe(true);
  });

  it("returns true at the start boundary", () => {
    expect(__testing.isInTimeWindow(9, 9, 17)).toBe(true);
  });

  it("returns false at the end boundary (exclusive)", () => {
    expect(__testing.isInTimeWindow(17, 9, 17)).toBe(false);
  });

  it("handles overnight window: hour after start", () => {
    expect(__testing.isInTimeWindow(23, 22, 6)).toBe(true);
  });

  it("handles overnight window: hour before end", () => {
    expect(__testing.isInTimeWindow(3, 22, 6)).toBe(true);
  });

  it("handles overnight window: hour in the gap", () => {
    expect(__testing.isInTimeWindow(12, 22, 6)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateEscalationRules
// ---------------------------------------------------------------------------

describe("evaluateEscalationRules", () => {
  it("returns undefined when no rules provided", () => {
    const result = evaluateEscalationRules([], createEscalationContext());
    expect(result).toBeUndefined();
  });

  it("returns undefined when no rules match", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "effect-combination", effects: ["physical", "irreversible"] },
        action: "trigger-eaa",
        description: "Physical + irreversible requires EAA.",
      },
    ];
    const ctx = createEscalationContext({
      toolProfile: { effects: ["read"], trustTier: "in-process" },
    });
    expect(evaluateEscalationRules(rules, ctx)).toBeUndefined();
  });

  // effect-combination
  it("matches effect-combination when all effects present", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "effect-combination", effects: ["persist", "irreversible"] },
        action: "require-co",
        description: "Persist + irreversible requires CO.",
      },
    ];
    const ctx = createEscalationContext({
      toolProfile: { effects: ["persist", "irreversible", "read"] },
    });
    const result = evaluateEscalationRules(rules, ctx);
    expect(result).toBeDefined();
    expect(result!.action).toBe("require-co");
  });

  it("does not match effect-combination when effects partially present", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "effect-combination", effects: ["persist", "irreversible"] },
        action: "require-co",
        description: "Persist + irreversible requires CO.",
      },
    ];
    const ctx = createEscalationContext({
      toolProfile: { effects: ["persist", "read"] },
    });
    expect(evaluateEscalationRules(rules, ctx)).toBeUndefined();
  });

  // audience-exceeds
  it("matches audience-exceeds when count exceeds threshold", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "audience-exceeds", maxRecipients: 10 },
        action: "trigger-eaa",
        description: "Too many recipients.",
      },
    ];
    const ctx = createEscalationContext({ recentInvocationCount: 15 });
    const result = evaluateEscalationRules(rules, ctx);
    expect(result).toBeDefined();
    expect(result!.action).toBe("trigger-eaa");
  });

  it("does not match audience-exceeds when count is at threshold", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "audience-exceeds", maxRecipients: 10 },
        action: "trigger-eaa",
        description: "Too many recipients.",
      },
    ];
    const ctx = createEscalationContext({ recentInvocationCount: 10 });
    expect(evaluateEscalationRules(rules, ctx)).toBeUndefined();
  });

  // frequency-exceeds
  it("matches frequency-exceeds when count exceeds threshold", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "frequency-exceeds", maxPerHour: 5 },
        action: "refuse",
        description: "Rate limit exceeded.",
      },
    ];
    const ctx = createEscalationContext({ recentInvocationCount: 6 });
    const result = evaluateEscalationRules(rules, ctx);
    expect(result).toBeDefined();
    expect(result!.action).toBe("refuse");
  });

  it("does not match frequency-exceeds when count is within limit", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "frequency-exceeds", maxPerHour: 5 },
        action: "refuse",
        description: "Rate limit exceeded.",
      },
    ];
    const ctx = createEscalationContext({ recentInvocationCount: 3 });
    expect(evaluateEscalationRules(rules, ctx)).toBeUndefined();
  });

  // trust-tier-below
  it("matches trust-tier-below when tool tier is lower than required", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "trust-tier-below", tier: "in-process" },
        action: "refuse",
        description: "External tools not allowed.",
      },
    ];
    const ctx = createEscalationContext({
      toolProfile: { effects: ["read"], trustTier: "sandboxed" },
    });
    const result = evaluateEscalationRules(rules, ctx);
    expect(result).toBeDefined();
    expect(result!.action).toBe("refuse");
  });

  it("does not match trust-tier-below when tool tier meets requirement", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "trust-tier-below", tier: "sandboxed" },
        action: "refuse",
        description: "External tools not allowed.",
      },
    ];
    const ctx = createEscalationContext({
      toolProfile: { effects: ["read"], trustTier: "in-process" },
    });
    expect(evaluateEscalationRules(rules, ctx)).toBeUndefined();
  });

  it("defaults to in-process when toolProfile has no trustTier", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "trust-tier-below", tier: "in-process" },
        action: "refuse",
        description: "Must be in-process.",
      },
    ];
    const ctx = createEscalationContext({
      toolProfile: { effects: ["read"] },
    });
    // Default is in-process, which meets in-process requirement
    expect(evaluateEscalationRules(rules, ctx)).toBeUndefined();
  });

  // custom condition
  it("matches custom condition when evaluate returns true", () => {
    const rules: EscalationRule[] = [
      {
        condition: {
          kind: "custom",
          label: "test-custom",
          evaluate: (ctx) => ctx.toolName === "dangerous-tool",
        },
        action: "trigger-eaa",
        description: "Custom escalation for dangerous tool.",
      },
    ];
    const ctx = createEscalationContext({ toolName: "dangerous-tool" });
    const result = evaluateEscalationRules(rules, ctx);
    expect(result).toBeDefined();
    expect(result!.action).toBe("trigger-eaa");
  });

  it("does not match custom condition when evaluate returns false", () => {
    const rules: EscalationRule[] = [
      {
        condition: {
          kind: "custom",
          label: "test-custom",
          evaluate: () => false,
        },
        action: "trigger-eaa",
        description: "Never fires.",
      },
    ];
    expect(evaluateEscalationRules(rules, createEscalationContext())).toBeUndefined();
  });

  // Vacuous truth edge case
  it("effect-combination with empty effects always matches (vacuous truth)", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "effect-combination", effects: [] },
        action: "trigger-eaa",
        description: "Empty effects vacuously match.",
      },
    ];
    const ctx = createEscalationContext({
      toolProfile: { effects: ["read"], trustTier: "in-process" },
    });
    const result = evaluateEscalationRules(rules, ctx);
    expect(result).toBeDefined();
    expect(result!.action).toBe("trigger-eaa");
  });

  // First match wins
  it("returns the first matching rule when multiple match", () => {
    const rules: EscalationRule[] = [
      {
        condition: { kind: "frequency-exceeds", maxPerHour: 3 },
        action: "require-co",
        description: "First rule.",
      },
      {
        condition: { kind: "frequency-exceeds", maxPerHour: 5 },
        action: "refuse",
        description: "Second rule.",
      },
    ];
    const ctx = createEscalationContext({ recentInvocationCount: 10 });
    const result = evaluateEscalationRules(rules, ctx);
    expect(result).toBeDefined();
    expect(result!.action).toBe("require-co");
    expect(result!.description).toBe("First rule.");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SYSTEM_POLICIES
// ---------------------------------------------------------------------------

describe("DEFAULT_SYSTEM_POLICIES", () => {
  it("contains exactly 3 system policies", () => {
    expect(DEFAULT_SYSTEM_POLICIES).toHaveLength(3);
  });

  it("all policies have class=system and status=active", () => {
    for (const policy of DEFAULT_SYSTEM_POLICIES) {
      expect(policy.class).toBe("system");
      expect(policy.status).toBe("active");
    }
  });

  it("all policies pass isFullStandingPolicy check", () => {
    for (const policy of DEFAULT_SYSTEM_POLICIES) {
      expect(isFullStandingPolicy(policy)).toBe(true);
    }
  });

  it("all policies have provenance.author=system", () => {
    for (const policy of DEFAULT_SYSTEM_POLICIES) {
      expect(policy.provenance.author).toBe("system");
    }
  });

  // Read/compose baseline
  describe("system-policy-read-compose", () => {
    const policy = DEFAULT_SYSTEM_POLICIES.find((p) => p.id === "system-policy-read-compose");

    it("exists", () => {
      expect(policy).toBeDefined();
    });

    it("grants read and compose effects", () => {
      expect(policy!.effectScope).toContain("read");
      expect(policy!.effectScope).toContain("compose");
    });

    it("has empty applicability (universal)", () => {
      expect(Object.keys(policy!.applicability)).toHaveLength(0);
    });

    it("has no escalation rules", () => {
      expect(policy!.escalationRules).toHaveLength(0);
    });
  });

  // Physical-EAA escalation
  describe("system-policy-no-physical-without-eaa", () => {
    const policy = DEFAULT_SYSTEM_POLICIES.find(
      (p) => p.id === "system-policy-no-physical-without-eaa",
    );

    it("exists", () => {
      expect(policy).toBeDefined();
    });

    it("scopes to physical effects", () => {
      expect(policy!.effectScope).toEqual(["physical"]);
    });

    it("has an escalation rule that triggers EAA for physical effects", () => {
      expect(policy!.escalationRules).toHaveLength(1);
      const rule = policy!.escalationRules[0];
      expect(rule.action).toBe("trigger-eaa");
      expect(rule.condition.kind).toBe("effect-combination");
      if (rule.condition.kind === "effect-combination") {
        expect(rule.condition.effects).toContain("physical");
      }
    });

    it("escalation fires for physical tool profile", () => {
      const ctx = createEscalationContext({
        toolProfile: { effects: ["physical"], trustTier: "in-process" },
      });
      const result = evaluateEscalationRules(policy!.escalationRules, ctx);
      expect(result).toBeDefined();
      expect(result!.action).toBe("trigger-eaa");
    });

    it("escalation does not fire for non-physical tool profile", () => {
      const ctx = createEscalationContext({
        toolProfile: { effects: ["persist", "read"], trustTier: "in-process" },
      });
      const result = evaluateEscalationRules(policy!.escalationRules, ctx);
      expect(result).toBeUndefined();
    });
  });

  // Elevated-owner restriction
  describe("system-policy-no-elevated-from-non-owner", () => {
    const policy = DEFAULT_SYSTEM_POLICIES.find(
      (p) => p.id === "system-policy-no-elevated-from-non-owner",
    );

    it("exists", () => {
      expect(policy).toBeDefined();
    });

    it("scopes to elevated effects", () => {
      expect(policy!.effectScope).toEqual(["elevated"]);
    });

    it("requires owner", () => {
      expect(policy!.applicability.requireOwner).toBe(true);
    });

    it("has escalation rule that refuses for non-in-process tools", () => {
      expect(policy!.escalationRules).toHaveLength(1);
      const rule = policy!.escalationRules[0];
      expect(rule.action).toBe("refuse");
      expect(rule.condition.kind).toBe("trust-tier-below");
    });

    it("escalation fires for external trust tier", () => {
      const ctx = createEscalationContext({
        toolProfile: { effects: ["elevated"], trustTier: "external" },
      });
      const result = evaluateEscalationRules(policy!.escalationRules, ctx);
      expect(result).toBeDefined();
      expect(result!.action).toBe("refuse");
    });

    it("escalation fires for sandboxed trust tier", () => {
      const ctx = createEscalationContext({
        toolProfile: { effects: ["elevated"], trustTier: "sandboxed" },
      });
      const result = evaluateEscalationRules(policy!.escalationRules, ctx);
      expect(result).toBeDefined();
      expect(result!.action).toBe("refuse");
    });

    it("escalation does not fire for in-process trust tier", () => {
      const ctx = createEscalationContext({
        toolProfile: { effects: ["elevated"], trustTier: "in-process" },
      });
      const result = evaluateEscalationRules(policy!.escalationRules, ctx);
      expect(result).toBeUndefined();
    });

    it("policy only applies to owner-initiated requests", () => {
      const ownerCtx = createTestContext({ senderIsOwner: true });
      const nonOwnerCtx = createTestContext({ senderIsOwner: false });

      const ownerResult = filterApplicablePolicies([policy!], ownerCtx);
      const nonOwnerResult = filterApplicablePolicies([policy!], nonOwnerCtx);

      expect(ownerResult).toHaveLength(1);
      expect(nonOwnerResult).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// matchesApplicability (via __testing)
// ---------------------------------------------------------------------------

describe("matchesApplicability", () => {
  it("matches empty predicate against any context", () => {
    const result = __testing.matchesApplicability({}, { senderId: "any", senderIsOwner: false });
    expect(result).toBe(true);
  });

  it("matches empty arrays as no-op filters", () => {
    const result = __testing.matchesApplicability(
      { channels: [], chatTypes: [], senderIds: [], toolNames: [] },
      { senderId: "any", senderIsOwner: false },
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesEscalationCondition (via __testing)
// ---------------------------------------------------------------------------

describe("matchesEscalationCondition", () => {
  it("effect-combination requires all effects", () => {
    const effects: EffectClass[] = ["persist", "irreversible"];
    const condition = { kind: "effect-combination" as const, effects };

    const allPresent = createEscalationContext({
      toolProfile: { effects: ["persist", "irreversible", "read"] },
    });
    const partialPresent = createEscalationContext({
      toolProfile: { effects: ["persist", "read"] },
    });

    expect(__testing.matchesEscalationCondition(condition, allPresent)).toBe(true);
    expect(__testing.matchesEscalationCondition(condition, partialPresent)).toBe(false);
  });

  it("trust-tier-below with external tool against in-process requirement", () => {
    const condition = { kind: "trust-tier-below" as const, tier: "in-process" as const };

    const external = createEscalationContext({
      toolProfile: { effects: ["read"], trustTier: "external" },
    });
    const inProcess = createEscalationContext({
      toolProfile: { effects: ["read"], trustTier: "in-process" },
    });

    expect(__testing.matchesEscalationCondition(condition, external)).toBe(true);
    expect(__testing.matchesEscalationCondition(condition, inProcess)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPolicyEmbeddingText
// ---------------------------------------------------------------------------

describe("buildPolicyEmbeddingText", () => {
  it("produces [effects: ...] prefix followed by description", () => {
    const policy = createTestPolicy({
      effectScope: ["read", "persist"],
      description: "Allow file read and write operations.",
    });
    expect(buildPolicyEmbeddingText(policy)).toBe(
      "[effects: read, persist] Allow file read and write operations.",
    );
  });

  it("handles single effect", () => {
    const policy = createTestPolicy({
      effectScope: ["compose"],
      description: "Draft messages.",
    });
    expect(buildPolicyEmbeddingText(policy)).toBe("[effects: compose] Draft messages.");
  });

  it("handles empty effectScope gracefully", () => {
    const policy = createTestPolicy({
      effectScope: [],
      description: "Universal baseline policy.",
    });
    expect(buildPolicyEmbeddingText(policy)).toBe("Universal baseline policy.");
  });

  it("preserves full description text including punctuation", () => {
    const policy = createTestPolicy({
      effectScope: ["network", "exec"],
      description: "Run external API calls for weather data (read-only, rate-limited).",
    });
    expect(buildPolicyEmbeddingText(policy)).toBe(
      "[effects: network, exec] Run external API calls for weather data (read-only, rate-limited).",
    );
  });

  it("works with system policies from DEFAULT_SYSTEM_POLICIES", () => {
    const systemPolicy = DEFAULT_SYSTEM_POLICIES[0];
    const result = buildPolicyEmbeddingText(systemPolicy);
    expect(result).toContain("[effects:");
    expect(result).toContain(systemPolicy.description);
  });
});

// ---------------------------------------------------------------------------
// buildContextEmbeddingText
// ---------------------------------------------------------------------------

describe("buildContextEmbeddingText", () => {
  it("produces [effects: ...] prefix with description", () => {
    const result = buildContextEmbeddingText({
      effects: ["read", "persist"],
      description: "Save user notes to disk",
    });
    expect(result).toBe("[effects: read, persist] Save user notes to disk");
  });

  it("appends tool name with 'using' prefix", () => {
    const result = buildContextEmbeddingText({
      effects: ["read", "persist"],
      description: "Save user notes to disk",
      toolName: "notes-tool",
    });
    expect(result).toBe("[effects: read, persist] Save user notes to disk using notes-tool");
  });

  it("handles tool name only (no description)", () => {
    const result = buildContextEmbeddingText({
      effects: ["network"],
      toolName: "weather-api",
    });
    expect(result).toBe("[effects: network] using weather-api");
  });

  it("handles empty effects", () => {
    const result = buildContextEmbeddingText({
      effects: [],
      description: "General operation",
    });
    expect(result).toBe("General operation");
  });

  it("handles no description and no tool name", () => {
    const result = buildContextEmbeddingText({
      effects: ["compose", "persist"],
    });
    expect(result).toBe("[effects: compose, persist]");
  });

  it("handles all empty inputs", () => {
    const result = buildContextEmbeddingText({ effects: [] });
    expect(result).toBe("");
  });

  it("produces text that mirrors buildPolicyEmbeddingText format for comparable embeddings", () => {
    const policy = createTestPolicy({
      effectScope: ["read", "persist"],
      description: "Allow file read and write operations.",
    });
    const policyText = buildPolicyEmbeddingText(policy);

    const contextText = buildContextEmbeddingText({
      effects: ["read", "persist"],
      description: "Allow file read and write operations.",
    });

    // Both should have the same [effects: ...] prefix format
    expect(policyText.startsWith("[effects: read, persist]")).toBe(true);
    expect(contextText.startsWith("[effects: read, persist]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordAndCheckUsage
// ---------------------------------------------------------------------------

describe("recordAndCheckUsage", () => {
  function makeStore(counts: Record<string, number> = {}) {
    const recorded: { policyId: string; woId: string }[] = [];
    return {
      store: {
        recordPolicyUsage(policyId: string, woId: string) {
          recorded.push({ policyId, woId });
          counts[policyId] = (counts[policyId] ?? 0) + 1;
        },
        getPolicyUsageCount(policyId: string) {
          return counts[policyId] ?? 0;
        },
      },
      recorded,
    };
  }

  it("returns true when no maxUses is set", () => {
    const { store } = makeStore();
    const policy = createTestPolicy({
      id: "pol-unlimited",
      expiry: { currentUses: 0 },
    });

    const result = recordAndCheckUsage(policy, "wo-1", store);
    expect(result).toBe(true);
  });

  it("returns true when usage count is within maxUses", () => {
    const { store } = makeStore({ "pol-limited": 2 });
    const policy = createTestPolicy({
      id: "pol-limited",
      expiry: { maxUses: 5, currentUses: 2 },
    });

    const result = recordAndCheckUsage(policy, "wo-1", store);
    expect(result).toBe(true);
  });

  it("returns false when usage count exceeds maxUses", () => {
    const { store } = makeStore({ "pol-exhausted": 4 });
    const policy = createTestPolicy({
      id: "pol-exhausted",
      expiry: { maxUses: 5, currentUses: 4 },
    });

    const result = recordAndCheckUsage(policy, "wo-1", store);
    // After recording, count is 5. maxUses is 5. 5 <= 5 is true.
    expect(result).toBe(true);

    // One more use puts it over
    const result2 = recordAndCheckUsage(policy, "wo-2", store);
    // After recording, count is 6. maxUses is 5. 6 <= 5 is false.
    expect(result2).toBe(false);
  });

  it("records the policy-WO association in the store", () => {
    const { store, recorded } = makeStore();
    const policy = createTestPolicy({ id: "pol-track" });

    recordAndCheckUsage(policy, "wo-abc", store);

    expect(recorded).toEqual([{ policyId: "pol-track", woId: "wo-abc" }]);
  });
});

// ---------------------------------------------------------------------------
// deriveTrustTier (Phase 5f)
// ---------------------------------------------------------------------------

describe("deriveTrustTier", () => {
  it("returns explicit tier when provided", () => {
    expect(deriveTrustTier("external", "bundled")).toBe("external");
    expect(deriveTrustTier("in-process", "mcp")).toBe("in-process");
    expect(deriveTrustTier("sandboxed", "npm")).toBe("sandboxed");
  });

  it("derives in-process for bundled source", () => {
    expect(deriveTrustTier(undefined, "bundled")).toBe("in-process");
  });

  it("derives sandboxed for npm source", () => {
    expect(deriveTrustTier(undefined, "npm")).toBe("sandboxed");
  });

  it("derives external for mcp source", () => {
    expect(deriveTrustTier(undefined, "mcp")).toBe("external");
  });

  it("derives sandboxed for unknown source (conservative default)", () => {
    expect(deriveTrustTier(undefined, "unknown")).toBe("sandboxed");
  });
});
