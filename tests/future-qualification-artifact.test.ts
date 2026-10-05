import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FUTURE_CHECK_BUDGET,
  type futureQualificationReport,
  renderFutureQualification,
  summarizeFutureQualification,
} from "../benchmarks/future-qualification";
import type { buildWarmLengthReport } from "../benchmarks/warm-length-seed";

const raw = readFileSync(
  new URL("../benchmarks/reports/warm-length-seed.json", import.meta.url),
  "utf8",
);
const frozen = JSON.parse(raw) as ReturnType<typeof buildWarmLengthReport>;
const report = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/future-qualification.json", import.meta.url), "utf8"),
) as ReturnType<typeof futureQualificationReport>;
describe("bounded future qualification full-bill artifact", () => {
  it("preserves every frozen control and all short-task outcomes", () => {
    expect(report.rows).toHaveLength(28);
    expect(report.short).toHaveLength(21);
    expect(report.maxChecksPerPath).toBe(FUTURE_CHECK_BUDGET);
    expect(report.frozenControlSha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(report.externalCalls).toBe(0);
    expect(report.paidCalls).toBe(0);
    for (const r of report.rows) {
      const old = frozen.rows.find(
        (x) =>
          x.profile === r.profile &&
          x.sourceFixture === r.sourceFixture &&
          x.seed === r.seed &&
          x.steps === r.steps &&
          x.suite === "main",
      );
      expect(r.fixed60).toEqual(old?.fixed60);
      expect(r.incumbent).toEqual(old?.paired);
      expect(r.candidate.fingerprint).toBe(r.incumbent.fingerprint);
      expect(r.vsIncumbent).toBe(r.candidate.cost / r.incumbent.cost - 1);
      expect(r.vsFixed60).toBe(r.candidate.cost / r.fixed60.cost - 1);
      expect(r.audit.futureRuleChecks).toBeLessThanOrEqual(r.steps * 2 * FUTURE_CHECK_BUDGET);
      expect(r.audit.futureRuleRejected).toBeLessThanOrEqual(r.audit.futureRuleChecks ?? 0);
      for (const t of r.audit.checkpoints) {
        const q = t.futureQualification;
        if (!q) throw new Error("missing check audit");
        for (const branch of [q.now, q.wait]) {
          expect(branch.checks.length).toBeLessThanOrEqual(FUTURE_CHECK_BUDGET);
          for (const c of branch.checks) {
            expect(c.completedCalls).toBe(t.step + c.call);
            if (c.allowed) {
              expect(c.expectedSaving).toBeGreaterThan(c.requiredSaving);
              expect(c.stressedSaving).toBeGreaterThan(c.requiredSaving);
            }
          }
        }
        if (q.nowSafetyFallback) expect(q.safetyNowCost).toBeLessThan(q.qualifiedNowCost);
        if (q.waitSafetyFallback) expect(q.safetyWaitCost).toBeLessThan(q.qualifiedWaitCost);
      }
    }
    expect(
      report.rows.some((r) => r.audit.futureRuleUnassessed && r.audit.futureRuleUnassessed > 0),
    ).toBe(true);
  });
  it("charges summaries, ordinary output/rebuilds and every independent prewarm request", () => {
    for (const r of report.rows)
      for (const arm of [r.fixed60, r.incumbent, r.candidate]) {
        expect(arm.cost).toBeCloseTo(arm.ordinaryCost + arm.summaryCost + arm.prewarmCost, 10);
        expect(arm.summaryCalls).toBe(arm.compactions.length);
        expect(arm.summaryCost).toBeCloseTo(
          arm.compactions.reduce((n, c) => n + c.summaryCost, 0),
          10,
        );
        expect(arm.totalRequests).toBe(arm.ordinaryCalls + arm.summaryCalls + arm.prewarmCalls);
        expect(arm.ordinaryCalls).toBe(360);
        expect(arm.overflow).toBe(0);
      }
    expect(
      report.shortSummary.better + report.shortSummary.worse + report.shortSummary.unchanged,
    ).toBe(21);
    for (const r of report.short) {
      expect(r.vsIncumbent).toBe(r.candidateCost / r.incumbentCost - 1);
      expect(r.vsFixed60).toBe(r.candidateCost / r.fixed60Cost - 1);
    }
  });
  it("regenerates published summaries and Markdown exactly", () => {
    expect(report.summary).toEqual(summarizeFutureQualification(report.rows));
    expect(
      readFileSync(new URL("../benchmarks/future-qualification.md", import.meta.url), "utf8"),
    ).toBe(renderFutureQualification(report));
  });
});
