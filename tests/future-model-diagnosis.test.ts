import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const report = read("../benchmarks/reports/future-replication.json");
const diagnosis = read("../benchmarks/reports/future-model-diagnosis.json") as {
  candidateCommit: string;
  externalCalls: number;
  paidCalls: number;
  sourceHashes: Record<string, string>;
  rows: {
    profile: string;
    sourceFixture: string;
    seed: number;
    steps: number;
    errorCode: string;
    lastValidStep: number;
    evidenceKind: string;
    evidence: {
      step: number;
      samples: number;
      minBefore: number;
      maxBefore: number;
      spanRatio: number;
      modelAvailable: boolean;
      successfulCompactions: number;
    };
  }[];
};
describe("frozen learned-model failure evidence", () => {
  it("accounts for every reported failed case with the same frozen sources", () => {
    expect(diagnosis.candidateCommit).toBe("dafcc42");
    expect(diagnosis.externalCalls).toBe(0);
    expect(diagnosis.paidCalls).toBe(0);
    expect(diagnosis.sourceHashes).toEqual(report.metadata.sourceHashes);
    expect(
      diagnosis.rows.map(({ profile, sourceFixture, seed, steps, errorCode }) => ({
        profile,
        sourceFixture,
        seed,
        steps,
        errorCode,
      })),
    ).toEqual(
      report.failures.map(
        ({ profile, sourceFixture, seed, steps, errorCode }: (typeof diagnosis.rows)[number]) => ({
          profile,
          sourceFixture,
          seed,
          steps,
          errorCode,
        }),
      ),
    );
  });
  it("retains actual rolling-window evidence, not invented failure costs", () => {
    for (const r of diagnosis.rows) {
      expect(r.evidenceKind).toBe("mirror-of-actual-successful-feedback");
      expect(r.evidence.modelAvailable).toBe(false);
      expect(r.evidence.samples).toBe(32);
      expect(r.evidence.spanRatio).toBe(
        (r.evidence.maxBefore - r.evidence.minBefore) / r.evidence.maxBefore,
      );
      expect(r.evidence.spanRatio).toBeLessThan(0.2);
      expect(r.lastValidStep).toBe(r.evidence.step - 1);
      expect(r.evidence.step).toBeLessThan(r.steps);
      expect(r.evidence.successfulCompactions).toBeGreaterThan(32);
      expect(r).not.toHaveProperty("cost");
    }
  });
});
