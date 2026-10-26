import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { auditImmediateRetention } from "../tools/pi-retention-audit";
import { PiImmediateRetentionLearner } from "../tools/pi-retention-learner";

const binding = {
  profileBinding: "a".repeat(64),
  compactorBinding: "b".repeat(64),
  estimatorId: "pi-host/v1",
};
const assumptions = { beforeErrorTokens: 0, afterErrorTokens: 0, driftToleranceRatio: 0.05 };
const make = () => new PiImmediateRetentionLearner(binding, assumptions);
const sample = (sequence: number, beforeTokens: number, afterTokens: number) => ({
  v: 1,
  source: "pi-compaction-result-estimatedTokensAfter",
  binding: binding.profileBinding,
  compactorBinding: binding.compactorBinding,
  sequence,
  beforeTokens,
  afterTokens,
  usage: null,
  summary: "private-summary-sentinel",
});

it("keeps the cold 10% prior separate from learned samples and extrapolation authority", () => {
  const m = make();
  expect(m.predict(600000)).toMatchObject({ status: "prior-only", pointTokens: 60000 });
  expect(m.snapshot()).toMatchObject({ accepted: 0, identifiable: false, canDrivePolicy: false });
  m.observe(sample(1, 210000, 23000));
  expect(m.predict(600000)).toMatchObject({ status: "outside-observed-range", pointTokens: null });
  expect(m.predict(210000)).toMatchObject({
    status: "local-low-span-fallback",
    pointTokens: 23000,
  });
});

it.each([
  ["constant", (_x: number) => 23000],
  ["ratio", (x: number) => 0.1 * x],
  ["affine", (x: number) => 10000 + 0.05 * x],
])(
  "learns %s behavior from past wide-span observations without a task-specific default",
  (_kind, law) => {
    const m = make();
    for (const [i, x] of [100000, 200000, 400000].entries()) m.observe(sample(i + 1, x, law(x)));
    expect(m.predict(300000).status).toBe("fitted-host-model");
    expect(m.predict(300000).pointTokens).toBeCloseTo(law(300000), 6);
    expect(m.predict(600000).pointTokens).toBeNull();
  },
);

it("does not turn many narrow-input samples into a falsely identified slope", () => {
  const m = make();
  for (let i = 1; i <= 60; i++) m.observe(sample(i, 210000 + i * 10, 23000));
  expect(m.snapshot()).toMatchObject({ accepted: 60, retainedSamples: 32, identifiable: false });
  expect(m.predict(600000).pointTokens).toBeNull();
});

it("rejects reconstructed/delayed, wrong configuration and duplicate samples without consuming order", () => {
  const m = make();
  expect(
    m.observe({ ...sample(1, 100000, 23000), source: "offline-pi-projection-at-compaction-entry" }),
  ).toBe("not-immediate-feedback");
  expect(m.observe({ ...sample(1, 100000, 23000), compactorBinding: "c".repeat(64) })).toBe(
    "incompatible-binding",
  );
  expect(m.observe(sample(1, 100000, 23000))).toBe("accepted");
  const before = m.snapshot();
  expect(m.observe(sample(1, 100000, 23000))).toBe("duplicate-or-out-of-order");
  expect(m.observe(sample(2, 1, 2))).toBe("invalid-observation");
  expect(m.snapshot()).toEqual(before);
  expect(m.observe(sample(2, 200000, 23000))).toBe("accepted");
});

it("invalidates a previously fitted regime on an unexpected in-range retention jump", () => {
  const m = make();
  for (const [i, x] of [100000, 200000, 400000].entries()) m.observe(sample(i + 1, x, 23000));
  expect(m.snapshot().identifiable).toBe(true);
  expect(m.observe(sample(4, 300000, 60000))).toBe("accepted-after-drift-reset");
  expect(m.snapshot()).toMatchObject({ driftResets: 1, identifiable: false, retainedSamples: 1 });
  expect(m.predict(100000).pointTokens).toBeNull();
});

it("predicts before training, allows known sizes with unknown billing, and never retains body fields", () => {
  const m = make();
  const before = m.predict(100000);
  m.observe(sample(1, 100000, 30000));
  expect(before.pointTokens).toBe(20000);
  expect(m.predict(100000).pointTokens).toBe(30000);
  expect(JSON.stringify(m.snapshot())).not.toContain("private-summary-sentinel");
  expect(m.snapshot().hostEstimateOnly).toBe(true);
});

it("copies compatibility/error settings and separates estimator versions", () => {
  const b = { ...binding },
    a = { ...assumptions };
  const m = new PiImmediateRetentionLearner(b, a);
  const initial = m.snapshot().basis;
  b.compactorBinding = "c".repeat(64);
  a.afterErrorTokens = 100;
  expect(m.observe(sample(1, 100000, 23000))).toBe("accepted");
  expect(m.snapshot().basis).toBe(initial);
  expect(
    new PiImmediateRetentionLearner(
      { ...binding, estimatorId: "pi-host/v2" },
      assumptions,
    ).snapshot().basis,
  ).not.toBe(initial);
  expect(
    () => new PiImmediateRetentionLearner(binding, { ...assumptions, driftToleranceRatio: NaN }),
  ).toThrow();
});

it("audits each held-next prediction before its target is learned and never labels a prior as learned accuracy", () => {
  const observations = [100000, 200000, 400000, 300000, 250000].map((x, i) =>
    sample(i + 1, x, 23000),
  );
  const report = auditImmediateRetention(observations, binding, assumptions);
  expect(report.summary).toMatchObject({
    priorForecasts: 1,
    fittedForecasts: 2,
    unavailableForecasts: 2,
  });
  expect(report.rows.map((r) => r.priorSampleCount)).toEqual([0, 1, 2, 3, 4]);
  const changed = structuredClone(observations);
  const last = changed.at(-1);
  if (!last) throw new Error("missing target");
  last.afterTokens = 60000;
  const other = auditImmediateRetention(changed, binding, assumptions);
  expect(other.rows.slice(0, -1)).toEqual(report.rows.slice(0, -1));
  expect(other.rows.at(-1)?.predictedAfterTokens).toBe(report.rows.at(-1)?.predictedAfterTokens);
  expect(other.finalState.driftResets).toBe(1);
  expect(JSON.stringify(report)).not.toContain("private-summary-sentinel");
});

it("rejects whole mixed/reconstructed audit streams instead of silently counting incompatible rows as predictions", () => {
  expect(() =>
    auditImmediateRetention(
      [sample(1, 100000, 23000), { ...sample(2, 200000, 23000), binding: "c".repeat(64) }],
      binding,
      assumptions,
    ),
  ).toThrow();
  expect(() =>
    auditImmediateRetention(
      [{ ...sample(1, 100000, 23000), source: "offline-pi-projection-at-compaction-entry" }],
      binding,
      assumptions,
    ),
  ).toThrow();
});

it("refuses live audit options without exposing environment credentials", () => {
  const p = spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/pi-retention-audit.ts", "--live"],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, DEEPSEEK_API_KEY: "retention-secret-sentinel" },
    },
  );
  expect(p.status).toBe(1);
  expect(p.stderr).toContain("failed validation");
  expect(p.stderr).not.toContain("retention-secret-sentinel");
});

it("does not overwrite an existing audit artifact", () => {
  const out = join(mkdtempSync(join(tmpdir(), "retention-audit-")), "existing.json");
  writeFileSync(out, "keep-original");
  const p = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "tools/pi-retention-audit.ts",
      "--feedback",
      "missing",
      "--estimator-id",
      "pi/v1",
      "--host-error-tokens",
      "0",
      "--out",
      out,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(p.status).toBe(1);
  expect(readFileSync(out, "utf8")).toBe("keep-original");
});
