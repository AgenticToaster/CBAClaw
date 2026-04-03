import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PolicyEmbedder } from "./binder.js";
import type { ConsentRecordStore } from "./consent-store.js";
import {
  analyzeForPolicyProposals,
  checkCOForPolicyPromotion,
  createSelfMintedPolicy,
  __testing,
} from "./policy-proposal.js";
import type { PolicyProposal } from "./policy-proposal.js";
import type { PolicyStore } from "./policy-store.js";
import type { StandingPolicy } from "./policy.js";
import type { ConsentRecord, EffectClass } from "./types.js";

const { HIGH_RISK_EFFECTS, groupByEffectSet, buildRationale, buildProposalDescription } = __testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeRecord(
  overrides: Partial<ConsentRecord> & { effectClasses: EffectClass[] },
): ConsentRecord {
  return {
    id: randomUUID(),
    poId: "po-1",
    woId: "wo-1",
    decision: "granted",
    timestamp: NOW - 1000,
    ...overrides,
  };
}

function makePolicy(overrides: Partial<StandingPolicy> = {}): StandingPolicy {
  return {
    id: overrides.id ?? `pol-${randomUUID()}`,
    class: "user",
    effectScope: ["read"],
    applicability: {},
    escalationRules: [],
    expiry: { currentUses: 0 },
    revocationSemantics: "immediate",
    provenance: { author: "user:test", createdAt: NOW },
    description: "Test policy",
    status: "active",
    ...overrides,
  };
}

function mockConsentRecordStore(records: ConsentRecord[]): ConsentRecordStore {
  return {
    insertConsentRecord: vi.fn(),
    getConsentRecord: vi.fn(),
    getConsentRecordsByPO: vi.fn(() => []),
    getConsentRecordsByDecision: vi.fn((decision: string) =>
      records.filter((r) => r.decision === decision),
    ),
    getAllConsentRecords: vi.fn(() => records),
    updateConsentDecision: vi.fn(),
    findConsentPrecedent: vi.fn(),
    findSimilarConsentPrecedent: vi.fn(),
    upsertConsentEmbedding: vi.fn(),
    insertEAARecord: vi.fn(),
    getEAARecord: vi.fn(),
    getAllEAARecords: vi.fn(() => []),
    clearAll: vi.fn(),
    close: vi.fn(),
  } as unknown as ConsentRecordStore;
}

type MockPolicyStore = PolicyStore & {
  _insertPolicy: ReturnType<typeof vi.fn>;
  _upsertPolicyEmbedding: ReturnType<typeof vi.fn>;
  _findSimilarPolicies: ReturnType<typeof vi.fn>;
};

function mockPolicyStore(
  existingPolicies: StandingPolicy[] = [],
  similarResults: Array<{ policy: StandingPolicy; distance: number }> = [],
): MockPolicyStore {
  const insertPolicy = vi.fn();
  const upsertPolicyEmbedding = vi.fn();
  const findSimilarPolicies = vi.fn(() => similarResults);
  return {
    insertPolicy,
    getPolicy: vi.fn((id: string) => existingPolicies.find((p) => p.id === id)),
    getActivePolicies: vi.fn(() => existingPolicies.filter((p) => p.status === "active")),
    getActivePoliciesByClass: vi.fn(),
    updatePolicyStatus: vi.fn(() => true),
    confirmPolicy: vi.fn(() => true),
    recordPolicyUsage: vi.fn(),
    getPolicyUsageCount: vi.fn(() => 0),
    expireStalePolicies: vi.fn(() => 0),
    upsertPolicyEmbedding,
    deletePolicyEmbedding: vi.fn(),
    findSimilarPolicies,
    clearAll: vi.fn(),
    close: vi.fn(),
    db: {} as never,
    _insertPolicy: insertPolicy,
    _upsertPolicyEmbedding: upsertPolicyEmbedding,
    _findSimilarPolicies: findSimilarPolicies,
  };
}

const mockEmbedder: PolicyEmbedder = vi.fn(async () => new Float32Array(4));

// ---------------------------------------------------------------------------
// groupByEffectSet
// ---------------------------------------------------------------------------

describe("groupByEffectSet", () => {
  it("groups records by sorted effect key within cutoff", () => {
    const records = [
      makeRecord({ effectClasses: ["persist", "read"], timestamp: NOW - 500 }),
      makeRecord({ effectClasses: ["read", "persist"], timestamp: NOW - 600 }),
      makeRecord({ effectClasses: ["compose"], timestamp: NOW - 700 }),
    ];
    const cutoff = NOW - 10_000;
    const groups = groupByEffectSet(records, cutoff);
    expect(groups.size).toBe(2);
    expect(groups.get("persist,read")).toHaveLength(2);
    expect(groups.get("compose")).toHaveLength(1);
  });

  it("excludes records before cutoff", () => {
    const records = [
      makeRecord({ effectClasses: ["read"], timestamp: NOW - 100 }),
      makeRecord({ effectClasses: ["read"], timestamp: NOW - 50_000 }),
    ];
    const groups = groupByEffectSet(records, NOW - 10_000);
    expect(groups.get("read")).toHaveLength(1);
  });

  it("excludes records with empty effect classes", () => {
    const records = [makeRecord({ effectClasses: [] as EffectClass[] })];
    const groups = groupByEffectSet(records, 0);
    expect(groups.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildProposalDescription
// ---------------------------------------------------------------------------

describe("buildProposalDescription", () => {
  it("builds description for safe effects only", () => {
    const desc = buildProposalDescription(["read", "persist"], [], 5);
    expect(desc).toContain("read, persist");
    expect(desc).toContain("5 repeated grants");
    expect(desc).not.toContain("High-risk");
  });

  it("includes high-risk warning when risky effects present", () => {
    const desc = buildProposalDescription(["read"], ["exec"], 3);
    expect(desc).toContain("High-risk effects [exec]");
    expect(desc).toContain("EAA escalation");
  });
});

// ---------------------------------------------------------------------------
// buildRationale
// ---------------------------------------------------------------------------

describe("buildRationale", () => {
  it("builds rationale with overlap info", () => {
    const overlapping = [{ policy: makePolicy({ id: "pol-overlap" }), distance: 0.2 }];
    const rationale = buildRationale(["read", "persist"], 4, 7 * 24 * 60 * 60 * 1000, overlapping);
    expect(rationale).toContain("granted 4 times");
    expect(rationale).toContain("7 day(s)");
    expect(rationale).toContain("pol-overlap");
  });

  it("builds rationale without overlaps", () => {
    const rationale = buildRationale(["compose"], 3, 24 * 60 * 60 * 1000, []);
    expect(rationale).toContain("granted 3 times");
    expect(rationale).not.toContain("overlap");
  });
});

// ---------------------------------------------------------------------------
// analyzeForPolicyProposals
// ---------------------------------------------------------------------------

describe("analyzeForPolicyProposals", () => {
  it("proposes policy when effect set appears >= minRepetitions", async () => {
    const records = Array.from({ length: 4 }, () =>
      makeRecord({ effectClasses: ["read", "persist"], timestamp: NOW - 1000 }),
    );
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore();

    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      minRepetitions: 3,
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(1);
    expect(proposals[0].suggestedPolicy.effectScope).toEqual(
      expect.arrayContaining(["persist", "read"]),
    );
    expect(proposals[0].suggestedPolicy.status).toBe("pending-confirmation");
    expect(proposals[0].suggestedPolicy.class).toBe("self-minted");
    expect(proposals[0].evidenceRecordIds).toHaveLength(4);
  });

  it("does not propose when below minRepetitions", async () => {
    const records = [
      makeRecord({ effectClasses: ["read"], timestamp: NOW - 500 }),
      makeRecord({ effectClasses: ["read"], timestamp: NOW - 600 }),
    ];
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore();

    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      minRepetitions: 3,
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(0);
  });

  it("skips groups where all effects are high-risk", async () => {
    const records = Array.from({ length: 5 }, () =>
      makeRecord({ effectClasses: ["exec", "physical"], timestamp: NOW - 500 }),
    );
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore();

    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      minRepetitions: 3,
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(0);
  });

  it("adds escalation rules for high-risk effects in mixed sets", async () => {
    const records = Array.from({ length: 3 }, () =>
      makeRecord({ effectClasses: ["read", "exec"], timestamp: NOW - 500 }),
    );
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore();

    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      minRepetitions: 3,
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(1);
    const policy = proposals[0].suggestedPolicy;
    expect(policy.escalationRules).toHaveLength(1);
    expect(policy.escalationRules[0].action).toBe("trigger-eaa");
    expect(policy.escalationRules[0].condition).toEqual({
      kind: "effect-combination",
      effects: ["exec"],
    });
  });

  it("scopes policy to channel when provided", async () => {
    const records = Array.from({ length: 3 }, () =>
      makeRecord({ effectClasses: ["persist"], timestamp: NOW - 500 }),
    );
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore();

    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      minRepetitions: 3,
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
      channel: "telegram",
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(1);
    expect(proposals[0].suggestedPolicy.applicability.channels).toEqual(["telegram"]);
  });

  it("sets maxExpiryMs and maxUses from params", async () => {
    const records = Array.from({ length: 3 }, () =>
      makeRecord({ effectClasses: ["compose"], timestamp: NOW - 500 }),
    );
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore();

    const maxExpiryMs = 7 * 24 * 60 * 60 * 1000;
    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      minRepetitions: 3,
      lookbackMs: 14 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
      maxExpiryMs,
      maxUses: 50,
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(1);
    const expiry = proposals[0].suggestedPolicy.expiry;
    expect(expiry.expiresAt).toBe(NOW + maxExpiryMs);
    expect(expiry.maxUses).toBe(50);
  });

  it("includes overlapping policies from semantic search", async () => {
    const existingPolicy = makePolicy({ id: "pol-existing", effectScope: ["persist"] });
    const records = Array.from({ length: 3 }, () =>
      makeRecord({ effectClasses: ["persist"], timestamp: NOW - 500 }),
    );
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore(
      [existingPolicy],
      [{ policy: existingPolicy, distance: 0.15 }],
    );

    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      embedder: mockEmbedder,
      minRepetitions: 3,
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(1);
    expect(proposals[0].overlappingPolicies).toHaveLength(1);
    expect(proposals[0].overlappingPolicies[0].policy.id).toBe("pol-existing");
    expect(proposals[0].rationale).toContain("pol-existing");
  });

  it("returns empty overlaps when no embedder is provided", async () => {
    const records = Array.from({ length: 3 }, () =>
      makeRecord({ effectClasses: ["persist"], timestamp: NOW - 500 }),
    );
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore();

    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      minRepetitions: 3,
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(1);
    expect(proposals[0].overlappingPolicies).toHaveLength(0);
  });

  it("handles multiple qualifying groups", async () => {
    const records = [
      ...Array.from({ length: 3 }, () =>
        makeRecord({ effectClasses: ["read"], timestamp: NOW - 500 }),
      ),
      ...Array.from({ length: 4 }, () =>
        makeRecord({ effectClasses: ["persist"], timestamp: NOW - 600 }),
      ),
    ];
    const store = mockConsentRecordStore(records);
    const policyStore = mockPolicyStore();

    vi.setSystemTime(NOW);
    const proposals = await analyzeForPolicyProposals({
      consentRecordStore: store,
      policyStore,
      minRepetitions: 3,
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      agentId: "agent-1",
    });
    vi.useRealTimers();

    expect(proposals).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createSelfMintedPolicy
// ---------------------------------------------------------------------------

describe("createSelfMintedPolicy", () => {
  it("persists the policy to the store", async () => {
    const policyStore = mockPolicyStore();
    const proposal: PolicyProposal = {
      suggestedPolicy: makePolicy({
        id: "new-self-minted",
        class: "self-minted",
        status: "pending-confirmation",
      }) as unknown as StandingPolicy,
      evidenceRecordIds: ["rec-1", "rec-2"],
      rationale: "Repeated pattern",
      overlappingPolicies: [],
    };
    // Ensure it's truly pending-confirmation
    proposal.suggestedPolicy = { ...proposal.suggestedPolicy, status: "pending-confirmation" };

    const result = await createSelfMintedPolicy(proposal, policyStore);
    expect(result.id).toBe("new-self-minted");
    expect(policyStore._insertPolicy).toHaveBeenCalledWith(proposal.suggestedPolicy);
  });

  it("stores embedding when embedder is provided", async () => {
    const policyStore = mockPolicyStore();
    const proposal: PolicyProposal = {
      suggestedPolicy: makePolicy({
        id: "embed-test",
        class: "self-minted",
        status: "pending-confirmation",
      }),
      evidenceRecordIds: [],
      rationale: "Test",
      overlappingPolicies: [],
    };

    await createSelfMintedPolicy(proposal, policyStore, mockEmbedder);
    expect(policyStore._upsertPolicyEmbedding).toHaveBeenCalledWith(
      "embed-test",
      expect.any(Float32Array),
    );
  });

  it("throws when status is not pending-confirmation", async () => {
    const policyStore = mockPolicyStore();
    const proposal: PolicyProposal = {
      suggestedPolicy: makePolicy({ id: "bad-status", status: "active" }),
      evidenceRecordIds: [],
      rationale: "Test",
      overlappingPolicies: [],
    };

    await expect(createSelfMintedPolicy(proposal, policyStore)).rejects.toThrow(
      "pending-confirmation",
    );
  });
});

// ---------------------------------------------------------------------------
// checkCOForPolicyPromotion
// ---------------------------------------------------------------------------

describe("checkCOForPolicyPromotion", () => {
  it("returns shouldPromote=true when no similar policy exists", async () => {
    const policyStore = mockPolicyStore([], []);

    const result = await checkCOForPolicyPromotion({
      coEffectDescription: "Save user notes",
      coEffects: ["persist"],
      policyStore,
      embedder: mockEmbedder,
    });

    expect(result.shouldPromote).toBe(true);
    expect(result.existingMatch).toBeUndefined();
  });

  it("returns shouldPromote=false with existingMatch when similar policy found", async () => {
    const existingPolicy = makePolicy({ id: "pol-notes", effectScope: ["persist"] });
    const policyStore = mockPolicyStore(
      [existingPolicy],
      [{ policy: existingPolicy, distance: 0.15 }],
    );

    const result = await checkCOForPolicyPromotion({
      coEffectDescription: "Save user notes to disk",
      coEffects: ["persist"],
      policyStore,
      embedder: mockEmbedder,
    });

    expect(result.shouldPromote).toBe(false);
    expect(result.existingMatch?.policy.id).toBe("pol-notes");
    expect(result.existingMatch?.distance).toBe(0.15);
  });

  it("respects custom threshold", async () => {
    const policyStore = mockPolicyStore([], []);

    const result = await checkCOForPolicyPromotion({
      coEffectDescription: "Test",
      coEffects: ["read"],
      policyStore,
      embedder: mockEmbedder,
      threshold: 0.8,
    });

    expect(policyStore._findSimilarPolicies).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 0.8 }),
    );
    expect(result.shouldPromote).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HIGH_RISK_EFFECTS constant
// ---------------------------------------------------------------------------

describe("HIGH_RISK_EFFECTS", () => {
  it("contains the documented high-risk effects", () => {
    expect(HIGH_RISK_EFFECTS.has("irreversible")).toBe(true);
    expect(HIGH_RISK_EFFECTS.has("elevated")).toBe(true);
    expect(HIGH_RISK_EFFECTS.has("disclose")).toBe(true);
    expect(HIGH_RISK_EFFECTS.has("audience-expand")).toBe(true);
    expect(HIGH_RISK_EFFECTS.has("exec")).toBe(true);
    expect(HIGH_RISK_EFFECTS.has("physical")).toBe(true);
  });

  it("does not include safe effects", () => {
    expect(HIGH_RISK_EFFECTS.has("read")).toBe(false);
    expect(HIGH_RISK_EFFECTS.has("compose")).toBe(false);
    expect(HIGH_RISK_EFFECTS.has("persist")).toBe(false);
  });
});
