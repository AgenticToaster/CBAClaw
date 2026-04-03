import { afterEach, describe, expect, it } from "vitest";
import type { ConsentEvent, ConsentEventType, WOMintedEvent } from "./events.js";
import {
  __testing,
  buildEventBase,
  emitBreachContained,
  emitBreachDetected,
  emitBreachRemediated,
  emitCODenied,
  emitCOExpired,
  emitCOGranted,
  emitCORequested,
  emitCOWithdrawn,
  emitConsentEvent,
  emitConsentGranted,
  emitConsentRevoked,
  emitConsentWithdrawn,
  emitEAACompleted,
  emitEAAStarted,
  emitEffectExecuted,
  emitPolicyApplied,
  emitPolicyConfirmed,
  emitPolicyEscalated,
  emitPolicyProposed,
  emitWOExpired,
  emitWOMinted,
  emitWOSuperseded,
  subscribeToConsentEvents,
  subscribeToEventType,
} from "./events.js";

afterEach(() => {
  __testing.clearAllListeners();
});

// ---------------------------------------------------------------------------
// Event Bus: Global Listeners
// ---------------------------------------------------------------------------

describe("subscribeToConsentEvents", () => {
  it("registers and invokes a global listener", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    const event = buildTestEvent("wo.minted");
    emitConsentEvent(event as ConsentEvent);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("wo.minted");
  });

  it("returns an unsubscribe function that removes the listener", () => {
    const received: ConsentEvent[] = [];
    const unsub = subscribeToConsentEvents((e) => received.push(e));

    emitConsentEvent(buildTestEvent("wo.minted") as ConsentEvent);
    expect(received).toHaveLength(1);

    unsub();

    emitConsentEvent(buildTestEvent("wo.expired") as ConsentEvent);
    expect(received).toHaveLength(1);
  });

  it("supports multiple global listeners", () => {
    const received1: ConsentEvent[] = [];
    const received2: ConsentEvent[] = [];

    subscribeToConsentEvents((e) => received1.push(e));
    subscribeToConsentEvents((e) => received2.push(e));

    emitConsentEvent(buildTestEvent("co.requested") as ConsentEvent);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it("catches and logs listener exceptions without propagating", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents(() => {
      throw new Error("listener boom");
    });
    subscribeToConsentEvents((e) => received.push(e));

    expect(() => emitConsentEvent(buildTestEvent("wo.minted") as ConsentEvent)).not.toThrow();
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Event Bus: Typed Listeners
// ---------------------------------------------------------------------------

describe("subscribeToEventType", () => {
  it("receives only events of the subscribed type", () => {
    const woMinted: ConsentEvent[] = [];
    const coRequested: ConsentEvent[] = [];

    subscribeToEventType("wo.minted", (e) => woMinted.push(e));
    subscribeToEventType("co.requested", (e) => coRequested.push(e));

    emitConsentEvent(buildTestEvent("wo.minted") as ConsentEvent);
    emitConsentEvent(buildTestEvent("co.requested") as ConsentEvent);
    emitConsentEvent(buildTestEvent("wo.expired") as ConsentEvent);

    expect(woMinted).toHaveLength(1);
    expect(woMinted[0].type).toBe("wo.minted");
    expect(coRequested).toHaveLength(1);
    expect(coRequested[0].type).toBe("co.requested");
  });

  it("returns an unsubscribe function", () => {
    const received: ConsentEvent[] = [];
    const unsub = subscribeToEventType("eaa.started", (e) => received.push(e));

    emitConsentEvent(buildTestEvent("eaa.started") as ConsentEvent);
    expect(received).toHaveLength(1);

    unsub();
    emitConsentEvent(buildTestEvent("eaa.started") as ConsentEvent);
    expect(received).toHaveLength(1);
  });

  it("catches typed listener exceptions", () => {
    subscribeToEventType("breach.detected", () => {
      throw new Error("typed boom");
    });

    expect(() => emitConsentEvent(buildTestEvent("breach.detected") as ConsentEvent)).not.toThrow();
  });

  it("cleans up typed listener map when last listener unsubscribes", () => {
    const unsub = subscribeToEventType("wo.minted", () => {});
    expect(__testing.typedListenerCount).toBe(1);
    unsub();
    expect(__testing.typedListenerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Both global and typed listeners receive the same event
// ---------------------------------------------------------------------------

describe("emit dispatches to both global and typed listeners", () => {
  it("both receive the event", () => {
    const globalReceived: ConsentEvent[] = [];
    const typedReceived: ConsentEvent[] = [];

    subscribeToConsentEvents((e) => globalReceived.push(e));
    subscribeToEventType("co.granted", (e) => typedReceived.push(e));

    emitConsentEvent(buildTestEvent("co.granted") as ConsentEvent);

    expect(globalReceived).toHaveLength(1);
    expect(typedReceived).toHaveLength(1);
    expect(globalReceived[0].id).toBe(typedReceived[0].id);
  });
});

// ---------------------------------------------------------------------------
// buildEventBase
// ---------------------------------------------------------------------------

describe("buildEventBase", () => {
  it("produces a base with required fields", () => {
    const base = buildEventBase("wo.minted", "po-123", {
      agentId: "agent-1",
      sessionKey: "sess-1",
    });

    expect(base.type).toBe("wo.minted");
    expect(base.poId).toBe("po-123");
    expect(base.agentId).toBe("agent-1");
    expect(base.sessionKey).toBe("sess-1");
    expect(typeof base.id).toBe("string");
    expect(base.id.length).toBeGreaterThan(0);
    expect(typeof base.timestamp).toBe("number");
  });

  it("omits optional fields when not provided", () => {
    const base = buildEventBase("co.denied", "po-456");
    expect(base.agentId).toBeUndefined();
    expect(base.sessionKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Event Factory Helpers
// ---------------------------------------------------------------------------

describe("emitWOMinted", () => {
  it("emits a wo.minted event with correct fields", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitWOMinted({
      poId: "po-1",
      woId: "wo-1",
      grantedEffects: ["read", "compose"],
      constraints: [],
      anchorKinds: ["implied"],
    });

    expect(received).toHaveLength(1);
    const event = received[0] as WOMintedEvent;
    expect(event.type).toBe("wo.minted");
    expect(event.woId).toBe("wo-1");
    expect(event.grantedEffects).toEqual(["read", "compose"]);
    expect(event.anchorKinds).toEqual(["implied"]);
    expect(event.predecessorWoId).toBeUndefined();
  });

  it("includes predecessorWoId when provided", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitWOMinted({
      poId: "po-1",
      woId: "wo-2",
      predecessorWoId: "wo-1",
      grantedEffects: ["read", "persist"],
      constraints: [],
      anchorKinds: ["implied", "explicit"],
    });

    const event = received[0] as WOMintedEvent;
    expect(event.predecessorWoId).toBe("wo-1");
  });
});

describe("emitWOSuperseded", () => {
  it("emits a wo.superseded event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitWOSuperseded({
      poId: "po-1",
      predecessorWoId: "wo-1",
      successorWoId: "wo-2",
      addedEffects: ["persist"],
      removedEffects: [],
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("wo.superseded");
  });
});

describe("emitCORequested", () => {
  it("emits a co.requested event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitCORequested({
      poId: "po-1",
      coId: "co-1",
      woId: "wo-1",
      requestedEffects: ["exec"],
      toolName: "bash",
      effectDescription: "Run a command",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("co.requested");
  });
});

describe("emitCOGranted", () => {
  it("emits a co.granted event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitCOGranted({
      poId: "po-1",
      coId: "co-1",
      grantedEffects: ["exec"],
      successorWoId: "wo-2",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("co.granted");
  });
});

describe("emitCODenied", () => {
  it("emits a co.denied event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitCODenied({
      poId: "po-1",
      coId: "co-1",
      deniedEffects: ["irreversible"],
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("co.denied");
  });
});

describe("emitEAAStarted", () => {
  it("emits an eaa.started event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitEAAStarted({
      poId: "po-1",
      toolName: "exec",
      triggerCategories: ["duty-collision", "irreversibility"],
      severity: 0.8,
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("eaa.started");
  });
});

describe("emitEAACompleted", () => {
  it("emits an eaa.completed event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitEAACompleted({
      poId: "po-1",
      eaaRecordId: "eaa-1",
      outcome: "proceed",
      toolName: "exec",
      durationMs: 1500,
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("eaa.completed");
  });
});

describe("emitEffectExecuted", () => {
  it("emits an effect.executed event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitEffectExecuted({
      poId: "po-1",
      woId: "wo-1",
      toolName: "write",
      effectClasses: ["persist"],
      success: true,
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("effect.executed");
  });
});

describe("emitConsentRevoked", () => {
  it("emits a consent.revoked event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitConsentRevoked({
      poId: "po-1",
      revokedEffects: ["exec", "persist"],
      revokedRecordCount: 2,
      reason: "User cancelled",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("consent.revoked");
  });
});

describe("emitConsentWithdrawn", () => {
  it("emits a consent.withdrawn event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitConsentWithdrawn({
      poId: "po-1",
      withdrawalReason: "duty-conflict",
      affectedEffects: ["disclose"],
      explanation: "Cannot disclose due to confidentiality duty",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("consent.withdrawn");
  });
});

describe("emitBreachDetected", () => {
  it("emits a breach.detected event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitBreachDetected({
      poId: "po-1",
      woId: "wo-1",
      toolName: "exec",
      violationType: "effect-not-granted",
      details: "exec effect not in WO grants",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("breach.detected");
  });
});

describe("emitWOExpired", () => {
  it("emits a wo.expired event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitWOExpired({
      poId: "po-1",
      woId: "wo-1",
      grantedEffects: ["read"],
      mintedAt: Date.now() - 60000,
      expiresAt: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("wo.expired");
  });
});

describe("emitCOExpired", () => {
  it("emits a co.expired event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitCOExpired({ poId: "po-1", coId: "co-1" });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("co.expired");
  });
});

describe("emitCOWithdrawn", () => {
  it("emits a co.withdrawn event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitCOWithdrawn({ poId: "po-1", coId: "co-1" });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("co.withdrawn");
  });
});

describe("emitConsentGranted", () => {
  it("emits a consent.granted event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitConsentGranted({
      poId: "po-1",
      consentRecordId: "cr-1",
      effectClasses: ["exec"],
      source: "change-order",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("consent.granted");
  });
});

describe("emitPolicyApplied", () => {
  it("emits a policy.applied event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitPolicyApplied({
      poId: "po-1",
      policyId: "pol-1",
      policyClass: "system",
      grantedEffects: ["read", "compose"],
      woId: "wo-1",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("policy.applied");
  });
});

describe("emitPolicyEscalated", () => {
  it("emits a policy.escalated event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitPolicyEscalated({
      poId: "po-1",
      policyId: "pol-1",
      escalationAction: "trigger-eaa",
      reason: "high-risk effects",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("policy.escalated");
  });
});

describe("emitPolicyProposed", () => {
  it("emits a policy.proposed event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitPolicyProposed({
      poId: "po-1",
      policyId: "pol-2",
      effectScope: ["persist"],
      rationale: "Repeated pattern",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("policy.proposed");
  });
});

describe("emitPolicyConfirmed", () => {
  it("emits a policy.confirmed event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitPolicyConfirmed({
      poId: "po-1",
      policyId: "pol-2",
      effectScope: ["persist"],
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("policy.confirmed");
  });
});

describe("emitBreachContained", () => {
  it("emits a breach.contained event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitBreachContained({
      poId: "po-1",
      breachEventId: "b-1",
      containmentAction: "halted execution",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("breach.contained");
  });
});

describe("emitBreachRemediated", () => {
  it("emits a breach.remediated event", () => {
    const received: ConsentEvent[] = [];
    subscribeToConsentEvents((e) => received.push(e));

    emitBreachRemediated({
      poId: "po-1",
      breachEventId: "b-1",
      remediationAction: "revoked WO",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("breach.remediated");
  });
});

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

describe("__testing", () => {
  it("clearAllListeners removes all listeners", () => {
    subscribeToConsentEvents(() => {});
    subscribeToEventType("wo.minted", () => {});

    expect(__testing.globalListenerCount).toBe(1);
    expect(__testing.typedListenerCount).toBe(1);

    __testing.clearAllListeners();

    expect(__testing.globalListenerCount).toBe(0);
    expect(__testing.typedListenerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTestEvent(
  type: ConsentEventType,
): Partial<ConsentEvent> & { type: ConsentEventType } {
  return {
    ...buildEventBase(type, "test-po"),
    // Add minimal fields required by each event type for emitConsentEvent to not throw
    ...(type === "wo.minted" && {
      woId: "wo-1",
      grantedEffects: ["read"],
      constraints: [],
      anchorKinds: ["implied"],
    }),
    ...(type === "wo.expired" && {
      woId: "wo-1",
      grantedEffects: ["read"],
      mintedAt: Date.now() - 60000,
      expiresAt: Date.now(),
    }),
    ...(type === "wo.superseded" && {
      predecessorWoId: "wo-1",
      successorWoId: "wo-2",
      addedEffects: [],
      removedEffects: [],
    }),
    ...(type === "co.requested" && {
      coId: "co-1",
      woId: "wo-1",
      requestedEffects: ["exec"],
      toolName: "bash",
      effectDescription: "test",
    }),
    ...(type === "co.granted" && {
      coId: "co-1",
      grantedEffects: ["exec"],
      successorWoId: "wo-2",
    }),
    ...(type === "co.denied" && {
      coId: "co-1",
      deniedEffects: ["exec"],
    }),
    ...(type === "co.expired" && { coId: "co-1" }),
    ...(type === "co.withdrawn" && { coId: "co-1" }),
    ...(type === "eaa.started" && {
      toolName: "exec",
      triggerCategories: ["duty-collision"],
      severity: 0.8,
    }),
    ...(type === "eaa.completed" && {
      eaaRecordId: "eaa-1",
      outcome: "proceed" as const,
      toolName: "exec",
      durationMs: 100,
    }),
    ...(type === "effect.executed" && {
      woId: "wo-1",
      toolName: "write",
      effectClasses: ["persist"],
      success: true,
    }),
    ...(type === "consent.granted" && {
      consentRecordId: "cr-1",
      effectClasses: ["exec"],
      source: "change-order" as const,
    }),
    ...(type === "consent.revoked" && {
      revokedEffects: ["exec"],
      revokedRecordCount: 1,
      reason: "test",
    }),
    ...(type === "consent.withdrawn" && {
      withdrawalReason: "other",
      affectedEffects: ["exec"],
      explanation: "test",
    }),
    ...(type === "policy.applied" && {
      policyId: "p-1",
      policyClass: "user",
      grantedEffects: ["read"],
      woId: "wo-1",
    }),
    ...(type === "policy.escalated" && {
      policyId: "p-1",
      escalationAction: "trigger-eaa",
      reason: "test",
    }),
    ...(type === "policy.proposed" && {
      policyId: "p-1",
      effectScope: ["read"],
      rationale: "test",
    }),
    ...(type === "policy.confirmed" && {
      policyId: "p-1",
      effectScope: ["read"],
    }),
    ...(type === "breach.detected" && {
      woId: "wo-1",
      toolName: "exec",
      violationType: "effect-not-granted" as const,
      details: "test",
    }),
    ...(type === "breach.contained" && {
      breachEventId: "b-1",
      containmentAction: "test",
    }),
    ...(type === "breach.remediated" && {
      breachEventId: "b-1",
      remediationAction: "test",
    }),
  };
}
