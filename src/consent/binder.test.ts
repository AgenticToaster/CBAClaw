import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  configureSigningKey,
  decodeWorkOrderToken,
  mintInitialWorkOrder,
  mintSuccessorWorkOrder,
  verifyConsentAnchorAgainstRecords,
  verifyToolAgainstWO,
  verifyWorkOrderIntegrity,
} from "./binder.js";
import type {
  BinderMintInput,
  BinderRequalifyInput,
  ConsentRecord,
  EAARecord,
  PurchaseOrder,
  ToolEffectProfile,
  WorkOrder,
} from "./types.js";

function makePO(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: "po-1",
    requestText: "Write a file",
    senderId: "user-1",
    senderIsOwner: true,
    impliedEffects: ["read", "compose", "persist"],
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a sealed (JWT-signed + frozen) WorkOrder for testing.
 * Uses the binder's sealWorkOrder so integrity checks pass.
 */
function makeWO(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return __testing.sealWorkOrder({
    id: "wo-1",
    requestContextId: "po-1",
    grantedEffects: ["read", "compose", "persist"],
    constraints: [],
    consentAnchors: [{ kind: "implied", poId: "po-1" }],
    mintedAt: Date.now(),
    expiresAt: Date.now() + __testing.DEFAULT_WO_TTL_MS,
    immutable: true,
    token: "",
    ...overrides,
  });
}

/**
 * Create an unsealed WorkOrder with an invalid token for
 * tamper-detection tests. Simulates a forgery or mutation.
 */
function makeUnsealedWO(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: "wo-tampered",
    requestContextId: "po-1",
    grantedEffects: ["read", "compose", "persist"],
    constraints: [],
    consentAnchors: [{ kind: "implied", poId: "po-1" }],
    mintedAt: Date.now(),
    expiresAt: Date.now() + __testing.DEFAULT_WO_TTL_MS,
    immutable: true,
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IndvK2p3dCJ9.eyJmYWtlIjp0cnVlfQ.invalid",
    ...overrides,
  };
}

describe("binder", () => {
  afterEach(() => {
    __testing.restore();
  });

  describe("mintInitialWorkOrder", () => {
    it("mints a WO with grants from PO implied effects", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };

      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.wo.grantedEffects).toEqual(["read", "compose", "persist"]);
      expect(result.wo.requestContextId).toBe("po-1");
      expect(result.wo.immutable).toBe(true);
      expect(result.wo.consentAnchors).toEqual([{ kind: "implied", poId: "po-1" }]);
      expect(result.wo.id).toBeTruthy();
      expect(result.wo.mintedAt).toBeGreaterThan(0);
      expect(result.wo.expiresAt).toBeGreaterThan(result.wo.mintedAt);
    });

    it("removes system-prohibited effects from grants", () => {
      const input: BinderMintInput = {
        po: makePO({ impliedEffects: ["read", "compose", "exec"] }),
        policies: [],
        systemProhibitions: ["exec"],
      };

      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.wo.grantedEffects).toEqual(["read", "compose"]);
      expect(result.wo.grantedEffects).not.toContain("exec");
    });

    it("refuses when all effects are prohibited", () => {
      const input: BinderMintInput = {
        po: makePO({ impliedEffects: ["exec"] }),
        policies: [],
        systemProhibitions: ["exec"],
      };

      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.code).toBe("system-prohibited");
    });

    it("includes a default time-bound constraint", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };

      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const timeBound = result.wo.constraints.find((c) => c.kind === "time-bound");
      expect(timeBound).toBeDefined();
    });

    it("uses a single timestamp for WO expiresAt and constraint expiresAt", () => {
      const fixedTime = 1700000000000;
      __testing.setNow(() => fixedTime);
      __testing.setGenerateId(() => "deterministic-id");

      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };

      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const expectedExpiry = fixedTime + __testing.DEFAULT_WO_TTL_MS;
      expect(result.wo.id).toBe("deterministic-id");
      expect(result.wo.mintedAt).toBe(fixedTime);
      expect(result.wo.expiresAt).toBe(expectedExpiry);

      const timeBound = result.wo.constraints.find((c) => c.kind === "time-bound");
      expect(timeBound).toBeDefined();
      if (timeBound?.kind === "time-bound") {
        expect(timeBound.expiresAt).toBe(expectedExpiry);
      }
    });
  });

  describe("mintSuccessorWorkOrder", () => {
    it("mints a successor WO with expanded grants", () => {
      const currentWO = makeWO();
      const profile: ToolEffectProfile = {
        effects: ["read", "compose", "persist", "disclose"],
        trustTier: "in-process",
      };

      const input: BinderRequalifyInput = {
        currentWO,
        po: makePO(),
        stepEffectProfile: profile,
        newAnchors: [{ kind: "explicit", consentRecordId: "cr-1" }],
        additionalEffects: ["disclose"],
        policies: [],
        systemProhibitions: [],
      };

      const result = mintSuccessorWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.wo.grantedEffects).toContain("disclose");
      expect(result.wo.predecessorId).toBe(currentWO.id);
      expect(result.wo.consentAnchors).toContainEqual({
        kind: "explicit",
        consentRecordId: "cr-1",
      });
    });

    it("refuses when current WO is expired", () => {
      const currentWO = makeWO({ expiresAt: Date.now() - 1000 });

      const input: BinderRequalifyInput = {
        currentWO,
        po: makePO(),
        stepEffectProfile: { effects: ["read"], trustTier: "in-process" },
        newAnchors: [],
        additionalEffects: [],
        policies: [],
        systemProhibitions: [],
      };

      const result = mintSuccessorWorkOrder(input);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe("expired");
    });

    it("refuses when additional effects lack consent anchors", () => {
      const input: BinderRequalifyInput = {
        currentWO: makeWO(),
        po: makePO(),
        stepEffectProfile: { effects: ["read", "disclose"], trustTier: "in-process" },
        newAnchors: [],
        additionalEffects: ["disclose"],
        policies: [],
        systemProhibitions: [],
      };

      const result = mintSuccessorWorkOrder(input);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe("no-consent-anchor");
    });

    it("refuses when consent anchor is structurally invalid", () => {
      const input: BinderRequalifyInput = {
        currentWO: makeWO(),
        po: makePO(),
        stepEffectProfile: { effects: ["read", "disclose"], trustTier: "in-process" },
        newAnchors: [{ kind: "explicit", consentRecordId: "" }],
        additionalEffects: ["disclose"],
        policies: [],
        systemProhibitions: [],
      };

      const result = mintSuccessorWorkOrder(input);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe("invalid-consent-anchor");
    });

    it("applies ceiling check from step effect profile", () => {
      const input: BinderRequalifyInput = {
        currentWO: makeWO({ grantedEffects: ["read", "compose", "persist", "exec"] }),
        po: makePO(),
        stepEffectProfile: { effects: ["read"], trustTier: "in-process" },
        newAnchors: [],
        additionalEffects: [],
        policies: [],
        systemProhibitions: [],
      };

      const result = mintSuccessorWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.wo.grantedEffects).toEqual(["read"]);
    });

    it("removes system-prohibited effects from successor", () => {
      const input: BinderRequalifyInput = {
        currentWO: makeWO(),
        po: makePO(),
        stepEffectProfile: { effects: ["read", "compose", "persist"], trustTier: "in-process" },
        newAnchors: [],
        additionalEffects: [],
        policies: [],
        systemProhibitions: ["persist"],
      };

      const result = mintSuccessorWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.wo.grantedEffects).not.toContain("persist");
    });

    it("refuses requalification when currentWO has been tampered with", () => {
      const tampered: WorkOrder = {
        ...makeWO(),
        grantedEffects: ["read", "compose", "persist", "exec", "physical"],
        token: makeWO().token,
      };

      const input: BinderRequalifyInput = {
        currentWO: tampered,
        po: makePO(),
        stepEffectProfile: { effects: ["read", "exec", "physical"], trustTier: "in-process" },
        newAnchors: [],
        additionalEffects: [],
        policies: [],
        systemProhibitions: [],
      };

      const result = mintSuccessorWorkOrder(input);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe("integrity-violation");
    });
  });

  describe("verifyToolAgainstWO", () => {
    it("passes when tool effects are fully covered", () => {
      const wo = makeWO({ grantedEffects: ["read", "compose", "persist"] });
      const result = verifyToolAgainstWO(
        "write",
        { effects: ["persist"], trustTier: "in-process" },
        wo,
      );
      expect(result.ok).toBe(true);
    });

    it("fails when tool requires uncovered effects", () => {
      const wo = makeWO({ grantedEffects: ["read", "compose"] });
      const result = verifyToolAgainstWO(
        "message",
        { effects: ["disclose"], trustTier: "in-process" },
        wo,
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe("effect-not-granted");
      expect(result.missingEffects).toEqual(["disclose"]);
    });

    it("fails when WO is expired", () => {
      const wo = makeWO({ expiresAt: Date.now() - 1000 });
      const result = verifyToolAgainstWO(
        "read",
        { effects: ["read"], trustTier: "in-process" },
        wo,
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe("wo-expired");
    });

    it("uses registry lookup when no profile is provided", () => {
      const wo = makeWO({ grantedEffects: ["read"] });
      const result = verifyToolAgainstWO("read", undefined, wo);
      expect(result.ok).toBe(true);
    });

    it("fails constraint check for expired time-bound constraint", () => {
      const wo = makeWO({
        grantedEffects: ["read"],
        expiresAt: Date.now() + 60000,
        constraints: [{ kind: "time-bound", expiresAt: Date.now() - 1000 }],
      });
      const result = verifyToolAgainstWO(
        "read",
        { effects: ["read"], trustTier: "in-process" },
        wo,
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe("constraint-violated");
    });
  });

  describe("verifyConsentAnchorAgainstRecords", () => {
    it("accepts implied anchors unconditionally", () => {
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "implied", poId: "po-1" },
        ["read"],
        [],
        [],
      );
      expect(result.valid).toBe(true);
    });

    it("accepts explicit anchor with matching granted record", () => {
      const records: ConsentRecord[] = [
        {
          id: "cr-1",
          poId: "po-1",
          woId: "wo-1",
          effectClasses: ["disclose"],
          decision: "granted",
          timestamp: Date.now(),
        },
      ];
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "explicit", consentRecordId: "cr-1" },
        ["disclose"],
        records,
        [],
      );
      expect(result.valid).toBe(true);
    });

    it("rejects explicit anchor with denied record", () => {
      const records: ConsentRecord[] = [
        {
          id: "cr-1",
          poId: "po-1",
          woId: "wo-1",
          effectClasses: ["disclose"],
          decision: "denied",
          timestamp: Date.now(),
        },
      ];
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "explicit", consentRecordId: "cr-1" },
        ["disclose"],
        records,
        [],
      );
      expect(result.valid).toBe(false);
    });

    it("rejects explicit anchor for missing record", () => {
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "explicit", consentRecordId: "cr-missing" },
        ["disclose"],
        [],
        [],
      );
      expect(result.valid).toBe(false);
    });

    it("rejects explicit anchor when record doesn't cover needed effects", () => {
      const records: ConsentRecord[] = [
        {
          id: "cr-1",
          poId: "po-1",
          woId: "wo-1",
          effectClasses: ["read"],
          decision: "granted",
          timestamp: Date.now(),
        },
      ];
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "explicit", consentRecordId: "cr-1" },
        ["disclose"],
        records,
        [],
      );
      expect(result.valid).toBe(false);
    });

    it("rejects expired explicit anchor", () => {
      const records: ConsentRecord[] = [
        {
          id: "cr-1",
          poId: "po-1",
          woId: "wo-1",
          effectClasses: ["disclose"],
          decision: "granted",
          timestamp: Date.now() - 60000,
          expiresAt: Date.now() - 1000,
        },
      ];
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "explicit", consentRecordId: "cr-1" },
        ["disclose"],
        records,
        [],
      );
      expect(result.valid).toBe(false);
    });

    it("accepts EAA anchor with proceed outcome", () => {
      const eaaRecords: EAARecord[] = [
        {
          id: "eaa-1",
          poId: "po-1",
          woId: "wo-1",
          triggerReason: "ambiguous standing",
          outcome: "proceed",
          recommendedEffects: ["disclose"],
          recommendedConstraints: [],
          createdAt: Date.now(),
        },
      ];
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "eaa", eaaRecordId: "eaa-1" },
        ["disclose"],
        [],
        eaaRecords,
      );
      expect(result.valid).toBe(true);
    });

    it("rejects EAA anchor with refuse outcome", () => {
      const eaaRecords: EAARecord[] = [
        {
          id: "eaa-1",
          poId: "po-1",
          woId: "wo-1",
          triggerReason: "duty collision",
          outcome: "refuse",
          recommendedEffects: [],
          recommendedConstraints: [],
          createdAt: Date.now(),
        },
      ];
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "eaa", eaaRecordId: "eaa-1" },
        ["disclose"],
        [],
        eaaRecords,
      );
      expect(result.valid).toBe(false);
    });

    it("rejects EAA anchor for missing record", () => {
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "eaa", eaaRecordId: "eaa-missing" },
        ["disclose"],
        [],
        [],
      );
      expect(result.valid).toBe(false);
    });

    it("accepts policy anchors (Phase 5 stub)", () => {
      const result = verifyConsentAnchorAgainstRecords(
        { kind: "policy", policyId: "pol-1" },
        ["read"],
        [],
        [],
      );
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // JWT Token Integrity Tests
  // ---------------------------------------------------------------------------

  describe("WO token integrity (JWS HS256)", () => {
    it("minted WOs carry a valid 3-part JWT token", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const parts = result.wo.token.split(".");
      expect(parts).toHaveLength(3);

      // Verify the header is wo+jwt / HS256
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      expect(header).toEqual({ alg: "HS256", typ: "wo+jwt" });
    });

    it("JWT payload contains the WO content fields", () => {
      const fixedTime = 1700000000000;
      __testing.setNow(() => fixedTime);
      __testing.setGenerateId(() => "wo-jwt-test");

      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const parts = result.wo.token.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

      expect(payload.id).toBe("wo-jwt-test");
      expect(payload.requestContextId).toBe("po-1");
      expect(payload.grantedEffects).toEqual(["read", "compose", "persist"]);
      expect(payload.mintedAt).toBe(fixedTime);
      expect(payload.expiresAt).toBe(fixedTime + __testing.DEFAULT_WO_TTL_MS);
      expect(payload.consentAnchors).toEqual([{ kind: "implied", poId: "po-1" }]);
    });

    it("verifyWorkOrderIntegrity returns ok for binder-minted WOs", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const integrity = verifyWorkOrderIntegrity(result.wo);
      expect(integrity.ok).toBe(true);
    });

    it("detects forged/invalid JWT signature", () => {
      const wo = makeUnsealedWO();
      const integrity = verifyWorkOrderIntegrity(wo);
      expect(integrity.ok).toBe(false);
      if (integrity.ok) {
        return;
      }
      expect(integrity.reason).toContain("signature verification failed");
    });

    it("detects missing token", () => {
      const wo = {
        id: "wo-no-token",
        requestContextId: "po-1",
        grantedEffects: ["read"] as const,
        constraints: [] as const,
        consentAnchors: [{ kind: "implied" as const, poId: "po-1" }] as const,
        mintedAt: Date.now(),
        immutable: true as const,
        token: "",
      };
      const integrity = verifyWorkOrderIntegrity(wo);
      expect(integrity.ok).toBe(false);
      if (integrity.ok) {
        return;
      }
      expect(integrity.reason).toContain("missing token");
    });

    it("detects in-memory content divergence from token payload", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      // Create a new (unfrozen) object with a valid token but mutated fields
      const tampered = {
        ...result.wo,
        grantedEffects: ["read", "exec", "physical"],
      };
      const integrity = verifyWorkOrderIntegrity(tampered as WorkOrder);
      expect(integrity.ok).toBe(false);
      if (integrity.ok) {
        return;
      }
      expect(integrity.reason).toContain("in-memory tampering");
    });

    it("verifyToolAgainstWO rejects a forged WO before checking effects", () => {
      const wo = makeUnsealedWO();
      const result = verifyToolAgainstWO(
        "read",
        { effects: ["read"], trustTier: "in-process" },
        wo,
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe("integrity-failed");
    });

    it("minted WOs are deeply frozen", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(Object.isFrozen(result.wo)).toBe(true);
      expect(Object.isFrozen(result.wo.grantedEffects)).toBe(true);
      expect(Object.isFrozen(result.wo.constraints)).toBe(true);
      expect(Object.isFrozen(result.wo.consentAnchors)).toBe(true);
    });

    it("deeply freezes audience constraint allowedTargets array", () => {
      const wo = __testing.sealWorkOrder({
        id: "wo-audience-freeze",
        requestContextId: "po-1",
        grantedEffects: ["disclose"],
        constraints: [{ kind: "audience", allowedTargets: ["alice", "bob"] }],
        consentAnchors: [{ kind: "implied", poId: "po-1" }],
        mintedAt: Date.now(),
        immutable: true,
        token: "",
      });

      const targets = wo.constraints[0];
      expect(Object.isFrozen(targets)).toBe(true);
      if (targets.kind === "audience") {
        expect(Object.isFrozen(targets.allowedTargets)).toBe(true);
        expect(() => targets.allowedTargets.push("eve")).toThrow(TypeError);
      }
    });

    it("deeply freezes custom constraint payload", () => {
      const wo = __testing.sealWorkOrder({
        id: "wo-custom-freeze",
        requestContextId: "po-1",
        grantedEffects: ["read"],
        constraints: [{ kind: "custom", label: "test", payload: { nested: { deep: true } } }],
        consentAnchors: [{ kind: "implied", poId: "po-1" }],
        mintedAt: Date.now(),
        immutable: true,
        token: "",
      });

      const custom = wo.constraints[0];
      expect(Object.isFrozen(custom)).toBe(true);
      if (custom.kind === "custom") {
        expect(Object.isFrozen(custom.payload)).toBe(true);
        expect(Object.isFrozen(custom.payload.nested)).toBe(true);
        expect(() => {
          custom.payload.injected = "evil";
        }).toThrow(TypeError);
      }
    });

    it("frozen WO arrays reject mutation attempts", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const effects = result.wo.grantedEffects as string[];
      expect(() => effects.push("physical")).toThrow(TypeError);
    });

    it("successor WOs are also sealed with a valid JWT", () => {
      const currentWO = makeWO();
      const profile: ToolEffectProfile = {
        effects: ["read", "compose", "persist", "disclose"],
        trustTier: "in-process",
      };
      const input: BinderRequalifyInput = {
        currentWO,
        po: makePO(),
        stepEffectProfile: profile,
        newAnchors: [{ kind: "explicit", consentRecordId: "cr-1" }],
        additionalEffects: ["disclose"],
        policies: [],
        systemProhibitions: [],
      };

      const result = mintSuccessorWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(Object.isFrozen(result.wo)).toBe(true);
      expect(result.wo.token.split(".")).toHaveLength(3);
      const integrity = verifyWorkOrderIntegrity(result.wo);
      expect(integrity.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-Boundary Token Decode Tests
  // ---------------------------------------------------------------------------

  describe("decodeWorkOrderToken (cross-boundary)", () => {
    it("decodes a binder-minted token into a full WorkOrder", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const mintResult = mintInitialWorkOrder(input);
      expect(mintResult.ok).toBe(true);
      if (!mintResult.ok) {
        return;
      }

      const decodeResult = decodeWorkOrderToken(mintResult.wo.token);
      expect(decodeResult.ok).toBe(true);
      if (!decodeResult.ok) {
        return;
      }

      expect(decodeResult.wo.id).toBe(mintResult.wo.id);
      expect(decodeResult.wo.grantedEffects).toEqual([...mintResult.wo.grantedEffects]);
      expect(decodeResult.wo.requestContextId).toBe(mintResult.wo.requestContextId);
      expect(decodeResult.wo.mintedAt).toBe(mintResult.wo.mintedAt);
      expect(decodeResult.wo.expiresAt).toBe(mintResult.wo.expiresAt);
      expect(decodeResult.wo.immutable).toBe(true);
      expect(decodeResult.wo.token).toBe(mintResult.wo.token);
    });

    it("decoded WO is deeply frozen", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const mintResult = mintInitialWorkOrder(input);
      expect(mintResult.ok).toBe(true);
      if (!mintResult.ok) {
        return;
      }

      const decodeResult = decodeWorkOrderToken(mintResult.wo.token);
      expect(decodeResult.ok).toBe(true);
      if (!decodeResult.ok) {
        return;
      }

      expect(Object.isFrozen(decodeResult.wo)).toBe(true);
      expect(Object.isFrozen(decodeResult.wo.grantedEffects)).toBe(true);
    });

    it("decoded WO passes integrity verification", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const mintResult = mintInitialWorkOrder(input);
      expect(mintResult.ok).toBe(true);
      if (!mintResult.ok) {
        return;
      }

      const decodeResult = decodeWorkOrderToken(mintResult.wo.token);
      expect(decodeResult.ok).toBe(true);
      if (!decodeResult.ok) {
        return;
      }

      const integrity = verifyWorkOrderIntegrity(decodeResult.wo);
      expect(integrity.ok).toBe(true);
    });

    it("rejects a token with invalid signature", () => {
      const result = decodeWorkOrderToken(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IndvK2p3dCJ9.eyJmYWtlIjp0cnVlfQ.badsignature",
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain("signature verification failed");
    });

    it("rejects a malformed token string", () => {
      const result = decodeWorkOrderToken("not-a-jwt");
      expect(result.ok).toBe(false);
    });

    it("rejects a token with missing required fields in payload", () => {
      // Craft a valid JWT with the correct signing key but a payload
      // missing required WO fields (simulates cross-version drift or corruption)
      const key = Buffer.alloc(32, 0x77);
      __testing.setSigningKey(key);

      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "wo+jwt" }), "utf8").toString(
        "base64url",
      );
      const payload = Buffer.from(JSON.stringify({ id: "wo-partial" }), "utf8").toString(
        "base64url",
      );
      const signingInput = `${header}.${payload}`;
      const signature = createHmac("sha256", key).update(signingInput).digest("base64url");
      const badToken = `${signingInput}.${signature}`;

      const result = decodeWorkOrderToken(badToken);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain("missing required field");
    });

    it("rejects a token signed with a different key", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };

      const mintResult = mintInitialWorkOrder(input);
      expect(mintResult.ok).toBe(true);
      if (!mintResult.ok) {
        return;
      }
      const tokenFromKeyA = mintResult.wo.token;

      // Rotate to a different key
      __testing.setSigningKey(Buffer.alloc(32, 0xff));

      const decodeResult = decodeWorkOrderToken(tokenFromKeyA);
      expect(decodeResult.ok).toBe(false);
      if (decodeResult.ok) {
        return;
      }
      expect(decodeResult.reason).toContain("signature verification failed");
    });

    it("preserves optional fields (predecessorId, stepRef) through round-trip", () => {
      const currentWO = makeWO();
      const profile: ToolEffectProfile = {
        effects: ["read", "compose"],
        trustTier: "in-process",
        description: "test-step",
      };
      const input: BinderRequalifyInput = {
        currentWO,
        po: makePO(),
        stepEffectProfile: profile,
        newAnchors: [],
        additionalEffects: [],
        policies: [],
        systemProhibitions: [],
      };

      const mintResult = mintSuccessorWorkOrder(input);
      expect(mintResult.ok).toBe(true);
      if (!mintResult.ok) {
        return;
      }

      const decodeResult = decodeWorkOrderToken(mintResult.wo.token);
      expect(decodeResult.ok).toBe(true);
      if (!decodeResult.ok) {
        return;
      }

      expect(decodeResult.wo.predecessorId).toBe(currentWO.id);
      expect(decodeResult.wo.stepRef).toBe("test-step");
    });
  });

  // ---------------------------------------------------------------------------
  // Signing Key Configuration Tests
  // ---------------------------------------------------------------------------

  describe("configureSigningKey", () => {
    it("accepts a 32-byte Buffer", () => {
      expect(() => configureSigningKey(Buffer.alloc(32, 0xab))).not.toThrow();
    });

    it("accepts a base64-encoded string (>= 32 bytes decoded)", () => {
      const key = Buffer.alloc(32, 0xcd).toString("base64");
      expect(() => configureSigningKey(key)).not.toThrow();
    });

    it("rejects keys shorter than 32 bytes", () => {
      expect(() => configureSigningKey(Buffer.alloc(16))).toThrow("at least 256 bits");
    });

    it("tokens minted after key change verify with new key", () => {
      const newKey = Buffer.alloc(32, 0xef);
      configureSigningKey(newKey);

      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const integrity = verifyWorkOrderIntegrity(result.wo);
      expect(integrity.ok).toBe(true);
    });

    it("tokens minted before key change fail verification after rotation", () => {
      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      // Rotate key
      configureSigningKey(Buffer.alloc(32, 0x99));

      const integrity = verifyWorkOrderIntegrity(result.wo);
      expect(integrity.ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Interoperability: Token verifiable by raw crypto (simulates another language)
  // ---------------------------------------------------------------------------

  describe("interoperability (raw HMAC verification)", () => {
    it("token can be verified with raw node:crypto (simulating a non-TS consumer)", () => {
      const sharedKey = Buffer.alloc(32, 0x42);
      __testing.setSigningKey(sharedKey);

      const input: BinderMintInput = {
        po: makePO(),
        policies: [],
        systemProhibitions: [],
      };
      const result = mintInitialWorkOrder(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      // Simulate what a Python/Go/Rust JWT library would do:
      const parts = result.wo.token.split(".");
      expect(parts).toHaveLength(3);

      const [header, payload, signature] = parts;
      const signingInput = `${header}.${payload}`;

      // Recompute HMAC-SHA256 with the shared key
      const recomputed = createHmac("sha256", sharedKey).update(signingInput).digest("base64url");

      expect(recomputed).toBe(signature);

      // Decode payload
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      expect(decoded.id).toBe(result.wo.id);
      expect(decoded.grantedEffects).toEqual([...result.wo.grantedEffects]);
    });
  });

  describe("deterministic serialization", () => {
    it("payload is deterministic for identical inputs", () => {
      const wo1 = makeWO({ id: "wo-canon-test" });
      const wo2 = makeWO({ id: "wo-canon-test" });

      const p1 = __testing.deterministicStringify(__testing.extractWOPayloadFields(wo1));
      const p2 = __testing.deterministicStringify(__testing.extractWOPayloadFields(wo2));
      expect(p1).toBe(p2);
    });

    it("nested object keys are sorted (not just top-level)", () => {
      const result = __testing.deterministicStringify({
        z: 1,
        a: { c: 3, b: 2 },
      });
      // Top-level: a before z. Nested: b before c.
      expect(result).toBe('{"a":{"b":2,"c":3},"z":1}');
    });
  });
});
