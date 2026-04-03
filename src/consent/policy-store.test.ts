import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPolicyStore, type PolicyStore } from "./policy-store.js";
import type { StandingPolicy } from "./policy.js";

let store: PolicyStore;

function createTestPolicy(overrides?: Partial<StandingPolicy>): StandingPolicy {
  return {
    id: `pol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    class: "user",
    effectScope: ["persist", "network"],
    applicability: {},
    escalationRules: [],
    expiry: { currentUses: 0 },
    revocationSemantics: "immediate",
    provenance: { author: "user-1", createdAt: Date.now() },
    description: "Test user policy for persist and network effects.",
    status: "active",
    ...overrides,
  };
}

beforeEach(async () => {
  const db = new DatabaseSync(":memory:");
  store = await openPolicyStore({
    dbPath: ":memory:",
    injectedDb: db,
    skipVecExtension: true,
  });
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

describe("policy CRUD", () => {
  it("inserts and retrieves a policy", () => {
    const policy = createTestPolicy({ id: "pol-1" });
    store.insertPolicy(policy);

    const retrieved = store.getPolicy("pol-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("pol-1");
    expect(retrieved!.class).toBe("user");
    expect(retrieved!.effectScope).toEqual(["persist", "network"]);
    expect(retrieved!.description).toBe("Test user policy for persist and network effects.");
    expect(retrieved!.status).toBe("active");
    expect(retrieved!.revocationSemantics).toBe("immediate");
  });

  it("returns undefined for non-existent policy", () => {
    expect(store.getPolicy("nonexistent")).toBeUndefined();
  });

  it("throws on duplicate insert (PRIMARY KEY constraint)", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-dup-pk" }));
    expect(() => store.insertPolicy(createTestPolicy({ id: "pol-dup-pk" }))).toThrow();
  });

  it("preserves applicability predicate through serialization", () => {
    const policy = createTestPolicy({
      id: "pol-ap",
      applicability: {
        channels: ["telegram", "discord"],
        chatTypes: ["dm"],
        senderIds: ["user-42"],
        requireOwner: true,
        timeWindow: { startHour: 9, endHour: 17 },
        toolNames: ["file-write"],
        minTrustTier: "sandboxed",
      },
    });
    store.insertPolicy(policy);

    const retrieved = store.getPolicy("pol-ap")!;
    expect(retrieved.applicability.channels).toEqual(["telegram", "discord"]);
    expect(retrieved.applicability.chatTypes).toEqual(["dm"]);
    expect(retrieved.applicability.senderIds).toEqual(["user-42"]);
    expect(retrieved.applicability.requireOwner).toBe(true);
    expect(retrieved.applicability.timeWindow).toEqual({ startHour: 9, endHour: 17 });
    expect(retrieved.applicability.toolNames).toEqual(["file-write"]);
    expect(retrieved.applicability.minTrustTier).toBe("sandboxed");
  });

  it("preserves provenance through serialization", () => {
    const policy = createTestPolicy({
      id: "pol-prov",
      provenance: {
        author: "agent:a1",
        createdAt: 1_700_000_000_000,
        confirmedAt: 1_700_000_001_000,
        sourceRef: "co-42",
      },
    });
    store.insertPolicy(policy);

    const retrieved = store.getPolicy("pol-prov")!;
    expect(retrieved.provenance.author).toBe("agent:a1");
    expect(retrieved.provenance.createdAt).toBe(1_700_000_000_000);
    expect(retrieved.provenance.confirmedAt).toBe(1_700_000_001_000);
    expect(retrieved.provenance.sourceRef).toBe("co-42");
  });

  it("preserves expiry fields through serialization", () => {
    const policy = createTestPolicy({
      id: "pol-exp",
      expiry: { expiresAt: 1_800_000_000_000, maxUses: 50, currentUses: 0 },
    });
    store.insertPolicy(policy);

    const retrieved = store.getPolicy("pol-exp")!;
    expect(retrieved.expiry.expiresAt).toBe(1_800_000_000_000);
    expect(retrieved.expiry.maxUses).toBe(50);
    // currentUses comes from the usage table, not the JSON
    expect(retrieved.expiry.currentUses).toBe(0);
  });

  it("preserves revocationSemantics: after-current-slice", () => {
    const policy = createTestPolicy({
      id: "pol-rev",
      revocationSemantics: "after-current-slice",
    });
    store.insertPolicy(policy);
    expect(store.getPolicy("pol-rev")!.revocationSemantics).toBe("after-current-slice");
  });
});

// ---------------------------------------------------------------------------
// Escalation rule serialization
// ---------------------------------------------------------------------------

describe("escalation rule serialization", () => {
  it("persists standard escalation conditions", () => {
    const policy = createTestPolicy({
      id: "pol-esc",
      escalationRules: [
        {
          condition: { kind: "effect-combination", effects: ["persist", "irreversible"] },
          action: "trigger-eaa",
          description: "Combined persist+irreversible requires EAA.",
        },
        {
          condition: { kind: "trust-tier-below", tier: "sandboxed" },
          action: "refuse",
          description: "External tools cannot use this policy.",
        },
        {
          condition: { kind: "audience-exceeds", maxRecipients: 10 },
          action: "require-co",
          description: "Large audiences need CO.",
        },
        {
          condition: { kind: "frequency-exceeds", maxPerHour: 100 },
          action: "require-co",
          description: "Rate limit exceeded.",
        },
      ],
    });
    store.insertPolicy(policy);

    const retrieved = store.getPolicy("pol-esc")!;
    expect(retrieved.escalationRules).toHaveLength(4);
    expect(retrieved.escalationRules[0].condition.kind).toBe("effect-combination");
    expect(retrieved.escalationRules[1].condition.kind).toBe("trust-tier-below");
    expect(retrieved.escalationRules[2].condition.kind).toBe("audience-exceeds");
    expect(retrieved.escalationRules[3].condition.kind).toBe("frequency-exceeds");
  });

  it("strips custom escalation conditions on write", () => {
    const policy = createTestPolicy({
      id: "pol-custom",
      escalationRules: [
        {
          condition: { kind: "effect-combination", effects: ["read"] },
          action: "require-co",
          description: "Standard rule.",
        },
        {
          condition: { kind: "custom", label: "test-custom", evaluate: () => true },
          action: "trigger-eaa",
          description: "Custom rule (should be stripped).",
        },
      ],
    });
    store.insertPolicy(policy);

    const retrieved = store.getPolicy("pol-custom")!;
    expect(retrieved.escalationRules).toHaveLength(1);
    expect(retrieved.escalationRules[0].condition.kind).toBe("effect-combination");
  });
});

// ---------------------------------------------------------------------------
// Active policy queries
// ---------------------------------------------------------------------------

describe("active policy queries", () => {
  it("returns only active policies", () => {
    store.insertPolicy(createTestPolicy({ id: "active-1", status: "active" }));
    store.insertPolicy(createTestPolicy({ id: "pending-1", status: "pending-confirmation" }));
    store.insertPolicy(createTestPolicy({ id: "revoked-1", status: "revoked" }));
    store.insertPolicy(createTestPolicy({ id: "active-2", status: "active" }));

    const active = store.getActivePolicies();
    expect(active).toHaveLength(2);
    expect(active.map((p) => p.id).toSorted()).toEqual(["active-1", "active-2"]);
  });

  it("filters active policies by class", () => {
    store.insertPolicy(createTestPolicy({ id: "user-1", class: "user" }));
    store.insertPolicy(createTestPolicy({ id: "system-1", class: "system" }));
    store.insertPolicy(createTestPolicy({ id: "user-2", class: "user" }));
    store.insertPolicy(
      createTestPolicy({ id: "self-1", class: "self-minted", status: "pending-confirmation" }),
    );

    const userPolicies = store.getActivePoliciesByClass("user");
    expect(userPolicies).toHaveLength(2);
    expect(userPolicies.every((p) => p.class === "user")).toBe(true);

    const systemPolicies = store.getActivePoliciesByClass("system");
    expect(systemPolicies).toHaveLength(1);
    expect(systemPolicies[0].id).toBe("system-1");

    // self-minted is pending-confirmation, not active
    const selfMinted = store.getActivePoliciesByClass("self-minted");
    expect(selfMinted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------

describe("status updates", () => {
  it("updates policy status", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-1", status: "active" }));

    const updated = store.updatePolicyStatus("pol-1", "revoked");
    expect(updated).toBe(true);
    expect(store.getPolicy("pol-1")!.status).toBe("revoked");
  });

  it("returns false for non-existent policy", () => {
    expect(store.updatePolicyStatus("nonexistent", "revoked")).toBe(false);
  });

  it("uses provided updatedAt timestamp", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-ts", status: "active" }));
    store.updatePolicyStatus("pol-ts", "expired", 1_700_000_099_000);

    const policy = store.getPolicy("pol-ts")!;
    expect(policy.status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// Policy confirmation
// ---------------------------------------------------------------------------

describe("confirmPolicy", () => {
  it("confirms a pending-confirmation policy", () => {
    store.insertPolicy(
      createTestPolicy({
        id: "pol-pending",
        class: "self-minted",
        status: "pending-confirmation",
        provenance: { author: "agent:a1", createdAt: 1_700_000_000_000 },
      }),
    );

    const confirmed = store.confirmPolicy("pol-pending", 1_700_000_005_000);
    expect(confirmed).toBe(true);

    const policy = store.getPolicy("pol-pending")!;
    expect(policy.status).toBe("active");
    expect(policy.provenance.confirmedAt).toBe(1_700_000_005_000);
  });

  it("returns false for non-existent policy", () => {
    expect(store.confirmPolicy("nonexistent")).toBe(false);
  });

  it("returns false for already active policy", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-active", status: "active" }));
    expect(store.confirmPolicy("pol-active")).toBe(false);
  });

  it("returns false for revoked policy", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-revoked", status: "revoked" }));
    expect(store.confirmPolicy("pol-revoked")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

describe("usage tracking", () => {
  it("records and counts usage", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-u" }));

    expect(store.getPolicyUsageCount("pol-u")).toBe(0);

    store.recordPolicyUsage("pol-u", "wo-1");
    expect(store.getPolicyUsageCount("pol-u")).toBe(1);

    store.recordPolicyUsage("pol-u", "wo-2");
    expect(store.getPolicyUsageCount("pol-u")).toBe(2);
  });

  it("does not double-count same policy+wo pair", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-dup" }));
    store.recordPolicyUsage("pol-dup", "wo-1");
    store.recordPolicyUsage("pol-dup", "wo-1");

    expect(store.getPolicyUsageCount("pol-dup")).toBe(1);
  });

  it("hydrates currentUses in retrieved policy", () => {
    store.insertPolicy(
      createTestPolicy({
        id: "pol-hydrate",
        expiry: { maxUses: 5, currentUses: 0 },
      }),
    );

    store.recordPolicyUsage("pol-hydrate", "wo-1");
    store.recordPolicyUsage("pol-hydrate", "wo-2");

    const policy = store.getPolicy("pol-hydrate")!;
    expect(policy.expiry.currentUses).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------

describe("expireStalePolicies", () => {
  it("expires policies past expiresAt", () => {
    const past = Date.now() - 10_000;
    store.insertPolicy(
      createTestPolicy({
        id: "pol-time-expired",
        expiry: { expiresAt: past, currentUses: 0 },
      }),
    );
    store.insertPolicy(
      createTestPolicy({
        id: "pol-still-valid",
        expiry: { expiresAt: Date.now() + 100_000, currentUses: 0 },
      }),
    );

    const count = store.expireStalePolicies();
    expect(count).toBe(1);
    expect(store.getPolicy("pol-time-expired")!.status).toBe("expired");
    expect(store.getPolicy("pol-still-valid")!.status).toBe("active");
  });

  it("expires policies that exceeded maxUses", () => {
    store.insertPolicy(
      createTestPolicy({
        id: "pol-maxed",
        expiry: { maxUses: 2, currentUses: 0 },
      }),
    );
    store.recordPolicyUsage("pol-maxed", "wo-1");
    store.recordPolicyUsage("pol-maxed", "wo-2");

    const count = store.expireStalePolicies();
    expect(count).toBe(1);
    expect(store.getPolicy("pol-maxed")!.status).toBe("expired");
  });

  it("returns 0 when no policies are stale", () => {
    store.insertPolicy(
      createTestPolicy({
        id: "pol-ok",
        expiry: { currentUses: 0 },
      }),
    );
    expect(store.expireStalePolicies()).toBe(0);
  });

  it("accepts a custom now timestamp", () => {
    const futureExpiry = 2_000_000_000_000;
    store.insertPolicy(
      createTestPolicy({
        id: "pol-future",
        expiry: { expiresAt: futureExpiry, currentUses: 0 },
      }),
    );

    // Before expiry
    expect(store.expireStalePolicies(futureExpiry - 1)).toBe(0);
    // At expiry
    expect(store.expireStalePolicies(futureExpiry)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Embedding operations (no-op when dim=0)
// ---------------------------------------------------------------------------

describe("embedding operations with dim=0", () => {
  it("upsertPolicyEmbedding is a no-op when embedding dim is 0", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-noemb" }));
    // Should not throw
    store.upsertPolicyEmbedding("pol-noemb", new Float32Array(384));
  });

  it("deletePolicyEmbedding is a no-op when embedding dim is 0", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-nodel" }));
    // Should not throw
    store.deletePolicyEmbedding("pol-nodel");
  });

  it("findSimilarPolicies returns empty when embedding dim is 0", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-nosearch" }));
    const results = store.findSimilarPolicies({
      embedding: new Float32Array(384),
    });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

describe("clearAll", () => {
  it("removes all policies and usage records", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-c1" }));
    store.insertPolicy(createTestPolicy({ id: "pol-c2" }));
    store.recordPolicyUsage("pol-c1", "wo-1");

    store.clearAll();

    expect(store.getPolicy("pol-c1")).toBeUndefined();
    expect(store.getPolicy("pol-c2")).toBeUndefined();
    expect(store.getPolicyUsageCount("pol-c1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple policy classes coexistence
// ---------------------------------------------------------------------------

describe("multi-class policies", () => {
  it("stores and retrieves all three policy classes", () => {
    store.insertPolicy(createTestPolicy({ id: "sys-1", class: "system" }));
    store.insertPolicy(createTestPolicy({ id: "usr-1", class: "user" }));
    store.insertPolicy(
      createTestPolicy({ id: "sm-1", class: "self-minted", status: "pending-confirmation" }),
    );

    expect(store.getPolicy("sys-1")!.class).toBe("system");
    expect(store.getPolicy("usr-1")!.class).toBe("user");
    expect(store.getPolicy("sm-1")!.class).toBe("self-minted");
    expect(store.getPolicy("sm-1")!.status).toBe("pending-confirmation");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty effectScope", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-empty", effectScope: [] }));
    expect(store.getPolicy("pol-empty")!.effectScope).toEqual([]);
  });

  it("handles empty applicability", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-univ", applicability: {} }));
    expect(store.getPolicy("pol-univ")!.applicability).toEqual({});
  });

  it("handles empty escalation rules", () => {
    store.insertPolicy(createTestPolicy({ id: "pol-noesc", escalationRules: [] }));
    expect(store.getPolicy("pol-noesc")!.escalationRules).toEqual([]);
  });

  it("handles policy with all effect classes", () => {
    const allEffects = [
      "read",
      "compose",
      "persist",
      "network",
      "exec",
      "irreversible",
      "disclose",
      "audience-expand",
      "elevated",
      "physical",
    ] as StandingPolicy["effectScope"];

    store.insertPolicy(createTestPolicy({ id: "pol-all", effectScope: allEffects }));
    expect(store.getPolicy("pol-all")!.effectScope).toEqual(allEffects);
  });

  it("close is idempotent", () => {
    store.close();
    // Should not throw on second close
    store.close();
  });
});
