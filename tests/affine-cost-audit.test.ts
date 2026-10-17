import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { affineCostCases, type buildAffineCostReport } from "../tools/affine-cost";
import {
  AuditInputOverflow,
  renderAffineCostAudit,
  type runAffineCostAudit,
  selectAuditRows,
  traceArm,
  traceSlice,
} from "../tools/affine-cost-audit";
import { sourceHash } from "../tools/affine-holdout";

const frozen = JSON.parse(
  readFileSync("benchmarks/reports/affine-cost.json", "utf8"),
) as ReturnType<typeof buildAffineCostReport>;
const report = () =>
  JSON.parse(readFileSync("benchmarks/reports/affine-cost-audit.json", "utf8")) as ReturnType<
    typeof runAffineCostAudit
  >;

it("selects the declared worst DeepSeek main and existing failure row without changing the frozen input", () => {
  expect(sourceHash(readFileSync("benchmarks/reports/affine-cost.json", "utf8"))).toBe(
    "5c41a55c7a031b49a99401b2fa2fc609b390752363bde3749d7760545c1f953c",
  );
  const selected = selectAuditRows(frozen.rows);
  expect(selected.map((r) => [r.suite, r.fixture, r.steps])).toEqual([
    ["main", "heldout-floor-180-22000-20000", 240],
    ["failure", "heldout-floor-180-22000-20000", 240],
  ]);
  expect(selectAuditRows([...frozen.rows].reverse())).toEqual(selected);
});

it("replays a short fixed schedule exactly and recomputes an intervention rather than subtracting a fee", () => {
  const c = affineCostCases()[0];
  if (!c) throw new Error("missing case");
  const s = { ...c.scenario, steps: 4, startTokens: 610000 };
  const original = traceArm(s, "fixed60");
  expect(traceArm(s, "fixed60", original.attempts).bill).toEqual(original.bill);
  const removed = traceArm(s, "fixed60", []);
  expect(removed.bill.summaryCalls).toBe(0);
  expect(removed.bill.ordinary).not.toBe(original.bill.ordinary);
  expect(original.bill.cost - removed.bill.cost).not.toBeCloseTo(original.bill.summary, 10);
  expect(() => traceArm({ ...s, steps: 100 }, "fixed60", [])).toThrow(AuditInputOverflow);
  const all = traceSlice(original, 0, 4);
  expect(all.cost).toBeCloseTo(original.bill.cost, 12);
  expect(all.ordinary).toBeCloseTo(all.read + all.tail + all.write + all.output, 12);
});

it("keeps successful settlement order distinct from chronological attempt order", () => {
  const r = report().rows.find((r) => r.suite === "failure");
  if (!r) throw new Error("missing failure audit");
  const events = r.traces.uncertainAffine.attempts;
  expect(r.intervention.approximateEma.withoutLastStatus).toBe("unavailable-window-overflow");
  expect(r.intervention.approximateEma.lastAttemptNetCost).toBeNull();
  expect(r.deltas.find((d) => d.against === "approximateEma")?.endingPenaltyDifference).toBeNull();
  expect(events.map((e) => e.step)).toEqual(events.map((e) => e.step).sort((a, b) => a - b));
  const saved = r.traces.uncertainAffine.bill.compactions;
  expect(saved.some((e, i) => i > 0 && (saved[i - 1]?.step ?? -1) > e.step)).toBe(true);
  expect(
    [...saved].sort((a, b) => a.step - b.step).map((e) => [e.step, e.success, e.cost]),
  ).toEqual(events.map((e) => [e.step, e.success, e.cost]));
});

it("reconciles prefix deltas, component bills, direct failed fees and distinct intervention effects", () => {
  for (const r of report().rows) {
    for (const arm of ["fixed60", "approximateEma", "uncertainAffine"] as const) {
      const trace = r.traces[arm];
      const intervention = r.intervention[arm];
      expect(intervention.replayMatches).toBe(true);
      expect(intervention.components.cost).toBeCloseTo(trace.bill.cost, 10);
      expect(intervention.components.failedSummaryCost).toBeCloseTo(
        trace.attempts.filter((e) => !e.success).reduce((s, e) => s + e.cost, 0),
        12,
      );
      expect(intervention.failurePathNetCost).toBeCloseTo(
        trace.bill.cost - intervention.allSuccessSameSchedule.cost,
        12,
      );
      if (intervention.withoutLast)
        expect(intervention.lastAttemptNetCost).toBeCloseTo(
          trace.bill.cost - intervention.withoutLast.cost,
          12,
        );
    }
    for (const d of r.deltas) {
      expect(d.parts.reduce((s, p) => s + (p.delta.cost ?? 0), 0)).toBeCloseTo(d.totalDelta, 10);
      for (const p of d.parts) {
        expect(p.delta.cost).toBeCloseTo((p.delta.ordinary ?? 0) + (p.delta.summary ?? 0), 10);
        expect(p.delta.ordinary).toBeCloseTo(
          (p.delta.read ?? 0) + (p.delta.tail ?? 0) + (p.delta.write ?? 0) + (p.delta.output ?? 0),
          10,
        );
      }
    }
  }
});

it("matches the generated markdown and audit producer source without granting a policy oracle", () => {
  const r = report();
  expect(renderAffineCostAudit(r)).toBe(readFileSync("benchmarks/affine-cost-audit.md", "utf8"));
  expect(sourceHash(readFileSync("tools/affine-cost-audit.ts", "utf8"))).toBe(r.auditSourceSha256);
  expect(r.paidCalls).toBe(0);
  expect(renderAffineCostAudit(r)).toContain("评测oracle");
  expect(renderAffineCostAudit(r)).toContain("不构成可相加");
});
