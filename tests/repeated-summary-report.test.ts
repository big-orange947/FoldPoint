import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeRepeatedSummary, renderRepeatedSummary } from "../tools/repeated-summary-report";

const result = JSON.parse(
  readFileSync(
    new URL("../benchmarks/reports/repeated-summary-result.json", import.meta.url),
    "utf8",
  ),
) as ReturnType<typeof analyzeRepeatedSummary>;
function parserFixture() {
  // Reconstructed from genuine public results ONLY for parser tests, never a live-run artifact.
  return {
    kind: "foldpoint.pi-repeated-summary-quality.v1",
    mode: "live",
    profile: "repeated",
    plan: result.plan,
    executionModel: result.executionModel,
    ...result.provenance,
    runArms: ["fullHistory", "fixed60", "experimental"],
    plannedCalls: 23,
    completedPlannedRun: true,
    hardFailure: null,
    checkpoints: structuredClone(result.probes),
    usageLedger: result.usageLedger.map((u) => ({
      arm: u.arm,
      kind: u.kind,
      usageKnown: true,
      stopReason: "stop",
      usage: {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        cost: { total: u.catalogCost },
      },
    })),
    usage: {
      logicalCalls: 23,
      httpCalls: result.paidHttpCalls,
      reportedTokens: result.reportedTokens,
      unaccountedHttpAttempts: result.unaccountedHttpAttempts,
    },
  };
}
describe("real repeated-summary results and conservative analysis", () => {
  it("retains measured results without promoting retention into task-quality proof", () => {
    expect(result.paidHttpCalls).toBe(23);
    expect(result.reportedTokens).toBe(218155);
    expect(result.usageLedger).toHaveLength(23);
    expect(
      result.usageLedger.reduce((n, u) => n + u.input + u.output + u.cacheRead + u.cacheWrite, 0),
    ).toBe(result.reportedTokens);
    expect(result.arms.map((a) => a.summaryCalls)).toEqual([0, 3, 11]);
    expect(result.arms.every((a) => a.correctFields === 36 && a.exactProbes === 3)).toBe(true);
    expect(result.arms.find((a) => a.arm === "experimental")?.summaryOutputTokens).toEqual([
      427, 1253, 1572, 2006, 2501, 3003, 3404, 3731, 4256, 4761, 5183,
    ]);
    expect(result.interpretation.comparisonReady).toBe(true);
    expect(result.interpretation.measuredAgentTaskCompletion).toBe(false);
    expect(result.interpretation.measuredLiveTiming).toBe(false);
    expect(result.interpretation.measuredOneMillionContext).toBe(false);
    expect(result.interpretation.statisticalNonInferiorityEstablished).toBe(false);
    expect(result.fieldRegressions).toEqual([]);
    expect(result.catalogEstimatedCost).toBeCloseTo(0.087993168, 12);
  });
  it("reproduces grade analysis and Markdown without calling a model", () => {
    const rebuilt = analyzeRepeatedSummary(JSON.stringify(parserFixture()));
    expect(rebuilt.interpretation).toEqual(result.interpretation);
    expect(rebuilt.arms).toEqual(result.arms);
    expect(rebuilt.catalogEstimatedCost).toBe(result.catalogEstimatedCost);
    expect(
      readFileSync(new URL("../benchmarks/repeated-summary.md", import.meta.url), "utf8"),
    ).toBe(renderRepeatedSummary(result));
  });
  it("exposes paired field regressions instead of averaging them away", () => {
    const source = parserFixture();
    const probe = source.checkpoints.find((c) => c.arm === "experimental" && c.step === 59);
    if (!probe?.grade) throw new Error("missing probe");
    probe.grade.fields.backup = false;
    probe.grade.correct--;
    probe.grade.exact = false;
    const changed = analyzeRepeatedSummary(JSON.stringify(source));
    expect(changed.fieldRegressions).toEqual([{ step: 59, field: "backup" }]);
    expect(changed.interpretation.allProbesCorrect).toBe(false);
    expect(changed.interpretation.comparisonReady).toBe(true);
  });
  it("marks a failed full-history reference unsuitable for a quality comparison", () => {
    const source = parserFixture();
    const probe = source.checkpoints.find((c) => c.arm === "fullHistory");
    if (!probe?.grade) throw new Error("missing probe");
    probe.grade.fields.owner = false;
    probe.grade.correct--;
    probe.grade.exact = false;
    expect(analyzeRepeatedSummary(JSON.stringify(source)).interpretation.comparisonReady).toBe(
      false,
    );
  });
  it("rejects unmeasured, incomplete, duplicated, altered-plan and unaccounted results", () => {
    for (const kind of [
      "dry",
      "incomplete",
      "duplicate",
      "plan",
      "tokens",
      "unknown",
      "budget",
      "grade",
    ] as const) {
      const source = structuredClone(parserFixture());
      if (kind === "dry") source.mode = "dry-run-fake";
      if (kind === "incomplete") source.completedPlannedRun = false;
      if (kind === "duplicate") {
        const first = source.checkpoints[0];
        if (!first) throw new Error("missing probe");
        source.checkpoints[1] = first;
      }
      if (kind === "plan") source.plan.stages++;
      if (kind === "tokens") source.usage.reportedTokens++;
      if (kind === "unknown") {
        const first = source.usageLedger[0];
        if (!first) throw new Error("missing usage");
        first.usageKnown = false;
      }
      if (kind === "budget") source.usage.httpCalls = 25;
      if (kind === "grade") {
        const first = source.checkpoints[0];
        if (!first?.grade) throw new Error("missing grade");
        first.grade.correct = 0;
      }
      expect(() => analyzeRepeatedSummary(JSON.stringify(source))).toThrow();
    }
  });
});
