import { describe, expect, it } from "vitest";
import { FoldPoint } from "../src/index";
import { decideWith, HISTORY, makeProfile } from "./helpers";

describe("runtime-scoped economics", () => {
  it("old session and horizon learning cannot invent more work or more confidence", () => {
    const fresh = decideWith({}, {}, {});
    const old = decideWith(
      {},
      { horizonSamples: 999, reuseHorizonEma: 999 },
      { requestCount: 999 },
    );
    expect(old.metrics.expectedFutureCalls).toBe(1);
    expect(old.confidence).toBe(fresh.confidence);
    expect(old.action).toBe(fresh.action);
  });

  it("allows economic compaction below 50% only with positive runtime economics", () => {
    const input = { contextTokens: 80_000, cachedTokens: 0, expectedFutureCalls: 10 };
    const decision = decideWith(input, HISTORY);
    expect(decision.metrics.utilization).toBeLessThan(0.5);
    expect(decision.action).toBe("COMPACT");
    expect(decideWith({ ...input, expectedFutureCalls: 1 }, HISTORY).action).toBe("KEEP");
  });

  it("idle never borrows future commands, while the hard boundary remains independent", () => {
    expect(
      decideWith(
        { runtimeStatus: "idle", contextTokens: 80_000, expectedFutureCalls: 100 },
        HISTORY,
      ).reasons,
    ).toEqual(["RUNTIME_IDLE"]);
    expect(decideWith({ runtimeStatus: "idle", contextTokens: 140_000 }, HISTORY).action).toBe(
      "FORCE",
    );
  });

  it("stops the cost forecast before NOW would need another compaction", () => {
    const decision = decideWith({ contextTokens: 80_000, expectedFutureCalls: 100 }, HISTORY, {
      growthSamples: 10,
      growthTokensEma: 10_000,
      growthDeviationEma: 0,
    });
    expect(decision.metrics.effectiveHorizonCalls).toBeLessThan(100);
    expect(decision.metrics.effectiveHorizonCalls).toBe(
      Math.ceil(
        (decision.metrics.guardedForceBoundaryTokens -
          decision.metrics.estimatedPostCompactTokens) /
          10_000,
      ),
    );
  });

  it("counts zero-growth calls instead of learning only positive jumps", () => {
    const engine = new FoldPoint();
    const profile = makeProfile();
    for (let n = 0; n < 5; n++)
      engine.observeRequest("growth", profile, {
        timestamp: n + 1,
        promptTokens: n === 0 ? 10_000 : 20_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
    const state = engine.getSessionState("growth", profile);
    expect(state.growthSamples).toBe(4);
    expect(state.growthTokensEma).toBeLessThan(10_000);
  });
});
