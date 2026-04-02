import { describe, expect, it } from "vitest";
import {
  getAllRegisteredProfiles,
  getToolEffectProfile,
  isToolInRegistry,
} from "./effect-registry.js";
import { EFFECT_CLASSES } from "./types.js";

describe("effect-registry", () => {
  describe("getToolEffectProfile", () => {
    it("returns registered profile for known tools", () => {
      const readProfile = getToolEffectProfile("read");
      expect(readProfile.effects).toEqual(["read"]);
      expect(readProfile.trustTier).toBe("in-process");
    });

    it("returns exec + irreversible for exec tool", () => {
      const profile = getToolEffectProfile("exec");
      expect(profile.effects).toContain("exec");
      expect(profile.effects).toContain("irreversible");
    });

    it("returns network + read for web_search", () => {
      const profile = getToolEffectProfile("web_search");
      expect(profile.effects).toContain("network");
      expect(profile.effects).toContain("read");
      expect(profile.trustTier).toBe("external");
    });

    it("returns disclose for message tool", () => {
      const profile = getToolEffectProfile("message");
      expect(profile.effects).toContain("disclose");
    });

    it("returns elevated for gateway tool", () => {
      const profile = getToolEffectProfile("gateway");
      expect(profile.effects).toContain("elevated");
    });

    it("returns conservative default for unknown tools", () => {
      const profile = getToolEffectProfile("unknown_mystery_tool");
      expect(profile.effects).toEqual(["read", "compose", "persist", "network"]);
      expect(profile.trustTier).toBe("external");
      expect(profile.description).toContain("Unknown tool");
    });

    it("returns a fresh copy of the effects array (not shared reference)", () => {
      const a = getToolEffectProfile("read");
      const b = getToolEffectProfile("read");
      expect(a.effects).toEqual(b.effects);
      expect(a.effects).not.toBe(b.effects);
    });

    it("returns a fresh copy for default profiles too", () => {
      const a = getToolEffectProfile("nonexistent_1");
      const b = getToolEffectProfile("nonexistent_2");
      a.effects.push("physical");
      expect(b.effects).not.toContain("physical");
    });
  });

  describe("isToolInRegistry", () => {
    it("returns true for known tools", () => {
      expect(isToolInRegistry("exec")).toBe(true);
      expect(isToolInRegistry("read")).toBe(true);
      expect(isToolInRegistry("message")).toBe(true);
      expect(isToolInRegistry("web_fetch")).toBe(true);
    });

    it("returns false for unknown tools", () => {
      expect(isToolInRegistry("totally_fake")).toBe(false);
    });
  });

  describe("getAllRegisteredProfiles", () => {
    it("returns a non-empty map", () => {
      const profiles = getAllRegisteredProfiles();
      expect(profiles.size).toBeGreaterThan(0);
    });

    it("includes key tools", () => {
      const profiles = getAllRegisteredProfiles();
      expect(profiles.has("exec")).toBe(true);
      expect(profiles.has("read")).toBe(true);
      expect(profiles.has("write")).toBe(true);
      expect(profiles.has("message")).toBe(true);
    });

    it("all effect classes in registry entries are valid", () => {
      const validEffects = new Set<string>(EFFECT_CLASSES);
      const profiles = getAllRegisteredProfiles();
      for (const [name, profile] of profiles) {
        for (const effect of profile.effects) {
          expect(validEffects.has(effect), `Invalid effect "${effect}" on tool "${name}"`).toBe(
            true,
          );
        }
      }
    });
  });

  describe("coverage of dangerous tools", () => {
    const dangerousTools = [
      "exec",
      "spawn",
      "shell",
      "fs_write",
      "fs_delete",
      "fs_move",
      "apply_patch",
      "sessions_spawn",
      "sessions_send",
      "cron",
      "gateway",
      "nodes",
      "whatsapp_login",
    ];

    for (const tool of dangerousTools) {
      it(`has registry entry for dangerous tool: ${tool}`, () => {
        expect(isToolInRegistry(tool)).toBe(true);
      });
    }
  });
});
