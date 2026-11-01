import { expect, it } from "vitest";
import { createPiLearnedShadow } from "../adapters/pi/learned-shadow";
import { resolveUnitPrices } from "../src/pricing";
import type { ImmediateSummaryFeedback } from "../tools/pi-summary-feedback";

const binding = {
  profileBinding: "a".repeat(64),
  compactorBinding: "b".repeat(64),
  estimatorId: "pi-host/v1",
};
const assumptions = { beforeErrorTokens: 0, afterErrorTokens: 0, driftToleranceRatio: 0.05 };
const input = {
  contextTokens: 550000,
  growthTokens: 20000,
  prices: resolveUnitPrices({
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.006,
  }),
  billingModel: {
    after: { slope: 0.1, intercept: 20000, residual: 0 },
    output: { slope: 0.002, intercept: 100, residual: 0 },
    samples: 0,
    minBefore: 0,
    maxBefore: 700000,
    summaryInputCostPerToken: 0.3e-6,
  },
  softBoundary: 500000,
  fallbackBoundary: 600000,
  forceBoundary: 700000,
};

it("persists numeric immediate results and reproduces learning/decisions after complete journal reload", () => {
  const journal: ImmediateSummaryFeedback[] = [],
    evaluations: unknown[] = [];
  const make = () =>
    createPiLearnedShadow({
      binding,
      assumptions,
      loadHistory: () => journal,
      appendFeedback: (s) => {
        journal.push(s);
      },
      writeEvaluation: (r) => {
        evaluations.push(r);
      },
    });
  const m = make();
  expect(m.evaluate(input)).toMatchObject({
    applied: false,
    recommendation: { reason: "unidentified-retention", boundary: 600000 },
  });
  [100000, 350000, 700000].forEach((before, i) => {
    expect(
      m.observeImmediate(
        { tokensBefore: before, estimatedTokensAfter: 30000, summary: "private-body-sentinel" },
        { sequence: i + 1, stage: i + 1 },
      ).accepted,
    ).toBe(true);
  });
  const expected = m.evaluate(input);
  expect(expected).toMatchObject({
    applied: false,
    canDrivePolicy: false,
    support: { identifiable: true },
  });
  expect(make().evaluate(input)).toEqual(expected);
  expect(JSON.stringify([journal, evaluations])).not.toContain("private-body-sentinel");
  expect(
    m.observeImmediate(
      { tokensBefore: 700000, estimatedTokensAfter: 30000 },
      { sequence: 3, stage: 4 },
    ).accepted,
  ).toBe(false);
  expect(journal).toHaveLength(3);
});

it("does not learn a delayed/missing size or silently reset on incompatible journals", () => {
  const m = createPiLearnedShadow({
    binding,
    assumptions,
    loadHistory: () => [],
    appendFeedback: () => {},
    writeEvaluation: () => {},
  });
  expect(m.observeImmediate({ tokensBefore: 100000 }, { sequence: 1, stage: 1 }).reason).toBe(
    "missing-immediate-size",
  );
  expect(m.snapshot().accepted).toBe(0);
  const bad = createPiLearnedShadow({
    binding,
    assumptions,
    loadHistory: () => [{ source: "offline-projection" }],
    appendFeedback: () => {},
    writeEvaluation: () => {},
  });
  expect(bad.evaluate(input)).toMatchObject({
    status: "blocked",
    reason: "history-unavailable-or-incompatible",
  });
});

it("blocks shadow evaluation after feedback or evaluation storage fails and never leaks raw errors", () => {
  const m = createPiLearnedShadow({
    binding,
    assumptions,
    loadHistory: () => [],
    appendFeedback: () => {
      throw new Error("secret-storage-error");
    },
    writeEvaluation: () => {},
  });
  expect(
    m.observeImmediate(
      { tokensBefore: 100000, estimatedTokensAfter: 30000 },
      { sequence: 1, stage: 1 },
    ).accepted,
  ).toBe(false);
  expect(m.evaluate(input).status).toBe("blocked");
  expect(JSON.stringify(m.snapshot())).not.toContain("secret-storage-error");
  const n = createPiLearnedShadow({
    binding,
    assumptions,
    loadHistory: () => [],
    appendFeedback: () => {},
    writeEvaluation: () => {
      throw new Error("private-failure");
    },
  });
  expect(n.evaluate(input)).toMatchObject({ applied: false, status: "blocked" });
  expect(n.evaluate(input).status).toBe("blocked");
});
