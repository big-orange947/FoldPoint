import { describe, expect, it } from "vitest";
import { runtimeRobustnessReport } from "../benchmarks/runtime-robustness";
import { decideWith, HISTORY, profileWithCacheTtl } from "./helpers";

describe("economic sensitivity guard", () => {
  it("rejects a nominal gain which disappears under forecast stress", () => {
    const input = {
      contextTokens: 150_000,
      cachedTokens: 140_000,
      idleMs: 600_000,
      profile: profileWithCacheTtl(300_000),
      expectedFutureCalls: 10,
    };
    const nominal = decideWith(
      input,
      HISTORY,
      {},
      {
        defaults: {
          hardWindowRatio: 0.9,
          economicSavingMargin: 0,
          economicHorizonDiscount: 0,
          economicRetentionStress: 0,
        },
      },
    );
    const robust = decideWith(
      input,
      HISTORY,
      {},
      { defaults: { hardWindowRatio: 0.9, economicSavingMargin: 0 } },
    );
    expect(nominal.action).toBe("COMPACT");
    expect(robust.action).toBe("KEEP");
    expect(robust.reasons).toContain("ECONOMIC_ESTIMATE_FRAGILE");
    expect(robust.metrics.stressedAdjustedNetSaving).toBeLessThanOrEqual(
      robust.metrics.requiredEconomicSaving,
    );
  });

  it("never weakens window safety or invents a horizon", () => {
    expect(decideWith({ contextTokens: 140_000 }).action).toBe("FORCE");
    expect(decideWith({ contextTokens: 80_000 }).metrics.expectedFutureCalls).toBe(1);
  });

  it("uses a price-scaled margin and exposes it for auditing", () => {
    const decision = decideWith(
      {
        contextTokens: 80_000,
        cachedTokens: 0,
        profile: profileWithCacheTtl(300_000),
        idleMs: 600_000,
        expectedFutureCalls: 30,
      },
      HISTORY,
    );
    expect(decision.metrics.requiredEconomicSaving).toBeCloseTo(
      decision.metrics.estimatedCompactCallCost * 0.1,
    );
    expect(decision.action).toBe("COMPACT");
  });

  it("keeps paired short/medium tasks on identical growth without hiding cost regressions", () => {
    const report = runtimeRobustnessReport();
    expect(report.rows).toHaveLength(36);
    for (const row of report.rows) {
      expect(row.nominal.growthSequenceFingerprint).toBe(row.robust.growthSequenceFingerprint);
      expect(row.nominal.totalOfferedGrowthTokens).toBe(row.robust.totalOfferedGrowthTokens);
      expect(row.robust.overflowCount).toBe(0);
      expect(row.robust.totalSimulatedCost).toBeGreaterThan(0);
    }
  });

  it("validates stress parameters rather than silently repairing them", () => {
    for (const defaults of [
      { economicHorizonDiscount: 1.1 },
      { economicRetentionStress: -0.1 },
      { economicSavingMargin: Number.NaN },
    ]) {
      expect(() => decideWith({}, {}, {}, { defaults })).toThrow(RangeError);
    }
  });

  it("a stricter margin cannot promote a KEEP decision into COMPACT", () => {
    const input = { contextTokens: 80_000, cachedTokens: 0, expectedFutureCalls: 30 };
    const decisions = [0, 0.1, 0.5, 1].map((economicSavingMargin) =>
      decideWith(input, HISTORY, {}, { defaults: { economicSavingMargin } }),
    );
    for (let n = 1; n < decisions.length; n++) {
      expect(decisions[n]?.metrics.requiredEconomicSaving).toBeGreaterThanOrEqual(
        decisions[n - 1]?.metrics.requiredEconomicSaving ?? 0,
      );
      if (decisions[n - 1]?.action === "KEEP") expect(decisions[n]?.action).toBe("KEEP");
    }
  });

  it("does not change decisions merely because all prices are expressed at twice the scale", () => {
    const profile = profileWithCacheTtl(300_000);
    const input = {
      profile,
      contextTokens: 80_000,
      cachedTokens: 0,
      idleMs: 600_000,
      expectedFutureCalls: 30,
    };
    const a = decideWith(input, HISTORY);
    const pricing = profile.pricing;
    if (!pricing) throw new Error("priced fixture required");
    const b = decideWith(
      {
        ...input,
        profile: {
          ...profile,
          pricing: {
            ...pricing,
            inputPerMillion: pricing.inputPerMillion * 2,
            outputPerMillion: pricing.outputPerMillion * 2,
            cacheReadPerMillion: (pricing.cacheReadPerMillion ?? pricing.inputPerMillion) * 2,
            cacheWritePerMillion: (pricing.cacheWritePerMillion ?? pricing.inputPerMillion) * 2,
          },
        },
      },
      HISTORY,
    );
    expect(b.action).toBe(a.action);
    expect(b.metrics.requiredEconomicSaving).toBeCloseTo(a.metrics.requiredEconomicSaving * 2);
    expect(b.metrics.stressedAdjustedNetSaving).toBeCloseTo(
      a.metrics.stressedAdjustedNetSaving * 2,
    );
  });
});
