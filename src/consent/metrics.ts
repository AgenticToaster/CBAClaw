/**
 * Consent Flow Metrics (Phase 6d)
 *
 * Tracks operational metrics for the consent-bound agency framework:
 *  - CO request/grant/deny rates by effect class
 *  - EAA invocation rates and outcome distribution
 *  - WO verification failure rate (should be near zero in steady state)
 *  - Policy bypass rates
 *  - Breach detection rate and time-to-containment
 *
 * Metrics are maintained in-process as lightweight counters and histograms.
 * The collector subscribes to the consent event bus (Phase 6a) for
 * automatic metric updates. Callers can also record metrics directly
 * for events not covered by the event bus.
 *
 * Design:
 *  - Thread-safe within a single Node.js process (no shared memory).
 *  - No external dependencies (no Prometheus, StatsD, etc.). Consumers
 *    bridge to their preferred observability backend via getSnapshot().
 *  - Counters are monotonic (never decrease). Reset only via explicit
 *    resetMetrics() call.
 *  - Histogram buckets track latency distributions for EAA and CO flows.
 */

import type { ConsentEvent, ConsentEventListener } from "./events.js";
import { subscribeToConsentEvents } from "./events.js";
import type { EAAOutcome, EffectClass } from "./types.js";

// ---------------------------------------------------------------------------
// Counter and Histogram Types
// ---------------------------------------------------------------------------

export type MetricCounter = {
  readonly value: number;
  increment(amount?: number): void;
};

export type MetricHistogram = {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly buckets: readonly HistogramBucket[];
  record(value: number): void;
};

export type HistogramBucket = {
  /** Upper bound (inclusive) of this bucket. */
  le: number;
  /** Cumulative count of observations ≤ le. */
  count: number;
};

// ---------------------------------------------------------------------------
// Metric Registry
// ---------------------------------------------------------------------------

type CounterState = { value: number };
type HistogramState = {
  count: number;
  sum: number;
  min: number;
  max: number;
  bucketBounds: number[];
  bucketCounts: number[];
};

const _counters = new Map<string, CounterState>();
const _histograms = new Map<string, HistogramState>();

/** Per-effect-class CO tracking. */
const _coByEffect = new Map<EffectClass, { requested: number; granted: number; denied: number }>();

/** EAA outcome distribution. */
const _eaaOutcomes = new Map<EAAOutcome, number>();

function getOrCreateCounter(name: string): CounterState {
  let state = _counters.get(name);
  if (!state) {
    state = { value: 0 };
    _counters.set(name, state);
  }
  return state;
}

function getOrCreateHistogram(name: string, bounds: number[]): HistogramState {
  let state = _histograms.get(name);
  if (!state) {
    state = {
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      bucketBounds: bounds,
      bucketCounts: Array.from<number>({ length: bounds.length }).fill(0),
    };
    _histograms.set(name, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Well-Known Metric Names
// ---------------------------------------------------------------------------

export const METRIC_NAMES = {
  WO_MINTED: "consent.wo.minted",
  WO_EXPIRED: "consent.wo.expired",
  WO_SUPERSEDED: "consent.wo.superseded",

  CO_REQUESTED: "consent.co.requested",
  CO_GRANTED: "consent.co.granted",
  CO_DENIED: "consent.co.denied",
  CO_EXPIRED: "consent.co.expired",
  CO_WITHDRAWN: "consent.co.withdrawn",

  EAA_STARTED: "consent.eaa.started",
  EAA_COMPLETED: "consent.eaa.completed",
  EAA_DURATION_MS: "consent.eaa.duration_ms",

  EFFECT_EXECUTED: "consent.effect.executed",
  EFFECT_FAILED: "consent.effect.failed",

  CONSENT_GRANTED: "consent.consent.granted",
  CONSENT_REVOKED: "consent.consent.revoked",
  CONSENT_WITHDRAWN: "consent.consent.withdrawn",

  POLICY_APPLIED: "consent.policy.applied",
  POLICY_ESCALATED: "consent.policy.escalated",
  POLICY_PROPOSED: "consent.policy.proposed",
  POLICY_CONFIRMED: "consent.policy.confirmed",

  VERIFICATION_FAILURE: "consent.verification.failure",
  POLICY_BYPASS: "consent.policy.bypass",

  BREACH_DETECTED: "consent.breach.detected",
  BREACH_CONTAINED: "consent.breach.contained",
  BREACH_REMEDIATED: "consent.breach.remediated",
} as const;

/** Default EAA duration histogram buckets (ms). */
const EAA_DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

// ---------------------------------------------------------------------------
// Public Recording API
// ---------------------------------------------------------------------------

/** Increment a named counter. */
export function incrementCounter(name: string, amount = 1): void {
  const state = getOrCreateCounter(name);
  state.value += amount;
}

/** Record a value in a named histogram. */
export function recordHistogramValue(name: string, value: number, bounds?: number[]): void {
  const state = getOrCreateHistogram(name, bounds ?? EAA_DURATION_BUCKETS);
  state.count += 1;
  state.sum += value;
  if (value < state.min) {
    state.min = value;
  }
  if (value > state.max) {
    state.max = value;
  }
  for (let i = 0; i < state.bucketBounds.length; i++) {
    if (value <= state.bucketBounds[i]) {
      state.bucketCounts[i] += 1;
    }
  }
}

/** Record a CO event by effect class. */
export function recordCOByEffect(
  effects: readonly EffectClass[],
  decision: "requested" | "granted" | "denied",
): void {
  for (const effect of effects) {
    let entry = _coByEffect.get(effect);
    if (!entry) {
      entry = { requested: 0, granted: 0, denied: 0 };
      _coByEffect.set(effect, entry);
    }
    entry[decision] += 1;
  }
}

/** Record an EAA outcome. */
export function recordEAAOutcome(outcome: EAAOutcome): void {
  _eaaOutcomes.set(outcome, (_eaaOutcomes.get(outcome) ?? 0) + 1);
}

/** Record a WO verification failure. */
export function recordVerificationFailure(): void {
  incrementCounter(METRIC_NAMES.VERIFICATION_FAILURE);
}

/** Record a policy bypass (policy covered missing effects without CO). */
export function recordPolicyBypass(): void {
  incrementCounter(METRIC_NAMES.POLICY_BYPASS);
}

// ---------------------------------------------------------------------------
// Metric Snapshot
// ---------------------------------------------------------------------------

export type MetricsSnapshot = {
  /** Timestamp when the snapshot was taken. */
  snapshotAt: number;
  /** All counters as name→value pairs. */
  counters: Record<string, number>;
  /** All histograms as name→summary pairs. */
  histograms: Record<
    string,
    {
      count: number;
      sum: number;
      min: number;
      max: number;
      mean: number;
      buckets: HistogramBucket[];
    }
  >;
  /** CO rates broken down by effect class. */
  coByEffect: Record<string, { requested: number; granted: number; denied: number }>;
  /** EAA outcome distribution. */
  eaaOutcomes: Record<string, number>;
};

/**
 * Capture a point-in-time snapshot of all consent metrics.
 * The snapshot is a plain JSON-serializable object suitable for
 * logging, API responses, or bridge to external metrics systems.
 */
export function getMetricsSnapshot(): MetricsSnapshot {
  const counters: Record<string, number> = {};
  for (const [name, state] of _counters) {
    counters[name] = state.value;
  }

  const histograms: MetricsSnapshot["histograms"] = {};
  for (const [name, state] of _histograms) {
    const mean = state.count > 0 ? state.sum / state.count : 0;
    const buckets: HistogramBucket[] = state.bucketBounds.map((le, i) => ({
      le,
      count: state.bucketCounts[i],
    }));
    histograms[name] = {
      count: state.count,
      sum: state.sum,
      min: state.min === Infinity ? 0 : state.min,
      max: state.max === -Infinity ? 0 : state.max,
      mean,
      buckets,
    };
  }

  const coByEffect: MetricsSnapshot["coByEffect"] = {};
  for (const [effect, entry] of _coByEffect) {
    coByEffect[effect] = { ...entry };
  }

  const eaaOutcomes: Record<string, number> = {};
  for (const [outcome, count] of _eaaOutcomes) {
    eaaOutcomes[outcome] = count;
  }

  return {
    snapshotAt: Date.now(),
    counters,
    histograms,
    coByEffect,
    eaaOutcomes,
  };
}

// ---------------------------------------------------------------------------
// Event Bus Auto-Collection
// ---------------------------------------------------------------------------

let _unsubscribe: (() => void) | undefined;

/**
 * Start automatic metric collection by subscribing to the consent event bus.
 * Returns an unsubscribe function. Safe to call multiple times; subsequent
 * calls unsubscribe the previous listener first.
 */
export function startMetricsCollection(): () => void {
  if (_unsubscribe) {
    _unsubscribe();
  }
  _unsubscribe = subscribeToConsentEvents(metricsEventHandler);
  return () => {
    if (_unsubscribe) {
      _unsubscribe();
      _unsubscribe = undefined;
    }
  };
}

/** The event handler that maps consent events to metric updates. */
const metricsEventHandler: ConsentEventListener = (event: ConsentEvent) => {
  switch (event.type) {
    case "wo.minted":
      incrementCounter(METRIC_NAMES.WO_MINTED);
      break;
    case "wo.expired":
      incrementCounter(METRIC_NAMES.WO_EXPIRED);
      break;
    case "wo.superseded":
      incrementCounter(METRIC_NAMES.WO_SUPERSEDED);
      break;
    case "co.requested":
      incrementCounter(METRIC_NAMES.CO_REQUESTED);
      recordCOByEffect(event.requestedEffects, "requested");
      break;
    case "co.granted":
      incrementCounter(METRIC_NAMES.CO_GRANTED);
      recordCOByEffect(event.grantedEffects, "granted");
      break;
    case "co.denied":
      incrementCounter(METRIC_NAMES.CO_DENIED);
      recordCOByEffect(event.deniedEffects, "denied");
      break;
    case "co.expired":
      incrementCounter(METRIC_NAMES.CO_EXPIRED);
      break;
    case "co.withdrawn":
      incrementCounter(METRIC_NAMES.CO_WITHDRAWN);
      break;
    case "eaa.started":
      incrementCounter(METRIC_NAMES.EAA_STARTED);
      break;
    case "eaa.completed":
      incrementCounter(METRIC_NAMES.EAA_COMPLETED);
      recordEAAOutcome(event.outcome);
      recordHistogramValue(METRIC_NAMES.EAA_DURATION_MS, event.durationMs);
      break;
    case "effect.executed":
      if (event.success) {
        incrementCounter(METRIC_NAMES.EFFECT_EXECUTED);
      } else {
        incrementCounter(METRIC_NAMES.EFFECT_FAILED);
      }
      break;
    case "consent.granted":
      incrementCounter(METRIC_NAMES.CONSENT_GRANTED);
      break;
    case "consent.revoked":
      incrementCounter(METRIC_NAMES.CONSENT_REVOKED);
      break;
    case "consent.withdrawn":
      incrementCounter(METRIC_NAMES.CONSENT_WITHDRAWN);
      break;
    case "policy.applied":
      incrementCounter(METRIC_NAMES.POLICY_APPLIED);
      break;
    case "policy.escalated":
      incrementCounter(METRIC_NAMES.POLICY_ESCALATED);
      break;
    case "policy.proposed":
      incrementCounter(METRIC_NAMES.POLICY_PROPOSED);
      break;
    case "policy.confirmed":
      incrementCounter(METRIC_NAMES.POLICY_CONFIRMED);
      break;
    case "breach.detected":
      incrementCounter(METRIC_NAMES.BREACH_DETECTED);
      break;
    case "breach.contained":
      incrementCounter(METRIC_NAMES.BREACH_CONTAINED);
      break;
    case "breach.remediated":
      incrementCounter(METRIC_NAMES.BREACH_REMEDIATED);
      break;
  }
};

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset all metrics to zero. For testing only.
 */
export function resetMetrics(): void {
  _counters.clear();
  _histograms.clear();
  _coByEffect.clear();
  _eaaOutcomes.clear();
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  metricsEventHandler,
  EAA_DURATION_BUCKETS,
  get counterCount(): number {
    return _counters.size;
  },
  get histogramCount(): number {
    return _histograms.size;
  },
};
