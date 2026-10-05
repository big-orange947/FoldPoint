import { describe, expect, it } from "vitest";
import {
  attributionCases,
  forecastAttributionCase,
  sumForecastBills,
  sumObservedBills,
} from "../benchmarks/forecast-attribution";

describe("online-selected one-time diagnostic fork", () => {
  it("selects a complete declared main subset without sorting by outcomes", () => {
    const cases = attributionCases();
    expect(cases).toHaveLength(28);
    expect(new Set(cases.map((c) => c.profile)).size).toBe(7);
    expect(new Set(cases.map((c) => c.sourceFixture)).size).toBe(4);
    expect(
      cases.every((c) => c.steps === 360 && c.seed === 151 && c.contract === "summary-uncached"),
    ).toBe(true);
  });
  it("retains not-applicable cases and leaves the two complete bills identical", () => {
    const base = attributionCases()[0];
    if (!base) throw new Error("missing case");
    const r = forecastAttributionCase({ ...base.scenario, steps: 3 });
    expect(r.status).toBe("NOT_APPLICABLE");
    expect(r.checkpoint).toBeNull();
    expect(r.comparison).toBeNull();
    expect(r.wait).toEqual(r.now);
  });
  it("uses no task endpoint to select the first checkpoint and preserves the prefix", () => {
    const base = attributionCases()[0];
    if (!base) throw new Error("missing case");
    const s = { ...base.scenario, startTokens: 500000 };
    const a = forecastAttributionCase({ ...s, steps: 8 }, 0);
    const b = forecastAttributionCase({ ...s, steps: 12 }, 0);
    expect(a.status).toBe("FORKED");
    expect(b.checkpoint).toEqual(a.checkpoint);
    const step = a.checkpoint?.step;
    if (step === undefined) throw new Error("missing checkpoint");
    expect(a.wait.bills.slice(0, step)).toEqual(a.now.bills.slice(0, step));
    expect(a.wait.actions[step]).toBe("KEEP");
    expect(a.now.actions[step]).toBe("COMPACT");
    for (const arm of [a.wait, a.now]) {
      expect(arm.cost).toBeCloseTo(
        arm.totals.ordinaryInputCost +
          arm.totals.ordinaryOutputCost +
          arm.totals.summaryCost +
          arm.totals.prewarmCost,
        10,
      );
    }
    expect(a.comparison?.fullObservedFork.saving).toBeCloseTo(a.wait.cost - a.now.cost, 10);
  });
  it("keeps ordinary outputs separate from prediction and applies matching survival weights", () => {
    const bills = [
      {
        ordinaryInputCost: 2,
        ordinaryOutputCost: 3,
        summaryCost: 4,
        prewarmCost: 1,
        summaryCalls: 1,
        prewarmCalls: 1,
      },
      {
        ordinaryInputCost: 3,
        ordinaryOutputCost: 4,
        summaryCost: 0,
        prewarmCost: 0,
        summaryCalls: 0,
        prewarmCalls: 0,
      },
    ];
    expect(sumObservedBills(bills, [1, 0.5])).toEqual({
      ordinaryInputCost: 3.5,
      ordinaryOutputCost: 5,
      summaryCost: 4,
      prewarmCost: 1,
      summaryCalls: 1,
      prewarmCalls: 1,
    });
    expect(() => sumObservedBills(bills, [1])).toThrow();
    const forecast = {
      ordinaryInputCost: 3.5,
      summaryCost: 4,
      prewarmCost: 1,
      expectedOrdinaryCalls: 1.5,
      expectedSummaryCalls: 1,
      expectedPrewarmCalls: 1,
      steps: bills.map((b, i) => ({
        ...b,
        call: i,
        survival: i === 0 ? 1 : 0.5,
        compact: i === 0,
        beforeTokens: 100,
        afterTokens: 50,
      })),
    };
    expect(sumForecastBills(forecast, 2).ordinaryOutputCost).toBe(0);
    expect(sumForecastBills(forecast, 2).ordinaryInputCost).toBe(3.5);
    expect(() => sumForecastBills(forecast, 3)).toThrow();
  });
});
