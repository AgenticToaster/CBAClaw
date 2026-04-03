/**
 * Deterministic keyword heuristic for implied consent derivation.
 *
 * Analyzes request text via pattern matching to derive EffectClass arrays.
 * Acts as:
 * - The primary fallback when vector search is unavailable
 * - An augmenter in "both" mode (unioned with vector results)
 *
 * Rules are intentionally conservative -- false positives (over-granting)
 * are caught by the binder's ceiling checks and system prohibitions.
 */

import type { EffectClass } from "./types.js";

type HeuristicRule = {
  pattern: RegExp;
  effects: EffectClass[];
};

const HEURISTIC_RULES: readonly HeuristicRule[] = [
  // Execution
  {
    pattern:
      /\b(run|execute|exec|spawn|start|launch|invoke|restart|reboot|compile|build|install|deploy|migrate)\b/i,
    effects: ["exec"],
  },

  // File writing / persistence
  {
    pattern:
      /\b(write|create|save|edit|update|modify|add|append|rename|move|refactor|generate|patch|replace)\b/i,
    effects: ["read", "compose", "persist"],
  },

  // Deletion / irreversible
  {
    pattern: /\b(delete|remove|drop|wipe|purge|destroy|clean\s*up|erase|uninstall|truncate)\b/i,
    effects: ["irreversible"],
  },

  // Communication / disclosure
  {
    pattern:
      /\b(send|email|message|notify|post|reply|forward|broadcast|share|announce|slack|telegram|discord)\b/i,
    effects: ["disclose"],
  },

  // Audience expansion
  {
    pattern: /\b(invite|add\s+(user|member|people)|broadcast|public(ly)?|everyone)\b/i,
    effects: ["audience-expand"],
  },

  // Network / outbound
  {
    pattern:
      /\b(search\s+the\s+web|fetch|download|curl|http|api\s+call|scrape|crawl|request\s+(from|to)|pull\s+from)\b/i,
    effects: ["network", "read"],
  },

  // Elevated / administrative
  {
    pattern:
      /\b(cron|schedule|gateway|admin|configure\s+(the\s+)?(system|server|gateway|node)|webhook|daemon|service\s+config)\b/i,
    effects: ["elevated"],
  },

  // Physical (IoT, hardware)
  {
    pattern: /\b(turn\s+(on|off)|actuate|motor|servo|gpio|hardware|device\s+control|physical)\b/i,
    effects: ["physical"],
  },
];

/**
 * Default effects when no heuristic rule matches. Safe baseline for
 * purely informational queries.
 */
const DEFAULT_EFFECTS: readonly EffectClass[] = ["read", "compose"];

/**
 * Derive implied effects from request text using deterministic keyword rules.
 * Returns the union of all matching rules, or the default read+compose if
 * no rules match.
 */
export function deriveEffectsFromHeuristic(requestText: string): EffectClass[] {
  const matched = new Set<EffectClass>();

  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(requestText)) {
      for (const effect of rule.effects) {
        matched.add(effect);
      }
    }
  }

  if (matched.size === 0) {
    return [...DEFAULT_EFFECTS];
  }

  // Always include "read" and "compose" as baseline capabilities
  matched.add("read");
  matched.add("compose");

  return [...matched];
}
