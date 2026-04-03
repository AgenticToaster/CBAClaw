import { afterEach, describe, expect, it } from "vitest";
import { __testing as eventsTestSeam, emitConsentEvent, buildEventBase } from "./events.js";
import type { ConsentEvent } from "./events.js";
import {
  __testing,
  getMetricsSnapshot,
  incrementCounter,
  METRIC_NAMES,
  recordCOByEffect,
  recordEAAOutcome,
  recordHistogramValue,
  recordPolicyBypass,
  recordVerificationFailure,
  resetMetrics,
  startMetricsCollection,
} from "./metrics.js";

afterEach(() => {
  resetMetrics();
  eventsTestSeam.clearAllListeners();
});

// ---------------------------------------------------------------------------
// Counter Operations
// ---------------------------------------------------------------------------

describe("incrementCounter", () => {
  it("creates and increments a counter", () => {
    incrementCounter("test.counter");
    incrementCounter("test.counter");
    incrementCounter("test.counter", 3);

    const snapshot = getMetricsSnapshot();
    expect(snapshot.counters["test.counter"]).toBe(5);
  });

  it("defaults to increment by 1", () => {
    incrementCounter("test.single");
    expect(getMetricsSnapshot().counters["test.single"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Histogram Operations
// ---------------------------------------------------------------------------

describe("recordHistogramValue", () => {
  it("records values and computes statistics", () => {
    recordHistogramValue("test.hist", 100);
    recordHistogramValue("test.hist", 200);
    recordHistogramValue("test.hist", 300);

    const snapshot = getMetricsSnapshot();
    const hist = snapshot.histograms["test.hist"];
    expect(hist.count).toBe(3);
    expect(hist.sum).toBe(600);
    expect(hist.min).toBe(100);
    expect(hist.max).toBe(300);
    expect(hist.mean).toBe(200);
  });

  it("populates histogram buckets correctly", () => {
    const buckets = [100, 500, 1000];
    recordHistogramValue("test.buckets", 50, buckets);
    recordHistogramValue("test.buckets", 150, buckets);
    recordHistogramValue("test.buckets", 750, buckets);
    recordHistogramValue("test.buckets", 1500, buckets);

    const snapshot = getMetricsSnapshot();
    const hist = snapshot.histograms["test.buckets"];
    expect(hist.buckets).toEqual([
      { le: 100, count: 1 },
      { le: 500, count: 2 },
      { le: 1000, count: 3 },
    ]);
  });

  it("handles empty histogram gracefully", () => {
    const snapshot = getMetricsSnapshot();
    expect(Object.keys(snapshot.histograms)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CO By Effect Tracking
// ---------------------------------------------------------------------------

describe("recordCOByEffect", () => {
  it("tracks CO events per effect class", () => {
    recordCOByEffect(["exec", "persist"], "requested");
    recordCOByEffect(["exec"], "granted");
    recordCOByEffect(["persist"], "denied");

    const snapshot = getMetricsSnapshot();
    expect(snapshot.coByEffect["exec"]).toEqual({ requested: 1, granted: 1, denied: 0 });
    expect(snapshot.coByEffect["persist"]).toEqual({ requested: 1, granted: 0, denied: 1 });
  });

  it("accumulates across multiple calls", () => {
    recordCOByEffect(["read"], "requested");
    recordCOByEffect(["read"], "requested");
    recordCOByEffect(["read"], "granted");

    const snapshot = getMetricsSnapshot();
    expect(snapshot.coByEffect["read"]).toEqual({ requested: 2, granted: 1, denied: 0 });
  });
});

// ---------------------------------------------------------------------------
// EAA Outcome Tracking
// ---------------------------------------------------------------------------

describe("recordEAAOutcome", () => {
  it("tracks outcome distribution", () => {
    recordEAAOutcome("proceed");
    recordEAAOutcome("proceed");
    recordEAAOutcome("refuse");
    recordEAAOutcome("constrained-comply");

    const snapshot = getMetricsSnapshot();
    expect(snapshot.eaaOutcomes["proceed"]).toBe(2);
    expect(snapshot.eaaOutcomes["refuse"]).toBe(1);
    expect(snapshot.eaaOutcomes["constrained-comply"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Convenience Recorders
// ---------------------------------------------------------------------------

describe("recordVerificationFailure", () => {
  it("increments the verification failure counter", () => {
    recordVerificationFailure();
    recordVerificationFailure();

    const snapshot = getMetricsSnapshot();
    expect(snapshot.counters[METRIC_NAMES.VERIFICATION_FAILURE]).toBe(2);
  });
});

describe("recordPolicyBypass", () => {
  it("increments the policy bypass counter", () => {
    recordPolicyBypass();

    const snapshot = getMetricsSnapshot();
    expect(snapshot.counters[METRIC_NAMES.POLICY_BYPASS]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Metrics Snapshot
// ---------------------------------------------------------------------------

describe("getMetricsSnapshot", () => {
  it("returns a complete snapshot with timestamp", () => {
    incrementCounter("test.a");
    recordHistogramValue("test.h", 42);

    const snapshot = getMetricsSnapshot();
    expect(typeof snapshot.snapshotAt).toBe("number");
    expect(snapshot.counters["test.a"]).toBe(1);
    expect(snapshot.histograms["test.h"].count).toBe(1);
  });

  it("returns zero-safe values for histogram min/max when empty", () => {
    recordHistogramValue("test.empty", 0);

    const snapshot = getMetricsSnapshot();
    expect(snapshot.histograms["test.empty"].min).toBe(0);
    expect(snapshot.histograms["test.empty"].max).toBe(0);
  });

  it("returns an empty snapshot when no metrics recorded", () => {
    const snapshot = getMetricsSnapshot();
    expect(Object.keys(snapshot.counters)).toHaveLength(0);
    expect(Object.keys(snapshot.histograms)).toHaveLength(0);
    expect(Object.keys(snapshot.coByEffect)).toHaveLength(0);
    expect(Object.keys(snapshot.eaaOutcomes)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resetMetrics
// ---------------------------------------------------------------------------

describe("resetMetrics", () => {
  it("clears all metrics", () => {
    incrementCounter("test.counter");
    recordHistogramValue("test.hist", 100);
    recordCOByEffect(["exec"], "requested");
    recordEAAOutcome("proceed");

    resetMetrics();

    const snapshot = getMetricsSnapshot();
    expect(Object.keys(snapshot.counters)).toHaveLength(0);
    expect(Object.keys(snapshot.histograms)).toHaveLength(0);
    expect(Object.keys(snapshot.coByEffect)).toHaveLength(0);
    expect(Object.keys(snapshot.eaaOutcomes)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Event Bus Auto-Collection
// ---------------------------------------------------------------------------

describe("startMetricsCollection", () => {
  it("auto-collects wo.minted events", () => {
    const unsub = startMetricsCollection();
    try {
      emitConsentEvent({
        ...buildEventBase("wo.minted", "po-1"),
        woId: "wo-1",
        grantedEffects: ["read"],
        constraints: [],
        anchorKinds: ["implied"],
      } as ConsentEvent);

      expect(getMetricsSnapshot().counters[METRIC_NAMES.WO_MINTED]).toBe(1);
    } finally {
      unsub();
    }
  });

  it("auto-collects co.requested with per-effect tracking", () => {
    const unsub = startMetricsCollection();
    try {
      emitConsentEvent({
        ...buildEventBase("co.requested", "po-1"),
        coId: "co-1",
        woId: "wo-1",
        requestedEffects: ["exec", "persist"],
        toolName: "bash",
        effectDescription: "test",
      } as ConsentEvent);

      const snapshot = getMetricsSnapshot();
      expect(snapshot.counters[METRIC_NAMES.CO_REQUESTED]).toBe(1);
      expect(snapshot.coByEffect["exec"]?.requested).toBe(1);
      expect(snapshot.coByEffect["persist"]?.requested).toBe(1);
    } finally {
      unsub();
    }
  });

  it("auto-collects co.granted with per-effect tracking", () => {
    const unsub = startMetricsCollection();
    try {
      emitConsentEvent({
        ...buildEventBase("co.granted", "po-1"),
        coId: "co-1",
        grantedEffects: ["exec"],
        successorWoId: "wo-2",
      } as ConsentEvent);

      const snapshot = getMetricsSnapshot();
      expect(snapshot.counters[METRIC_NAMES.CO_GRANTED]).toBe(1);
      expect(snapshot.coByEffect["exec"]?.granted).toBe(1);
    } finally {
      unsub();
    }
  });

  it("auto-collects eaa.completed with outcome and duration", () => {
    const unsub = startMetricsCollection();
    try {
      emitConsentEvent({
        ...buildEventBase("eaa.completed", "po-1"),
        eaaRecordId: "eaa-1",
        outcome: "constrained-comply",
        toolName: "exec",
        durationMs: 2500,
      } as ConsentEvent);

      const snapshot = getMetricsSnapshot();
      expect(snapshot.counters[METRIC_NAMES.EAA_COMPLETED]).toBe(1);
      expect(snapshot.eaaOutcomes["constrained-comply"]).toBe(1);
      expect(snapshot.histograms[METRIC_NAMES.EAA_DURATION_MS]?.count).toBe(1);
      expect(snapshot.histograms[METRIC_NAMES.EAA_DURATION_MS]?.sum).toBe(2500);
    } finally {
      unsub();
    }
  });

  it("auto-collects effect.executed success and failure", () => {
    const unsub = startMetricsCollection();
    try {
      emitConsentEvent({
        ...buildEventBase("effect.executed", "po-1"),
        woId: "wo-1",
        toolName: "write",
        effectClasses: ["persist"],
        success: true,
      } as ConsentEvent);
      emitConsentEvent({
        ...buildEventBase("effect.executed", "po-1"),
        woId: "wo-1",
        toolName: "exec",
        effectClasses: ["exec"],
        success: false,
      } as ConsentEvent);

      const snapshot = getMetricsSnapshot();
      expect(snapshot.counters[METRIC_NAMES.EFFECT_EXECUTED]).toBe(1);
      expect(snapshot.counters[METRIC_NAMES.EFFECT_FAILED]).toBe(1);
    } finally {
      unsub();
    }
  });

  it("auto-collects breach events", () => {
    const unsub = startMetricsCollection();
    try {
      emitConsentEvent({
        ...buildEventBase("breach.detected", "po-1"),
        woId: "wo-1",
        toolName: "exec",
        violationType: "effect-not-granted",
        details: "test",
      } as ConsentEvent);
      emitConsentEvent({
        ...buildEventBase("breach.contained", "po-1"),
        breachEventId: "b-1",
        containmentAction: "halted",
      } as ConsentEvent);
      emitConsentEvent({
        ...buildEventBase("breach.remediated", "po-1"),
        breachEventId: "b-1",
        remediationAction: "revoked WO",
      } as ConsentEvent);

      const snapshot = getMetricsSnapshot();
      expect(snapshot.counters[METRIC_NAMES.BREACH_DETECTED]).toBe(1);
      expect(snapshot.counters[METRIC_NAMES.BREACH_CONTAINED]).toBe(1);
      expect(snapshot.counters[METRIC_NAMES.BREACH_REMEDIATED]).toBe(1);
    } finally {
      unsub();
    }
  });

  it("auto-collects policy events", () => {
    const unsub = startMetricsCollection();
    try {
      emitConsentEvent({
        ...buildEventBase("policy.applied", "po-1"),
        policyId: "pol-1",
        policyClass: "user",
        grantedEffects: ["read"],
        woId: "wo-1",
      } as ConsentEvent);
      emitConsentEvent({
        ...buildEventBase("policy.escalated", "po-1"),
        policyId: "pol-1",
        escalationAction: "trigger-eaa",
        reason: "test",
      } as ConsentEvent);
      emitConsentEvent({
        ...buildEventBase("policy.proposed", "po-1"),
        policyId: "pol-2",
        effectScope: ["persist"],
        rationale: "test",
      } as ConsentEvent);
      emitConsentEvent({
        ...buildEventBase("policy.confirmed", "po-1"),
        policyId: "pol-2",
        effectScope: ["persist"],
      } as ConsentEvent);

      const snapshot = getMetricsSnapshot();
      expect(snapshot.counters[METRIC_NAMES.POLICY_APPLIED]).toBe(1);
      expect(snapshot.counters[METRIC_NAMES.POLICY_ESCALATED]).toBe(1);
      expect(snapshot.counters[METRIC_NAMES.POLICY_PROPOSED]).toBe(1);
      expect(snapshot.counters[METRIC_NAMES.POLICY_CONFIRMED]).toBe(1);
    } finally {
      unsub();
    }
  });

  it("unsubscribe stops collection", () => {
    const unsub = startMetricsCollection();
    unsub();

    emitConsentEvent({
      ...buildEventBase("wo.minted", "po-1"),
      woId: "wo-1",
      grantedEffects: ["read"],
      constraints: [],
      anchorKinds: ["implied"],
    } as ConsentEvent);

    expect(getMetricsSnapshot().counters[METRIC_NAMES.WO_MINTED]).toBeUndefined();
  });

  it("subsequent calls replace previous subscription", () => {
    const _unsub1 = startMetricsCollection();
    const unsub2 = startMetricsCollection();

    emitConsentEvent({
      ...buildEventBase("wo.minted", "po-1"),
      woId: "wo-1",
      grantedEffects: ["read"],
      constraints: [],
      anchorKinds: ["implied"],
    } as ConsentEvent);

    // Should only count once (old subscription replaced)
    expect(getMetricsSnapshot().counters[METRIC_NAMES.WO_MINTED]).toBe(1);
    unsub2();
  });
});

// ---------------------------------------------------------------------------
// METRIC_NAMES
// ---------------------------------------------------------------------------

describe("METRIC_NAMES", () => {
  it("provides well-known metric name constants", () => {
    expect(METRIC_NAMES.WO_MINTED).toBe("consent.wo.minted");
    expect(METRIC_NAMES.CO_REQUESTED).toBe("consent.co.requested");
    expect(METRIC_NAMES.EAA_STARTED).toBe("consent.eaa.started");
    expect(METRIC_NAMES.BREACH_DETECTED).toBe("consent.breach.detected");
    expect(METRIC_NAMES.POLICY_BYPASS).toBe("consent.policy.bypass");
    expect(METRIC_NAMES.VERIFICATION_FAILURE).toBe("consent.verification.failure");
  });
});
