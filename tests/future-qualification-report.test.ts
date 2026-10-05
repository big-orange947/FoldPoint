import { describe, expect, it } from "vitest";
import { attributionCases } from "../benchmarks/forecast-attribution";
import { futureQualificationCase } from "../benchmarks/future-qualification";

describe("future-rule execution controls", () => {
  it("does not use the task endpoint for the first online decision", () => {
    const c = attributionCases()[0];
    if (!c) throw new Error("missing fixture");
    const s = { ...c.scenario, startTokens: 500000 };
    const a = futureQualificationCase({ ...s, steps: 4 });
    const b = futureQualificationCase({ ...s, steps: 8 });
    expect(a.audit.checkpoints[0]).toEqual(b.audit.checkpoints[0]);
    expect(a.historyCost).toBe(b.historyCost);
    expect(a.audit.futureRuleChecks).toBeLessThanOrEqual(4 * 4);
    expect(b.audit.futureRuleChecks).toBeLessThanOrEqual(4 * 8);
    for (const r of [a, b])
      for (const arm of [r.dynamic, r.fixed60]) {
        expect(arm.cost).toBeCloseTo(arm.ordinaryCost + arm.summaryCost + arm.prewarmCost, 10);
        expect(arm.totalRequests).toBe(arm.ordinaryCalls + arm.summaryCalls + arm.prewarmCalls);
        expect(arm.overflow).toBe(0);
      }
  });
});
