import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { buildReplicationReport } from "../benchmarks/future-replication";
import {
  buildRecoveryMatrixReport,
  executeRecoveryMatrixCase,
  RECOVERY_MATRIX_MANIFEST,
  recoveryMatrixCases,
  recoveryMatrixPrefixAudits,
  summarizeRecoveryMatrix,
} from "../tools/recovery-matrix";

type Row = ReturnType<typeof executeRecoveryMatrixCase>;
const baseline = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/future-replication.json", import.meta.url), "utf8"),
) as ReturnType<typeof buildReplicationReport>;
function prefixFixtures(): Row[] {
  // Genuine old successful records used ONLY to test reducers and guards, not new executions.
  return baseline.rows
    .filter(
      (r) =>
        r.profile === RECOVERY_MATRIX_MANIFEST.profiles[0] &&
        r.sourceFixture === RECOVERY_MATRIX_MANIFEST.fixtures[0] &&
        r.seed === 151,
    )
    .map((r) => ({
      ...r,
      suite: "main",
      growthPrefixes: RECOVERY_MATRIX_MANIFEST.lengths
        .filter((n) => n <= r.steps)
        .map((steps) => {
          const p = r.growthPrefixes.find((p) => p.steps === steps);
          if (!p) throw new Error("missing growth prefix");
          return { steps, fingerprint: p.fingerprint };
        }),
      contextWindowTokens: 1000000,
      previousCost: r.candidate.cost,
      previousFailureRepaired: false,
      modelUsage: {
        fitted: r.steps,
        retained: 0,
        unavailable: 0,
        maxObservationsSinceFit: 0,
        nonFitted: [],
      },
      checkpoints: r.audit.checkpoints.map((p) => ({
        step: p.step,
        context: p.context,
        action: p.action,
        source: "fitted",
        expectedSaving: p.expectedSaving,
        stressedSaving: p.stressedSaving,
        repeatBoundary: p.repeatBoundary,
      })),
    }));
}
describe("frozen repaired-candidate full matrix", () => {
  it("enumerates every main and short cell without selecting favourable prices", () => {
    const cases = recoveryMatrixCases();
    expect(cases).toHaveLength(315);
    expect(cases.filter((c) => c.suite === "main")).toHaveLength(252);
    expect(cases.filter((c) => c.suite === "short")).toHaveLength(63);
    expect(
      new Set(cases.map((c) => `${c.suite}/${c.profile}/${c.sourceFixture}/${c.seed}/${c.steps}`))
        .size,
    ).toBe(315);
    expect(cases.every((c) => c.scenario.hostHorizon === undefined)).toBe(true);
    for (const profile of RECOVERY_MATRIX_MANIFEST.profiles) {
      expect(cases.filter((c) => c.profile === profile && c.suite === "main")).toHaveLength(36);
      expect(cases.filter((c) => c.profile === profile && c.suite === "short")).toHaveLength(9);
    }
  });
  it("requires matching growth, compaction and checkpoint prefixes", () => {
    const rows = prefixFixtures();
    const result = recoveryMatrixPrefixAudits(rows);
    expect(result).toHaveLength(2);
    expect(result[0]?.candidateIncrement).toBe(
      (rows[1]?.candidate.cost ?? 0) - (rows[0]?.candidate.cost ?? 0),
    );
    for (const kind of ["growth", "action", "checkpoint"] as const) {
      const copy = structuredClone(rows);
      const long = copy.find((r) => r.steps === 240);
      if (!long) throw new Error("missing fixture");
      if (kind === "growth") {
        const p = long.growthPrefixes[0];
        if (!p) throw new Error("missing prefix");
        p.fingerprint = "changed";
      }
      if (kind === "action") {
        const p = long.candidate.compactions[0];
        if (!p) throw new Error("missing action");
        p.afterTokens++;
      }
      if (kind === "checkpoint") {
        const p = long.checkpoints[0];
        if (!p) throw new Error("missing checkpoint");
        p.context++;
      }
      expect(() => recoveryMatrixPrefixAudits(copy)).toThrow(/prefix changed/);
    }
    expect(() => recoveryMatrixPrefixAudits(rows.filter((r) => r.steps !== 240))).toThrow(
      /missing prefix endpoint/,
    );
  });
  it("computes frequency over real within-session intervals, not across session boundaries", () => {
    const first = prefixFixtures()[0];
    if (!first) throw new Error("missing fixture");
    const source = first.candidate.compactions[0];
    if (!source) throw new Error("missing action");
    // Tiny TOY reduction fixture; deliberately not a valid execution bill.
    const toy = structuredClone(first);
    toy.candidate.compactions = [1, 5, 11].map((step, i) => ({
      ...source,
      step,
      beforeTokens: (i + 1) * 100000,
    }));
    toy.fixed60.compactions = [1, 13].map((step) => ({ ...source, step, beforeTokens: 600000 }));
    const s = summarizeRecoveryMatrix([toy, structuredClone(toy)])[0];
    expect(s?.candidateFrequency.summaryCalls).toBe(6);
    expect(s?.candidateFrequency.medianSpacing).toBe(5);
    expect(s?.candidateFrequency.minSpacing).toBe(4);
    expect(s?.candidateFrequency.medianUtilization).toBe(0.2);
    expect(s?.fixedFrequency.medianSpacing).toBe(12);
  });
  it("rejects incomplete aggregation and actually executes a tiny short control", () => {
    const meta: Parameters<typeof buildRecoveryMatrixReport>[1] = {
      manifest: RECOVERY_MATRIX_MANIFEST,
      sourceHashes: {},
      baselineSha256: "fixture",
      warmSha256: "fixture",
      targetedSha256: "fixture",
      harnessSha256: "fixture",
      nodeVersion: "fixture",
      key: "fixture",
    };
    expect(() => buildRecoveryMatrixReport(prefixFixtures(), meta)).toThrow(/matrix/);
    const c = recoveryMatrixCases().find((c) => c.suite === "short" && c.steps === 1);
    if (!c) throw new Error("missing short case");
    const run = executeRecoveryMatrixCase(c);
    expect(run.candidate.ordinaryCalls).toBe(1);
    expect(run.modelUsage.fitted).toBe(1);
    expect(run.candidate.cost).toBe(run.previousCost);
  });
});
