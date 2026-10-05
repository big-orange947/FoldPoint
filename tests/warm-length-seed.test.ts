import { describe, expect, it } from "vitest";
import { buildGrowthSequence, fingerprintSequence } from "../benchmarks/scenarios";
import {
  auditWarmPrefixes,
  buildWarmLengthReport,
  evaluateWarmLengthCase,
  summarizeWarmLengths,
  WARM_LENGTH_MANIFEST,
  warmLengthCases,
  warmStreamStability,
} from "../benchmarks/warm-length-seed";

describe("frozen warm-task length/seed expansion", () => {
  it("rejects an incomplete matrix instead of rendering a smaller apparent success", () => {
    expect(() => buildWarmLengthReport([], {})).toThrow("matrix is incomplete");
  });
  it("covers the declared factorial without model-specific policy settings", () => {
    const cases = warmLengthCases();
    expect(cases.filter((c) => c.suite === "main")).toHaveLength(252);
    expect(cases.filter((c) => c.suite === "billing-sensitivity")).toHaveLength(42);
    expect(
      new Set(
        cases.map((c) => `${c.profile}/${c.contract}/${c.sourceFixture}/${c.seed}/${c.steps}`),
      ).size,
    ).toBe(294);
    expect(WARM_LENGTH_MANIFEST.algorithmBaselineCommit).toBe("69d2752");
    expect(WARM_LENGTH_MANIFEST.seeds).toEqual([151, 919, 2027]);
    expect(WARM_LENGTH_MANIFEST.lengths).toEqual([120, 240, 360]);
    for (const c of cases) {
      expect(c.scenario.contextWindowTokens).toBe(1000000);
      expect(c.scenario.hostHorizon).toBeUndefined();
      expect(c.scenario.compactor.successRate).toBe(1);
      expect(c.scenario.growthJitter).toBe(4500);
      expect(c.scenario.cachePolicy.ttlMs).toBeGreaterThan(c.scenario.idleMs);
    }
    for (const p of WARM_LENGTH_MANIFEST.profiles) {
      const group = cases.filter((c) => c.profile === p && c.suite === "main");
      expect(group).toHaveLength(36);
      for (const n of WARM_LENGTH_MANIFEST.lengths)
        expect(group.filter((c) => c.steps === n)).toHaveLength(12);
    }
  });
  it("uses identical offered growth prefixes across endpoints, independently of price", () => {
    const cases = warmLengthCases().filter((c) => c.suite === "main");
    const long = cases.find((c) => c.steps === 360);
    if (!long) throw new Error("missing fixture");
    const growth = buildGrowthSequence(long.scenario);
    for (const c of cases.filter(
      (c) => c.seed === long.seed && c.sourceFixture === long.sourceFixture,
    ))
      expect(buildGrowthSequence(c.scenario)).toEqual(growth.slice(0, c.steps));
  });
  it("reconciles interval cost only after growth, decisions and compactions match", () => {
    const base = warmLengthCases()[0];
    if (!base) throw new Error("missing fixture");
    const run = (steps: number) => {
      const c = { ...base, steps, scenario: { ...base.scenario, steps } };
      const r = evaluateWarmLengthCase(c);
      r.growthPrefixFingerprints = [8, 12]
        .filter((n) => n <= steps)
        .map((n) => ({
          steps: n,
          fingerprint: fingerprintSequence(buildGrowthSequence(c.scenario).slice(0, n)),
        }));
      return r;
    };
    const shorter = run(8),
      longer = run(12);
    const audits = auditWarmPrefixes([shorter, longer]);
    expect(audits).toHaveLength(3);
    for (const a of audits) {
      expect(a.sameCompactions && a.sameGrowth && a.sameCheckpoints).toBe(true);
      expect(a.incrementalCost).toBeCloseTo(
        a.incrementalOrdinaryCost + a.incrementalSummaryCost + a.incrementalPrewarmCost,
        12,
      );
      expect(a.incrementalCost).toBeCloseTo(longer[a.arm].cost - shorter[a.arm].cost, 12);
    }
    const badGrowth = structuredClone(longer);
    badGrowth.growthPrefixFingerprints[0] = { steps: 8, fingerprint: "different" };
    expect(() => auditWarmPrefixes([shorter, badGrowth])).toThrow("prefix instability");
    const badActions = structuredClone(longer);
    badActions.common.compactions.push({
      step: 0,
      action: "COMPACT",
      success: true,
      beforeTokens: 1,
      afterTokens: 0,
      summaryCost: 0,
    });
    expect(() => auditWarmPrefixes([shorter, badActions])).toThrow("prefix instability");
    const badDecisions = structuredClone(longer);
    const checkpoint = badDecisions.commonAudit.checkpoints[0];
    if (!checkpoint) throw new Error("missing checkpoint");
    checkpoint.expectedSaving += 1;
    expect(() => auditWarmPrefixes([shorter, badDecisions])).toThrow("prefix instability");
  });
  it("keeps equal-weight percentage and pooled bill ratio as distinct metrics", () => {
    const c = warmLengthCases()[0];
    if (!c) throw new Error("missing fixture");
    const r = evaluateWarmLengthCase({ ...c, steps: 1, scenario: { ...c.scenario, steps: 1 } });
    const a = structuredClone(r),
      b = structuredClone(r);
    a.fixed60.cost = 1;
    a.paired.cost = 2;
    b.fixed60.cost = 100;
    b.paired.cost = 90;
    const s = summarizeWarmLengths([a, b]).find((s) => s.arm === "paired" && s.steps === "all");
    expect(s?.meanChange).toBeCloseTo(0.45, 12);
    expect(s?.aggregateCostChange).toBeCloseTo(92 / 101 - 1, 12);
    expect(s?.wins).toBe(1);
    expect(s?.losses).toBe(1);
  });
  it("distinguishes endpoint-sensitive streams from all-length wins and losses", () => {
    const c = warmLengthCases()[0];
    if (!c) throw new Error("missing fixture");
    const template = evaluateWarmLengthCase({
      ...c,
      steps: 1,
      scenario: { ...c.scenario, steps: 1 },
    });
    const rows = [151, 919].flatMap((seed) =>
      [120, 240, 360].map((steps) => {
        const r = structuredClone(template);
        r.seed = seed;
        r.steps = steps;
        r.fixed60.cost = 10;
        r.paired.cost = seed === 151 ? (steps === 240 ? 9 : 11) : 12;
        r.common.cost = seed === 151 ? 8 : 10;
        return r;
      }),
    );
    const s = warmStreamStability(rows);
    expect(s.streams).toHaveLength(4);
    expect(s.summary.find((s) => s.arm === "paired")).toMatchObject({
      streams: 2,
      allWin: 0,
      allLose: 1,
      signFlip: 1,
    });
    expect(s.summary.find((s) => s.arm === "common")).toMatchObject({
      streams: 2,
      allWin: 1,
      allLose: 0,
      signFlip: 0,
    });
  });
});
