import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { extractImmediateSummary, scoreImmediateSummary } from "../tools/pi-summary-feedback";

const context = {
  sequence: 1,
  stage: 2,
  binding: "a".repeat(64),
  compactorBinding: "b".repeat(64),
};
const result = {
  tokensBefore: 100_000,
  estimatedTokensAfter: 24_000,
  summary: "private-summary-must-not-leak",
  usage: { input: 140_000, cacheRead: 20_000, cacheWrite: 40_000, output: 600 },
};
const prices = resolveUnitPrices({
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
});
const model = {
  after: { slope: 0.1, intercept: 20_000, residual: 0 },
  output: { slope: 0.002, intercept: 0, residual: 0 },
  samples: 3,
  minBefore: 100_000,
  maxBefore: 600_000,
  summaryInputCostPerToken: 3e-6,
};

it("whitelists numeric fields and aggregates multi-request usage without persisting summary/free fields", () => {
  const injected = {
    ...context,
    secret: "private-context-must-not-leak",
  };
  const sample = extractImmediateSummary(result, injected);
  expect(sample).toMatchObject({
    beforeTokens: 100_000,
    afterTokens: 24_000,
    estimatedOnly: true,
    canDrivePolicy: false,
    usage: { promptTokens: 200_000, outputTokens: 600 },
  });
  expect(JSON.stringify(sample)).not.toContain("private-");
});
it.each([
  undefined,
  null,
  { tokensBefore: 1 },
  { tokensBefore: 0, estimatedTokensAfter: 10 },
  { tokensBefore: 1, estimatedTokensAfter: NaN },
  { tokensBefore: 1, estimatedTokensAfter: -1 },
])("rejects unavailable or invalid size results: %j", (value) => {
  expect(extractImmediateSummary(value, context)).toBeUndefined();
});
it("keeps a known host size when billing is unknown instead of fabricating zero cost", () => {
  const sample = extractImmediateSummary({ ...result, usage: undefined }, context);
  if (!sample) throw new Error("missing sample");
  expect(sample.usage).toBeNull();
  expect(scoreImmediateSummary(sample, model, prices)).toMatchObject({
    actualSummaryCost: null,
    actualInputCost: null,
    summaryCostError: null,
  });
});
it("scores a frozen prior without training on this sample or confusing output count and retained size", () => {
  const sample = extractImmediateSummary(result, context);
  if (!sample) throw new Error("missing sample");
  const original = structuredClone(model);
  const score = scoreImmediateSummary(sample, model, prices);
  expect(score).toMatchObject({
    predictedAfterTokens: 30_000,
    afterErrorTokens: 6000,
    predictedOutputTokens: 200,
    policyConsumed: false,
    comparedWithHostEstimate: true,
  });
  expect(score?.actualInputCost).toBeCloseTo(140000 * 3e-6 + 20000 * 0.3e-6 + 40000 * 3.75e-6, 12);
  expect(score?.actualSummaryCost).toBeCloseTo((score?.actualInputCost ?? 0) + 600 * 15e-6, 12);
  expect(
    scoreImmediateSummary({ ...sample, afterTokens: 2000 }, model, prices)?.predictedAfterTokens,
  ).toBe(30_000);
  expect(model).toEqual(original);
  expect(scoreImmediateSummary(sample, undefined, prices)).toBeNull();
});
it("does not classify invalid partial usage or unsafe sums as a priced sample", () => {
  for (const usage of [
    { input: 1, output: 1, cacheRead: 0 },
    { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 1, cacheWrite: 0 },
  ])
    expect(extractImmediateSummary({ ...result, usage }, context)?.usage).toBeNull();
  expect(() => extractImmediateSummary(result, { ...context, binding: "free form text" })).toThrow(
    /binding/,
  );
});

it("rejects unknown/live reconstruction options before touching input files", () => {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/pi-summary-reconstruct.mjs", "--live"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, DEEPSEEK_API_KEY: "sentinel-secret" },
    },
  );
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("failed validation");
  expect(r.stderr).not.toContain("sentinel-secret");
});
it("refuses to overwrite an existing reconstruction even when other inputs are missing", () => {
  const out = join(mkdtempSync(join(tmpdir(), "summary-reconstruction-")), "existing.json");
  writeFileSync(out, "preserve-original");
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "tools/pi-summary-reconstruct.mjs",
      "--session",
      "missing",
      "--audit",
      "missing",
      "--run-report",
      "missing",
      "--pi",
      "missing",
      "--out",
      out,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(r.status).toBe(1);
  expect(readFileSync(out, "utf8")).toBe("preserve-original");
});
