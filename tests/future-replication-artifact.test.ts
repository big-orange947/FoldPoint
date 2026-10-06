import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { futureQualificationReport } from "../benchmarks/future-qualification";
import {
  buildReplicationReport,
  REPLICATION_MANIFEST,
  renderReplication,
} from "../benchmarks/future-replication";
import type { buildWarmLengthReport } from "../benchmarks/warm-length-seed";

const raw = readFileSync(
  new URL("../benchmarks/reports/warm-length-seed.json", import.meta.url),
  "utf8",
);
const initialRaw = readFileSync(
  new URL("../benchmarks/reports/future-qualification.json", import.meta.url),
  "utf8",
);
const frozen = JSON.parse(raw) as ReturnType<typeof buildWarmLengthReport>;
const initial = JSON.parse(initialRaw) as ReturnType<typeof futureQualificationReport>;
const report = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/future-replication.json", import.meta.url), "utf8"),
) as ReturnType<typeof buildReplicationReport>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
describe("frozen future-rule multi-seed replication artifact", () => {
  it("retains the entire matrix, exactly accounts reuse and binds source/control hashes", () => {
    expect(report.metadata.manifest).toEqual(REPLICATION_MANIFEST);
    expect(report.rows.length + report.failures.length).toBe(252);
    expect(report.short).toHaveLength(63);
    expect(report.rows.filter((r) => r.reusedInitial)).toHaveLength(28);
    expect(report.short.filter((r) => r.reusedInitial)).toHaveLength(21);
    expect(report.externalCalls).toBe(0);
    expect(report.paidCalls).toBe(0);
    expect(report.metadata.frozenControlSha256).toBe(sha(raw));
    expect(report.metadata.initialReportSha256).toBe(sha(initialRaw));
    for (const h of Object.values(report.metadata.sourceHashes))
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(report.metadata.sourceHashes).length).toBeGreaterThan(30);
    for (const s of report.additionalSeeds)
      expect(
        s.cases + report.failures.filter((f) => f.profile === s.profile && f.seed !== 151).length,
      ).toBe(24);
    expect(report.executionOrigins).toHaveLength(7);
    for (const o of report.executionOrigins) expect(o.harnessSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.gate.allCasesCompleted).toBe(report.failures.length === 0);
    expect(report.gate.hardFailures).toBe(report.failures.length);
    for (const c of report.coverage) expect(c.completed + c.hardFailures).toBe(c.attempted);
    for (const r of report.rows) {
      const old = frozen.rows.find(
        (o) =>
          o.suite === "main" &&
          o.profile === r.profile &&
          o.sourceFixture === r.sourceFixture &&
          o.seed === r.seed &&
          o.steps === r.steps,
      );
      expect(old).toBeDefined();
      expect(r.fixed60).toEqual(old?.fixed60);
      expect(r.incumbent).toEqual(old?.paired);
      expect(r.audit.futureRuleChecks).toBeLessThanOrEqual(r.steps * 4);
      expect(r.audit.futureRuleRejected).toBeLessThanOrEqual(r.audit.futureRuleChecks ?? 0);
      expect(r.audit.checkpoints.map((t) => t.step)).toEqual([0, 20, 60, 100]);
      for (const t of r.audit.checkpoints) {
        const q = t.futureQualification;
        if (!q) throw new Error("missing qualification metadata");
        for (const branch of [q.now, q.wait]) {
          expect(branch.checks.length).toBeLessThanOrEqual(2);
          for (const c of branch.checks) expect(c.completedCalls).toBe(t.step + c.call);
        }
      }
      if (r.reusedInitial) {
        const previous = initial.rows.find(
          (p) =>
            p.profile === r.profile &&
            p.sourceFixture === r.sourceFixture &&
            p.seed === r.seed &&
            p.steps === r.steps,
        );
        expect(r.candidate).toEqual(previous?.candidate);
        expect(r.vsIncumbent).toBe(previous?.vsIncumbent);
      }
    }
  });
  it("charges full bills and retains all regressions and correlated prefix checks", () => {
    expect(report.prefixAudits).toHaveLength(168);
    for (const a of report.prefixAudits) {
      expect(a.growthAndActionsMatch).toBe(a.status === "PASS");
      if (a.status === "NOT_AVAILABLE") {
        expect(a.incrementalChange).toBeNull();
        expect(
          report.failures.some(
            (f) =>
              `${f.profile}/${f.sourceFixture}/${f.seed}` === a.group &&
              (f.steps === a.from || f.steps === a.to),
          ),
        ).toBe(true);
      }
    }
    expect(report.rows.some((r) => r.vsFixed60 > 0)).toBe(true);
    expect(report.rows.some((r) => r.vsIncumbent > 0)).toBe(true);
    for (const r of report.rows)
      for (const arm of [r.fixed60, r.incumbent, r.candidate]) {
        expect(arm.cost).toBeCloseTo(arm.ordinaryCost + arm.summaryCost + arm.prewarmCost, 10);
        expect(arm.summaryCalls).toBe(arm.compactions.length);
        expect(arm.summaryCost).toBeCloseTo(
          arm.compactions.reduce((n, c) => n + c.summaryCost, 0),
          10,
        );
        expect(arm.totalRequests).toBe(r.steps + arm.summaryCalls + arm.prewarmCalls);
        expect(arm.fingerprint).toBe(r.fixed60.fingerprint);
        expect(arm.overflow).toBe(0);
      }
    expect(
      report.shortSummary.better + report.shortSummary.worse + report.shortSummary.unchanged,
    ).toBe(63);
    for (const r of report.short) {
      expect(r.vsFixed60).toBe(r.candidateCost / r.fixed60Cost - 1);
      expect(r.vsIncumbent).toBe(r.candidateCost / r.incumbentCost - 1);
    }
  });
  it("reprojects identical summaries, prefix/stability data and Markdown without simulation", () => {
    const rebuilt = buildReplicationReport(
      report.rows,
      report.short,
      report.metadata,
      report.failures,
      report.executionOrigins,
    );
    expect(rebuilt).toEqual(report);
    expect(
      readFileSync(new URL("../benchmarks/future-replication.md", import.meta.url), "utf8"),
    ).toBe(renderReplication(report));
  });
  it("rejects dropped/duplicated cases and corrupted control bills", () => {
    expect(() =>
      buildReplicationReport(report.rows.slice(1), report.short, report.metadata, report.failures),
    ).toThrow(/matrix/);
    const second = report.rows[1];
    if (!second) throw new Error("missing second row");
    const duplicate = [...report.rows.slice(1), second];
    expect(() =>
      buildReplicationReport(duplicate, report.short, report.metadata, report.failures),
    ).toThrow(/matrix/);
    const changed = structuredClone(report.rows);
    const first = changed[0];
    if (!first) throw new Error("missing first row");
    first.fixed60.cost++;
    expect(() =>
      buildReplicationReport(changed, report.short, report.metadata, report.failures),
    ).toThrow(/control/);
    expect(() =>
      buildReplicationReport(report.rows, report.short.slice(1), report.metadata, report.failures),
    ).toThrow(/short matrix/);
  });
});
