import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { cycleExecutionCase } from "../benchmarks/cycle-execution";
import type { buildReplicationReport } from "../benchmarks/future-replication";

const raw = readFileSync(
  new URL("../benchmarks/reports/future-replication.json", import.meta.url),
  "utf8",
);
const baseline = JSON.parse(raw) as ReturnType<typeof buildReplicationReport>;
const diagnosis = JSON.parse(
  readFileSync(
    new URL("../benchmarks/reports/future-model-diagnosis.json", import.meta.url),
    "utf8",
  ),
) as {
  rows: ({ profile: string; sourceFixture: string; seed: number; steps: number } & {
    evidence: { step: number };
  })[];
};
type Bill = ReturnType<typeof cycleExecutionCase>["dynamic"];
type Identity = { profile: string; sourceFixture: string; seed: number; steps: number };
const id = (r: Identity) => `${r.profile}/${r.sourceFixture}/${r.seed}/${r.steps}`;
const report = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/model-recovery.json", import.meta.url), "utf8"),
) as {
  metadata: {
    baselineCommit: string;
    baselineSha256: string;
    selectedIds: string[];
    harnessSha256: string;
    sourceHashes: Record<string, string>;
  };
  externalCalls: number;
  paidCalls: number;
  gate: { completed: boolean; repaired: number; controlsUnchanged: number; promotedToPi: boolean };
  rows: (Identity & {
    purpose: string;
    historyCost: number;
    preservedSuccessfulBill: boolean | null;
    fixed60: Bill;
    candidate: Bill;
    vsFixed60: number;
    legacyPrefix?: {
      completed: false;
      failureStep: number;
      compactions: Bill["compactions"];
      ordinaryCalls: number;
      observedPrefixCost: number;
    };
    modelUsage: {
      fitted: number;
      retained: number;
      unavailable: number;
      maxObservationsSinceFit: number;
      nonFitted: { step: number; source: string; observationsSinceFit: number }[];
    };
  })[];
};
describe("bounded model recovery reliability artifact", () => {
  it("replays both failures and predeclared best/worst controls, not a fresh 252-case claim", () => {
    expect(report.metadata.baselineCommit).toBe("5e51d14");
    expect(report.metadata.baselineSha256).toBe(createHash("sha256").update(raw).digest("hex"));
    const controls = baseline.metadata.manifest.profiles.flatMap((profile) => {
      const rows = baseline.rows
        .filter((r) => r.profile === profile)
        .sort((a, b) => a.vsFixed60 - b.vsFixed60 || id(a).localeCompare(id(b)));
      const first = rows[0],
        last = rows.at(-1);
      if (!first || !last) throw new Error("missing controls");
      return [id(first), id(last)];
    });
    expect(report.metadata.selectedIds).toEqual([...baseline.failures.map(id), ...controls]);
    expect(report.rows.map(id)).toEqual(report.metadata.selectedIds);
    expect(report.gate).toEqual({
      completed: true,
      repaired: 2,
      controlsUnchanged: 14,
      promotedToPi: false,
    });
    expect(report.externalCalls).toBe(0);
    expect(report.paidCalls).toBe(0);
    expect(report.metadata.harnessSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("preserves all replayed successful bills and completes failed runs without changing the strict prefix", () => {
    for (const r of report.rows) {
      if (r.purpose === "frozen-best-worst-control") {
        const old = baseline.rows.find((o) => id(o) === id(r));
        expect(old).toBeDefined();
        expect(r.candidate).toEqual(old?.candidate);
        expect(r.fixed60).toEqual(old?.fixed60);
        expect(r.historyCost).toBe(old?.historyCost);
        expect(r.modelUsage.retained + r.modelUsage.unavailable).toBe(0);
        expect(r.preservedSuccessfulBill).toBe(true);
      } else {
        expect(baseline.failures.some((f) => id(f) === id(r))).toBe(true);
        const prefix = r.legacyPrefix;
        if (!prefix) throw new Error("missing strict prefix");
        expect(prefix.completed).toBe(false);
        expect(prefix.failureStep).toBe(diagnosis.rows.find((d) => id(d) === id(r))?.evidence.step);
        expect(prefix.ordinaryCalls).toBe(prefix.failureStep);
        expect(r.candidate.compactions.filter((c) => c.step < prefix.failureStep)).toEqual(
          prefix.compactions,
        );
        expect(r.modelUsage.nonFitted[0]?.step).toBe(prefix.failureStep);
        expect(r.modelUsage.retained).toBeGreaterThan(0);
        expect(r.preservedSuccessfulBill).toBeNull();
      }
    }
  });
  it("reconciles complete fees, request counts and actual recovery metadata", () => {
    for (const r of report.rows) {
      expect(r.vsFixed60).toBe(r.candidate.cost / r.fixed60.cost - 1);
      expect(r.modelUsage.fitted + r.modelUsage.retained + r.modelUsage.unavailable).toBe(r.steps);
      expect(r.modelUsage.nonFitted).toHaveLength(r.modelUsage.retained + r.modelUsage.unavailable);
      for (const bill of [r.fixed60, r.candidate]) {
        expect(bill.ordinaryCalls).toBe(r.steps);
        expect(bill.totalRequests).toBe(r.steps + bill.summaryCalls + bill.prewarmCalls);
        expect(bill.cost).toBeCloseTo(bill.ordinaryCost + bill.summaryCost + bill.prewarmCost, 10);
        expect(bill.summaryCost).toBeCloseTo(
          bill.compactions.reduce((n, c) => n + c.summaryCost, 0),
          10,
        );
        expect(bill.summaryCalls).toBe(bill.compactions.length);
        expect(bill.overflow).toBe(0);
        expect(bill.fingerprint).toBe(r.fixed60.fingerprint);
      }
    }
  });
});
