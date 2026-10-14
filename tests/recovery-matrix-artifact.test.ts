import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRecoveryMatrixReport,
  RECOVERY_MATRIX_MANIFEST,
  renderRecoveryMatrix,
} from "../tools/recovery-matrix";

const report = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/recovery-matrix.json", import.meta.url), "utf8"),
) as ReturnType<typeof buildRecoveryMatrixReport>;
const rows = [...report.main, ...report.short];
describe("full repaired-candidate execution artifact", () => {
  it("retains all cases and binds frozen source/input hashes", () => {
    expect(report.metadata.manifest).toEqual(RECOVERY_MATRIX_MANIFEST);
    expect(report.gate).toEqual({
      mainCompleted: 252,
      shortCompleted: 63,
      hardFailures: 0,
      previousSuccessfulMainUnchanged: 250,
      previousFailuresRepaired: 2,
      promotedToPi: false,
    });
    expect(report.main).toHaveLength(252);
    expect(report.short).toHaveLength(63);
    expect(report.externalCalls).toBe(0);
    expect(report.paidCalls).toBe(0);
    for (const h of Object.values(report.metadata.sourceHashes))
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    const targetedHashes = JSON.parse(
      readFileSync(new URL("../benchmarks/reports/model-recovery.json", import.meta.url), "utf8"),
    ) as { metadata: { sourceHashes: Record<string, string> } };
    expect(report.metadata.sourceHashes).toEqual(targetedHashes.metadata.sourceHashes);
    const { key, ...boundMetadata } = report.metadata;
    expect(key).toBe(createHash("sha256").update(JSON.stringify(boundMetadata)).digest("hex"));
    expect(report.metadata.baselineSha256).toBe(
      createHash("sha256")
        .update(
          readFileSync(new URL("../benchmarks/reports/future-replication.json", import.meta.url)),
        )
        .digest("hex"),
    );
    expect(report.summary.every((s) => s.cases === 36)).toBe(true);
    expect(report.prefixAudits).toHaveLength(168);
    expect(report.prefixAudits.every((p) => p.status === "PASS")).toBe(true);
    expect(report.shortSummary.previousCostsUnchanged).toBe(63);
  });
  it("keeps all bills, summary requests and model-recovery events auditable", () => {
    for (const r of rows) {
      for (const arm of [r.fixed60, r.candidate]) {
        expect(arm.cost).toBeCloseTo(arm.ordinaryCost + arm.summaryCost + arm.prewarmCost, 10);
        expect(arm.summaryCalls).toBe(arm.compactions.length);
        expect(arm.summaryCost).toBeCloseTo(
          arm.compactions.reduce((n, c) => n + c.summaryCost, 0),
          10,
        );
        expect(arm.totalRequests).toBe(r.steps + arm.summaryCalls + arm.prewarmCalls);
        expect(arm.overflow).toBe(0);
        expect(arm.fingerprint).toBe(r.fixed60.fingerprint);
      }
      expect(r.modelUsage.fitted + r.modelUsage.retained + r.modelUsage.unavailable).toBe(r.steps);
    }
    expect(report.main.filter((r) => r.modelUsage.retained > 0)).toHaveLength(2);
    expect(report.main.some((r) => r.vsFixed60 > 0)).toBe(true);
    for (const s of report.summary) {
      const group = report.main.filter((r) => r.profile === s.profile);
      expect(s.candidateFrequency.summaryCalls).toBe(
        group.reduce((n, r) => n + r.candidate.summaryCalls, 0),
      );
      expect(s.fixedFrequency.summaryCalls).toBe(
        group.reduce((n, r) => n + r.fixed60.summaryCalls, 0),
      );
    }
  });
  it("reproduces identical aggregates and Markdown without another simulation", () => {
    expect(buildRecoveryMatrixReport(rows, report.metadata)).toEqual(report);
    expect(readFileSync(new URL("../benchmarks/recovery-matrix.md", import.meta.url), "utf8")).toBe(
      renderRecoveryMatrix(report),
    );
  });
  it("rejects dropped, duplicated, nonfinite, altered references and dishonest recovery labels", () => {
    expect(() => buildRecoveryMatrixReport(rows.slice(1), report.metadata)).toThrow(/matrix/);
    const second = rows[1];
    if (!second) throw new Error("missing case");
    expect(() => buildRecoveryMatrixReport([...rows.slice(1), second], report.metadata)).toThrow(
      /matrix/,
    );
    const badMeta = { ...report.metadata, baselineSha256: "changed" };
    expect(() => buildRecoveryMatrixReport(rows, badMeta)).toThrow(/hash/);
    for (const kind of ["bill", "reference", "recovery", "nonfinite"] as const) {
      const copy = structuredClone(rows);
      const first = copy[0];
      if (!first) throw new Error("missing case");
      if (kind === "bill") first.candidate.summaryCost++;
      if (kind === "reference") first.historyCost++;
      if (kind === "recovery") first.previousFailureRepaired = !first.previousFailureRepaired;
      if (kind === "nonfinite") first.candidate.ordinaryCost = NaN;
      expect(() => buildRecoveryMatrixReport(copy, report.metadata)).toThrow();
    }
  });
});
