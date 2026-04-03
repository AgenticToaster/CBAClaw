import { describe, expect, it } from "vitest";
import { deriveEffectsFromHeuristic } from "./implied-consent-heuristic.js";

describe("deriveEffectsFromHeuristic", () => {
  it("returns default read+compose for informational queries", () => {
    expect(deriveEffectsFromHeuristic("What time is it?")).toEqual(["read", "compose"]);
    expect(deriveEffectsFromHeuristic("Tell me about quantum physics")).toEqual([
      "read",
      "compose",
    ]);
  });

  it("detects execution keywords", () => {
    const effects = deriveEffectsFromHeuristic("Run the test suite");
    expect(effects).toContain("exec");
    expect(effects).toContain("read");
    expect(effects).toContain("compose");
  });

  it("detects file writing keywords", () => {
    const effects = deriveEffectsFromHeuristic("Create a new config file");
    expect(effects).toContain("persist");
    expect(effects).toContain("read");
    expect(effects).toContain("compose");
  });

  it("detects deletion keywords", () => {
    const effects = deriveEffectsFromHeuristic("Delete the temporary files");
    expect(effects).toContain("irreversible");
  });

  it("detects communication keywords", () => {
    const effects = deriveEffectsFromHeuristic("Send a message to the team");
    expect(effects).toContain("disclose");
  });

  it("detects network keywords", () => {
    const effects = deriveEffectsFromHeuristic("Search the web for documentation");
    expect(effects).toContain("network");
    expect(effects).toContain("read");
  });

  it("detects elevated/admin keywords", () => {
    const effects = deriveEffectsFromHeuristic("Set up a cron job for daily backups");
    expect(effects).toContain("elevated");
  });

  it("detects audience-expand keywords", () => {
    const effects = deriveEffectsFromHeuristic("Invite new members to the workspace");
    expect(effects).toContain("audience-expand");
  });

  it("detects physical keywords", () => {
    const effects = deriveEffectsFromHeuristic("Turn on the hardware device");
    expect(effects).toContain("physical");
  });

  it("handles compound requests with multiple effect categories", () => {
    const effects = deriveEffectsFromHeuristic(
      "Write a script, run it, and send the results to Slack",
    );
    expect(effects).toContain("persist");
    expect(effects).toContain("exec");
    expect(effects).toContain("disclose");
    expect(effects).toContain("read");
    expect(effects).toContain("compose");
  });

  it("is case-insensitive", () => {
    const effects = deriveEffectsFromHeuristic("EXECUTE the deployment script");
    expect(effects).toContain("exec");
  });

  it("always includes read and compose when any rule matches", () => {
    const effects = deriveEffectsFromHeuristic("Delete everything");
    expect(effects).toContain("read");
    expect(effects).toContain("compose");
    expect(effects).toContain("irreversible");
  });

  it("returns unique effects without duplicates", () => {
    const effects = deriveEffectsFromHeuristic("Write a file and save it");
    const unique = new Set(effects);
    expect(effects.length).toBe(unique.size);
  });

  it("detects cleanup/purge as irreversible", () => {
    expect(deriveEffectsFromHeuristic("Purge all expired sessions")).toContain("irreversible");
    expect(deriveEffectsFromHeuristic("Clean up the build artifacts")).toContain("irreversible");
    expect(deriveEffectsFromHeuristic("Wipe the cache")).toContain("irreversible");
  });

  it("detects build/install/deploy as exec", () => {
    expect(deriveEffectsFromHeuristic("Build the project")).toContain("exec");
    expect(deriveEffectsFromHeuristic("Install the dependencies")).toContain("exec");
    expect(deriveEffectsFromHeuristic("Deploy to production")).toContain("exec");
  });
});
