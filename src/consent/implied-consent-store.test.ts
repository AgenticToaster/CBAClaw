import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConsentPatternStore } from "./implied-consent-store.js";

let sqliteAvailable = false;
let vecAvailable = false;
let DatabaseSync: typeof import("node:sqlite").DatabaseSync;

beforeAll(async () => {
  try {
    const sqlite = await import("node:sqlite");
    DatabaseSync = sqlite.DatabaseSync;
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }

  if (sqliteAvailable) {
    try {
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

function makeEmbedding(values: number[]): Float32Array {
  if (values.length !== DIM) {
    throw new Error(`Expected ${DIM} values, got ${values.length}`);
  }
  return new Float32Array(values);
}

describe.runIf(sqliteAvailable && vecAvailable)("ConsentPatternStore (sqlite-vec)", () => {
  let store: ConsentPatternStore;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `consent-store-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (store) {
      store.close();
    }
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function createStore(): Promise<ConsentPatternStore> {
    const dbPath = join(tmpDir, `test-${Date.now()}.sqlite`);
    const { openConsentPatternStore } = await import("./implied-consent-store.js");
    store = await openConsentPatternStore({
      dbPath,
      embeddingDimension: DIM,
    });
    return store;
  }

  it("creates a new store with the correct schema", async () => {
    const s = await createStore();
    expect(s.getEmbeddingDimension()).toBe(DIM);
    expect(s.getPatternCount()).toBe(0);
  });

  it("inserts and retrieves a pattern", async () => {
    const s = await createStore();
    const embedding = makeEmbedding([1, 0, 0, 0]);

    const pattern = s.insertPattern({
      text: "Read the file",
      effects: ["read", "compose"],
      source: "seed",
      embedding,
    });

    expect(pattern.id).toBeGreaterThan(0);
    expect(pattern.text).toBe("Read the file");
    expect(pattern.effects).toEqual(["read", "compose"]);
    expect(pattern.source).toBe("seed");
    expect(pattern.confidence).toBe(1.0);

    const retrieved = s.getPatternById(pattern.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.text).toBe("Read the file");

    const byText = s.getPatternByText("Read the file");
    expect(byText).toBeDefined();
    expect(byText!.id).toBe(pattern.id);
  });

  it("upserts an existing pattern", async () => {
    const s = await createStore();
    const embedding = makeEmbedding([1, 0, 0, 0]);

    s.insertPattern({
      text: "Delete the file",
      effects: ["irreversible"],
      source: "seed",
      embedding,
    });

    const updated = s.upsertPattern({
      text: "Delete the file",
      effects: ["irreversible", "persist"],
      source: "admin",
      confidence: 0.9,
      embedding: makeEmbedding([0, 1, 0, 0]),
    });

    expect(updated.effects).toEqual(["irreversible", "persist"]);
    expect(updated.source).toBe("admin");
    expect(updated.confidence).toBe(0.9);
    expect(s.getPatternCount()).toBe(1);
  });

  it("deletes a pattern and its embedding", async () => {
    const s = await createStore();
    const embedding = makeEmbedding([1, 0, 0, 0]);

    const pattern = s.insertPattern({
      text: "Test pattern",
      effects: ["read"],
      source: "seed",
      embedding,
    });

    expect(s.deletePattern(pattern.id)).toBe(true);
    expect(s.getPatternById(pattern.id)).toBeUndefined();
    expect(s.deletePattern(pattern.id)).toBe(false);
  });

  it("gets all patterns", async () => {
    const s = await createStore();
    s.insertPattern({
      text: "Pattern 1",
      effects: ["read"],
      source: "seed",
      embedding: makeEmbedding([1, 0, 0, 0]),
    });
    s.insertPattern({
      text: "Pattern 2",
      effects: ["exec"],
      source: "seed",
      embedding: makeEmbedding([0, 1, 0, 0]),
    });

    const all = s.getAllPatterns();
    expect(all.length).toBe(2);
    expect(all[0].text).toBe("Pattern 1");
    expect(all[1].text).toBe("Pattern 2");
  });

  it("performs vector similarity search", async () => {
    const s = await createStore();

    s.insertPattern({
      text: "Read the documentation",
      effects: ["read", "compose"],
      source: "seed",
      embedding: makeEmbedding([1, 0, 0, 0]),
    });
    s.insertPattern({
      text: "Execute the test suite",
      effects: ["exec"],
      source: "seed",
      embedding: makeEmbedding([0, 1, 0, 0]),
    });
    s.insertPattern({
      text: "Delete the temp files",
      effects: ["irreversible"],
      source: "seed",
      embedding: makeEmbedding([0, 0, 1, 0]),
    });

    // Query close to "Read" pattern
    const results = s.searchSimilarPatterns(makeEmbedding([0.9, 0.1, 0, 0]), 3, 1.0);
    expect(results.length).toBeGreaterThan(0);

    // Closest should be the "Read" pattern
    expect(results[0].pattern.text).toBe("Read the documentation");
    expect(results[0].distance).toBeLessThan(0.5);
  });

  it("respects the distance threshold in vector search", async () => {
    const s = await createStore();

    s.insertPattern({
      text: "Read the docs",
      effects: ["read"],
      source: "seed",
      embedding: makeEmbedding([1, 0, 0, 0]),
    });
    s.insertPattern({
      text: "Execute something",
      effects: ["exec"],
      source: "seed",
      embedding: makeEmbedding([0, 1, 0, 0]),
    });

    // Very tight threshold -- orthogonal vectors should have distance ~1.0
    // so only the near-exact match should survive a threshold of 0.1
    const results = s.searchSimilarPatterns(makeEmbedding([1, 0, 0, 0]), 2, 0.1);
    expect(results.every((r) => r.distance <= 0.1)).toBe(true);
  });

  it("rejects embeddings with wrong dimension", async () => {
    const s = await createStore();
    expect(() =>
      s.insertPattern({
        text: "wrong dim",
        effects: ["read"],
        source: "seed",
        embedding: new Float32Array([1, 0]),
      }),
    ).toThrow(/dimension mismatch/);
  });

  it("stores and retrieves metadata", async () => {
    const s = await createStore();
    s.setMeta("test_key", "test_value");
    expect(s.getMeta("test_key")).toBe("test_value");
    expect(s.getMeta("nonexistent")).toBeUndefined();
  });

  it("enforces unique text constraint via insertPattern", async () => {
    const s = await createStore();
    s.insertPattern({
      text: "Unique text",
      effects: ["read"],
      source: "seed",
      embedding: makeEmbedding([1, 0, 0, 0]),
    });

    expect(() =>
      s.insertPattern({
        text: "Unique text",
        effects: ["exec"],
        source: "seed",
        embedding: makeEmbedding([0, 1, 0, 0]),
      }),
    ).toThrow();
  });
});

describe.runIf(sqliteAvailable && vecAvailable)("seedConsentPatternStore", () => {
  let store: ConsentPatternStore;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `consent-seed-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("seeds the store with patterns and marks as seeded", async () => {
    const { openConsentPatternStore, seedConsentPatternStore } =
      await import("./implied-consent-store.js");

    const dbPath = join(tmpDir, `seed-test-${Date.now()}.sqlite`);
    store = await openConsentPatternStore({ dbPath, embeddingDimension: DIM });

    const seedData = [
      { text: "Read a file", effects: ["read", "compose"] as const },
      { text: "Run a command", effects: ["exec"] as const },
    ];

    const mockEmbedder = async (texts: string[]) =>
      texts.map((_, i) => {
        const arr = Array.from<number>({ length: DIM }).fill(0);
        arr[i % DIM] = 1;
        return arr;
      });

    const inserted = await seedConsentPatternStore({
      store,
      seedData,
      embedder: mockEmbedder,
    });

    expect(inserted).toBe(2);
    expect(store.getPatternCount()).toBe(2);
    expect(store.getMeta("seeded")).toBe("true");
  });

  it("skips seeding when already seeded", async () => {
    const { openConsentPatternStore, seedConsentPatternStore } =
      await import("./implied-consent-store.js");

    const dbPath = join(tmpDir, `seed-skip-${Date.now()}.sqlite`);
    store = await openConsentPatternStore({ dbPath, embeddingDimension: DIM });

    const mockEmbedder = async (texts: string[]) =>
      texts.map(() => Array.from<number>({ length: DIM }).fill(0));

    store.setMeta("seeded", "true");

    const inserted = await seedConsentPatternStore({
      store,
      seedData: [{ text: "Test", effects: ["read"] as const }],
      embedder: mockEmbedder,
    });

    expect(inserted).toBe(0);
    expect(store.getPatternCount()).toBe(0);
  });
});

describe("resolveConsentStorePath", () => {
  it("builds the correct path from a state dir", async () => {
    const { resolveConsentStorePath } = await import("./implied-consent-store.js");
    const path = resolveConsentStorePath("/home/test/.openclaw");
    expect(path).toBe("/home/test/.openclaw/consent/consent-patterns.sqlite");
  });
});
