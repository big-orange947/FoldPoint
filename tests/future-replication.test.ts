import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildReplicationReport,
  REPLICATION_MANIFEST,
  recordProductFailure,
  replicationCases,
  replicationPrefixAudits,
} from "../benchmarks/future-replication";
import type { buildWarmLengthReport } from "../benchmarks/warm-length-seed";
import { ExperimentalCompactorLearner } from "../src/index";

type Report = ReturnType<typeof buildReplicationReport>;
const frozen = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/warm-length-seed.json", import.meta.url), "utf8"),
) as ReturnType<typeof buildWarmLengthReport>;
function prefixFixture(): Report["rows"] {
  // Real incumbent controls ONLY, to unit-test prefix validation; not candidate results.
  return frozen.rows
    .filter(
      (r) =>
        r.suite === "main" &&
        r.profile === REPLICATION_MANIFEST.profiles[0] &&
        r.sourceFixture === REPLICATION_MANIFEST.sourceFixtures[0] &&
        r.seed === 151,
    )
    .map((r) => ({
      profile: r.profile,
      sourceFixture: r.sourceFixture,
      seed: r.seed,
      steps: r.steps,
      fixed60: r.fixed60,
      incumbent: r.paired,
      candidate: r.paired,
      audit: {
        ...r.pairedAudit,
        checkpoints: r.pairedAudit.checkpoints.filter((t) =>
          (REPLICATION_MANIFEST.sampledCheckpointCalls as readonly number[]).includes(t.step),
        ),
      },
      vsFixed60: r.pairedChange,
      vsIncumbent: 0,
      historyCost: r.historyCost,
      reusedInitial: r.steps === 360,
      growthPrefixes: r.growthPrefixFingerprints,
    }));
}
describe("frozen future-rule replication manifest and prefix guards", () => {
  it("selects the full declared factorial, not favourable prices or endpoints", () => {
    const cases = replicationCases();
    expect(cases).toHaveLength(252);
    for (const profile of REPLICATION_MANIFEST.profiles)
      expect(cases.filter((c) => c.profile === profile)).toHaveLength(36);
    for (const seed of REPLICATION_MANIFEST.seeds)
      expect(cases.filter((c) => c.seed === seed)).toHaveLength(84);
    for (const steps of REPLICATION_MANIFEST.lengths)
      expect(cases.filter((c) => c.steps === steps)).toHaveLength(84);
    expect(cases.every((c) => c.contract === "summary-uncached")).toBe(true);
    expect(REPLICATION_MANIFEST.candidateCommit).toBe("dafcc42");
    expect(REPLICATION_MANIFEST.maxChecksPerPath).toBe(2);
  });
  it("checks genuine growth and action prefixes before forming interval bill deltas", () => {
    const audits = replicationPrefixAudits(prefixFixture());
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.growthAndActionsMatch)).toBe(true);
    expect(audits[0]?.from).toBe(120);
    expect(audits[0]?.to).toBe(240);
    for (const a of audits) {
      if (a.status !== "PASS") throw new Error("missing successful endpoints");
      expect(a.incrementalChange).toBe(a.candidateIncrement / a.fixed60Increment - 1);
    }
  });
  it("rejects changed growth, earlier actions or checkpoint state", () => {
    for (const kind of ["growth", "action", "checkpoint"] as const) {
      const rows = structuredClone(prefixFixture());
      const long = rows.find((r) => r.steps === 240);
      if (!long) throw new Error("missing fixture");
      if (kind === "growth") {
        const p = long.growthPrefixes.find((p) => p.steps === 120);
        if (!p) throw new Error("missing prefix");
        p.fingerprint = "changed";
      }
      if (kind === "action") {
        const c = long.candidate.compactions[0];
        if (!c) throw new Error("missing action");
        c.afterTokens++;
      }
      if (kind === "checkpoint") {
        const t = long.audit.checkpoints[0];
        if (!t) throw new Error("missing checkpoint");
        t.context++;
      }
      expect(() => replicationPrefixAudits(rows)).toThrow(/prefix mismatch/);
    }
  });
  it("refuses partial matrices or a changed frozen manifest", () => {
    const metadata: Report["metadata"] = {
      manifest: REPLICATION_MANIFEST,
      sourceHashes: { fixture: "a".repeat(64) },
      nodeVersion: "fixture",
      frozenControlSha256: "a".repeat(64),
      initialReportSha256: "b".repeat(64),
      cacheKey: "c".repeat(64),
    };
    expect(() => buildReplicationReport(prefixFixture(), [], metadata)).toThrow(/matrix/);
    const changed = { ...metadata, manifest: { ...metadata.manifest, maxChecksPerPath: 3 as 2 } };
    expect(() => buildReplicationReport([], [], changed)).toThrow(/manifest/);
  });
  it("records only the known product error and does not disguise other failures", () => {
    const c = replicationCases()[0];
    if (!c) throw new Error("missing fixture");
    const failure = recordProductFailure(
      c,
      new RangeError(
        "future qualification requires renewal, paired stress, execution gates and token model; excludes other ablations and cumulative budgets",
      ),
    );
    expect(failure.errorCode).toBe("FORECAST_MODEL_REQUIREMENT_LOST");
    const error = new Error("control mismatch");
    expect(() => recordProductFailure(c, error)).toThrow(error);
    expect(() => recordProductFailure(c, new RangeError("other"))).toThrow("other");
  });
  it("marks a failed endpoint unavailable rather than fabricating a prefix pass", () => {
    const rows = prefixFixture();
    const missing = rows.find((r) => r.steps === 240);
    if (!missing) throw new Error("missing fixture");
    const audits = replicationPrefixAudits(
      rows.filter((r) => r.steps !== 240),
      [
        {
          ...missing,
          errorCode: "FORECAST_MODEL_REQUIREMENT_LOST",
          message: "fixture",
        },
      ],
    );
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.status === "NOT_AVAILABLE" && a.incrementalChange === null)).toBe(
      true,
    );
  });
  it("demonstrates the learner can lose identifiability after its bounded window rolls", () => {
    const learner = new ExperimentalCompactorLearner();
    for (const beforeTokens of [200000, 400000, 600000])
      learner.observe({
        beforeTokens,
        afterTokens: 20000,
        outputTokens: 2000,
        summaryInputCostPerToken: 0.000001,
      });
    expect(learner.snapshot()).toBeDefined();
    for (let i = 0; i < 32; i++)
      learner.observe({
        beforeTokens: 400000 + i * 100,
        afterTokens: 20000,
        outputTokens: 2000,
        summaryInputCostPerToken: 0.000001,
      });
    expect(learner.exportObservations()).toHaveLength(32);
    expect(learner.snapshot()).toBeUndefined();
  });
});
