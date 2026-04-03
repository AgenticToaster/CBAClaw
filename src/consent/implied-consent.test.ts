import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MemoryEmbeddingProvider } from "../plugins/memory-embedding-providers.js";
import type { ConsentPatternStore } from "./implied-consent-store.js";
import type { EffectClass } from "./types.js";

let sqliteAvailable = false;
let vecAvailable = false;

beforeAll(async () => {
  try {
    await import("node:sqlite");
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }

  if (sqliteAvailable) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(":memory:");
      const { loadSqliteVecExtension } =
        await import("../../packages/memory-host-sdk/src/host/sqlite-vec.js");
      const result = await loadSqliteVecExtension({ db });
      vecAvailable = result.ok;
      db.close();
    } catch {
      vecAvailable = false;
    }
  }
});

const DIM = 4;

function createMockEmbeddingProvider(): MemoryEmbeddingProvider {
  const keywordVectors: Record<string, number[]> = {
    read: [1, 0, 0, 0],
    exec: [0, 1, 0, 0],
    delete: [0, 0, 1, 0],
    send: [0, 0, 0, 1],
  };

  function textToVector(text: string): number[] {
    const lower = text.toLowerCase();
    const vec = [0, 0, 0, 0];
    for (const [keyword, kv] of Object.entries(keywordVectors)) {
      if (lower.includes(keyword)) {
        for (let i = 0; i < DIM; i++) {
          vec[i] += kv[i];
        }
      }
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (mag > 0) {
      for (let i = 0; i < DIM; i++) {
        vec[i] /= mag;
      }
    } else {
      vec[0] = 1;
    }
    return vec;
  }

  return {
    id: "mock-embedding",
    model: "mock-model",
    embedQuery: async (text: string) => textToVector(text),
    embedBatch: async (texts: string[]) => texts.map(textToVector),
  };
}

describe.runIf(sqliteAvailable && vecAvailable)("deriveImpliedEffects (vector)", () => {
  let store: ConsentPatternStore;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `consent-derive-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    const { __testing } = await import("./implied-consent.js");
    __testing.resetStore();
    if (store) {
      store.close();
    }
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function createSeededStore(): Promise<ConsentPatternStore> {
    const { openConsentPatternStore, seedConsentPatternStore } =
      await import("./implied-consent-store.js");
    const dbPath = join(tmpDir, `derive-${Date.now()}.sqlite`);
    store = await openConsentPatternStore({ dbPath, embeddingDimension: DIM });

    const seedData = [
      { text: "Read the documentation", effects: ["read", "compose"] as EffectClass[] },
      { text: "Execute the test suite", effects: ["exec"] as EffectClass[] },
      { text: "Delete all temp files", effects: ["irreversible"] as EffectClass[] },
      { text: "Send a message to the team", effects: ["disclose"] as EffectClass[] },
    ];

    const provider = createMockEmbeddingProvider();
    await seedConsentPatternStore({
      store,
      seedData,
      embedder: (texts) => provider.embedBatch(texts),
    });

    return store;
  }

  it("derives read+compose effects for a read-like query", async () => {
    const { deriveImpliedEffects } = await import("./implied-consent.js");
    const s = await createSeededStore();
    const provider = createMockEmbeddingProvider();

    const effects = await deriveImpliedEffects({
      requestText: "Read the README file",
      embeddingProvider: provider,
      store: s,
      consentConfig: { mode: "vector" },
    });

    expect(effects).toContain("read");
    expect(effects).toContain("compose");
  });

  it("derives exec effects for an execution query", async () => {
    const { deriveImpliedEffects } = await import("./implied-consent.js");
    const s = await createSeededStore();
    const provider = createMockEmbeddingProvider();

    const effects = await deriveImpliedEffects({
      requestText: "Execute the build process",
      embeddingProvider: provider,
      store: s,
      consentConfig: { mode: "vector" },
    });

    expect(effects).toContain("exec");
  });

  it("merges vector and heuristic effects in both mode", async () => {
    const { deriveImpliedEffects } = await import("./implied-consent.js");
    const s = await createSeededStore();
    const provider = createMockEmbeddingProvider();

    const effects = await deriveImpliedEffects({
      requestText: "Delete the temporary files",
      embeddingProvider: provider,
      store: s,
      consentConfig: { mode: "both" },
    });

    // Vector search should find "delete" pattern -> irreversible
    expect(effects).toContain("irreversible");
    // Heuristic should also fire for "delete" -> irreversible + read + compose
    expect(effects).toContain("read");
    expect(effects).toContain("compose");
  });

  it("falls back to heuristic when vector search fails", async () => {
    const { deriveImpliedEffects } = await import("./implied-consent.js");

    const failingProvider: MemoryEmbeddingProvider = {
      id: "failing-mock",
      model: "failing-model",
      embedQuery: async () => {
        throw new Error("embedding service down");
      },
      embedBatch: async () => {
        throw new Error("embedding service down");
      },
    };

    const effects = await deriveImpliedEffects({
      requestText: "Run the test suite",
      embeddingProvider: failingProvider,
      consentConfig: { mode: "both" },
    });

    // Should fall back to heuristic: "Run" -> exec
    expect(effects).toContain("exec");
    expect(effects).toContain("read");
    expect(effects).toContain("compose");
  });
});

describe("deriveImpliedEffects (heuristic-only mode)", () => {
  it("uses only heuristic when mode is heuristic", async () => {
    const { deriveImpliedEffects } = await import("./implied-consent.js");

    const effects = await deriveImpliedEffects({
      requestText: "Delete the old backups",
      consentConfig: { mode: "heuristic" },
    });

    expect(effects).toContain("irreversible");
    expect(effects).toContain("read");
    expect(effects).toContain("compose");
  });

  it("returns default effects for informational queries", async () => {
    const { deriveImpliedEffects } = await import("./implied-consent.js");

    const effects = await deriveImpliedEffects({
      requestText: "What is the meaning of life?",
      consentConfig: { mode: "heuristic" },
    });

    expect(effects).toEqual(["read", "compose"]);
  });
});

describe("__testing.mergeEffects", () => {
  it("unions multiple effect arrays", async () => {
    const { __testing } = await import("./implied-consent.js");
    const result = __testing.mergeEffects(["read", "compose"], ["exec", "read"], ["persist"]);
    expect(result).toContain("read");
    expect(result).toContain("compose");
    expect(result).toContain("exec");
    expect(result).toContain("persist");
    expect(new Set(result).size).toBe(result.length);
  });

  it("returns default effects for empty input", async () => {
    const { __testing } = await import("./implied-consent.js");
    const result = __testing.mergeEffects([], []);
    expect(result).toEqual(["read", "compose"]);
  });
});
