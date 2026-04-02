/**
 * Effect Registry: Deterministic Tool-to-Effect Mapping
 *
 * Maps known tool names to their declared EffectClass arrays. This is the
 * lookup table the binder uses for ceiling checks. Tools not in the registry
 * receive a conservative default profile.
 *
 * Plugin-registered tools declare their own profiles via registerTool options.
 * This registry covers core and coding-agent tools.
 */

import type { EffectClass, ToolEffectProfile, TrustTier } from "./types.js";

type EffectRegistryEntry = {
  effects: EffectClass[];
  trustTier: TrustTier;
  description: string;
};

/**
 * Core tool effect registry. Keyed by tool name as registered in the agent
 * tool set. Entries are intentionally conservative -- a tool's declared
 * effects are a ceiling that the binder will intersect with consented effects.
 */
const CORE_EFFECT_REGISTRY: ReadonlyMap<string, EffectRegistryEntry> = new Map<
  string,
  EffectRegistryEntry
>([
  // --- Read-only / informational tools ---
  ["read", { effects: ["read"], trustTier: "in-process", description: "Read file contents" }],
  ["glob", { effects: ["read"], trustTier: "in-process", description: "Find files by pattern" }],
  ["grep", { effects: ["read"], trustTier: "in-process", description: "Search file contents" }],
  ["ls", { effects: ["read"], trustTier: "in-process", description: "List directory contents" }],
  [
    "pdf",
    { effects: ["read"], trustTier: "in-process", description: "Extract text from PDF files" },
  ],
  ["image", { effects: ["read"], trustTier: "in-process", description: "Read and analyze images" }],
  [
    "agents_list",
    { effects: ["read"], trustTier: "in-process", description: "List available agents" },
  ],
  [
    "sessions_list",
    { effects: ["read"], trustTier: "in-process", description: "List active sessions" },
  ],
  [
    "sessions_history",
    { effects: ["read"], trustTier: "in-process", description: "Read session history" },
  ],
  [
    "session_status",
    { effects: ["read"], trustTier: "in-process", description: "Read session status" },
  ],

  // --- Compose / internal content creation ---
  [
    "canvas",
    {
      effects: ["read", "compose"],
      trustTier: "in-process",
      description: "Create or edit canvas content",
    },
  ],
  [
    "image_generate",
    {
      effects: ["compose", "network"],
      trustTier: "external",
      description: "Generate images via external API",
    },
  ],
  [
    "tts",
    {
      effects: ["compose", "network"],
      trustTier: "external",
      description: "Text-to-speech synthesis via external API",
    },
  ],

  // --- Persist / durable state writes ---
  ["write", { effects: ["persist"], trustTier: "in-process", description: "Write file to disk" }],
  [
    "fs_write",
    {
      effects: ["persist"],
      trustTier: "in-process",
      description: "Write file to disk (gateway alias)",
    },
  ],
  [
    "edit",
    { effects: ["read", "persist"], trustTier: "in-process", description: "Edit existing file" },
  ],
  [
    "apply_patch",
    {
      effects: ["persist"],
      trustTier: "in-process",
      description: "Apply patch to file",
    },
  ],
  [
    "notebook_edit",
    {
      effects: ["read", "persist"],
      trustTier: "in-process",
      description: "Edit notebook cell",
    },
  ],

  // --- Disclose / external communication ---
  [
    "message",
    {
      effects: ["disclose"],
      trustTier: "in-process",
      description: "Send message to external channel",
    },
  ],
  [
    "sessions_send",
    {
      effects: ["disclose"],
      trustTier: "in-process",
      description: "Send message to another session",
    },
  ],

  // --- Network / outbound requests ---
  [
    "web_search",
    {
      effects: ["network", "read"],
      trustTier: "external",
      description: "Search the web",
    },
  ],
  [
    "web_fetch",
    {
      effects: ["network", "read"],
      trustTier: "external",
      description: "Fetch content from a URL",
    },
  ],

  // --- Exec / host command execution ---
  [
    "exec",
    {
      effects: ["exec", "irreversible"],
      trustTier: "in-process",
      description: "Execute shell command on host",
    },
  ],
  [
    "spawn",
    {
      effects: ["exec", "irreversible"],
      trustTier: "in-process",
      description: "Spawn child process on host",
    },
  ],
  [
    "shell",
    {
      effects: ["exec", "irreversible"],
      trustTier: "in-process",
      description: "Execute shell command on host",
    },
  ],

  // --- Irreversible / deletion ---
  [
    "fs_delete",
    {
      effects: ["irreversible", "persist"],
      trustTier: "in-process",
      description: "Delete file from disk",
    },
  ],
  [
    "fs_move",
    {
      effects: ["persist"],
      trustTier: "in-process",
      description: "Move or rename file on disk",
    },
  ],

  // --- Elevated / administrative ---
  [
    "gateway",
    {
      effects: ["elevated"],
      trustTier: "in-process",
      description: "Gateway control plane operation",
    },
  ],
  [
    "nodes",
    {
      effects: ["elevated", "exec"],
      trustTier: "external",
      description: "Relay command to paired node",
    },
  ],
  [
    "cron",
    {
      effects: ["elevated", "persist"],
      trustTier: "in-process",
      description: "Create or manage scheduled automation",
    },
  ],

  // --- Session orchestration ---
  [
    "sessions_spawn",
    {
      effects: ["exec", "persist"],
      trustTier: "in-process",
      description: "Spawn a new agent session",
    },
  ],
  [
    "sessions_yield",
    {
      effects: ["compose"],
      trustTier: "in-process",
      description: "Yield control back to parent session",
    },
  ],
  [
    "subagents",
    {
      effects: ["exec", "persist"],
      trustTier: "in-process",
      description: "Manage sub-agent orchestration",
    },
  ],

  // --- WhatsApp login (interactive, dangerous) ---
  [
    "whatsapp_login",
    {
      effects: ["elevated", "network"],
      trustTier: "external",
      description: "Interactive WhatsApp QR login",
    },
  ],
]);

/**
 * Conservative default profile for tools not in the registry.
 * Assumes the tool can read, compose, persist, and access the network.
 * The binder applies this as a ceiling -- actual grants still require consent.
 */
const DEFAULT_EFFECT_PROFILE: ToolEffectProfile = {
  effects: ["read", "compose", "persist", "network"],
  trustTier: "external",
  description: "Unknown tool (conservative default profile)",
};

/**
 * Retrieve the effect profile for a tool by name.
 * Returns the registered profile if known, or a conservative default.
 */
export function getToolEffectProfile(toolName: string): ToolEffectProfile {
  const entry = CORE_EFFECT_REGISTRY.get(toolName);
  if (entry) {
    return {
      effects: [...entry.effects],
      trustTier: entry.trustTier,
      description: entry.description,
    };
  }
  return { ...DEFAULT_EFFECT_PROFILE, effects: [...DEFAULT_EFFECT_PROFILE.effects] };
}

/**
 * Check whether a tool name has an explicit entry in the core registry.
 */
export function isToolInRegistry(toolName: string): boolean {
  return CORE_EFFECT_REGISTRY.has(toolName);
}

/**
 * Returns a snapshot of all registered tool names and their effect profiles.
 * Useful for debugging and audit.
 */
export function getAllRegisteredProfiles(): ReadonlyMap<string, ToolEffectProfile> {
  const result = new Map<string, ToolEffectProfile>();
  for (const [name, entry] of CORE_EFFECT_REGISTRY) {
    result.set(name, {
      effects: [...entry.effects],
      trustTier: entry.trustTier,
      description: entry.description,
    });
  }
  return result;
}
