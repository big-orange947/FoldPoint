import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { costOfUsage, resolveUnitPrices } from "../src/index";

const resultPath = "benchmarks/reports/pi-feedback-capture-result.json";
const readResult = () => JSON.parse(readFileSync(resultPath, "utf8"));
const archiveAvailable =
  existsSync(".git") &&
  spawnSync(
    "git",
    [
      "cat-file",
      "-e",
      `${readResult().provenance.sourceArchiveCommit}:tools/pi-feedback-capture.mjs`,
    ],
    { stdio: "ignore" },
  ).status === 0;

it("reconciles the four published real requests without pretending that host estimates are truth", () => {
  const r = readResult();
  expect(r.mode).toBe("live");
  expect(r.completed).toBe(true);
  expect(Object.values(r.checks)).toEqual(Array(9).fill(true));
  expect(r.ledger.map((row: { stage: string }) => row.stage)).toEqual([
    "pre-compaction",
    "summary",
    "first-post",
    "second-post",
  ]);
  let total = 0;
  let summary = 0;
  let tokens = 0;
  for (const row of r.ledger) {
    tokens += row.input + row.output + row.cacheRead + row.cacheWrite;
    const cost = costOfUsage(resolveUnitPrices(r.catalogPricing), {
      promptTokens: row.input + row.cacheRead + row.cacheWrite,
      cachedInputTokens: row.cacheRead,
      cacheWriteTokens: row.cacheWrite,
      outputTokens: row.output,
    });
    total += cost;
    if (row.stage === "summary") summary += cost;
  }
  expect(tokens).toBe(10128);
  expect(tokens).toBe(r.usage.reportedTokens);
  expect(r.usage.httpCalls).toBe(4);
  expect(r.usage.unaccountedHttpAttempts).toBe(0);
  expect(total).toBeCloseTo(r.catalogCost.total, 12);
  expect(summary).toBeCloseTo(r.catalogCost.compaction, 12);
  expect(total - summary).toBeCloseTo(r.catalogCost.ordinary, 12);
  expect(r.boundaries).toMatchObject({
    immediateAfterEstimate: 1474,
    immediatelyKnownContext: null,
    firstPostProviderInput: 1518,
    secondPostContextEstimate: 1532,
  });
  expect(r.shadow).toMatchObject({
    eligibleFeedback: 0,
    availability: "unavailable",
    policyChanged: false,
  });
  expect(r.interpretation).toMatchObject({
    preciseRetentionMeasured: false,
    taskQualityMeasured: false,
    adaptiveTimingCompared: false,
    oneMillionContextMeasured: false,
  });
});

it.skipIf(!archiveAvailable)(
  "retains the byte-identical live producer instead of attributing old usage to revised code",
  () => {
    const r = readResult();
    // Source-only archives and shallow CI checkouts may not have the historical Git object.
    const source = execFileSync("git", [
      "show",
      `${r.provenance.sourceArchiveCommit}:tools/pi-feedback-capture.mjs`,
    ]);
    expect(createHash("sha256").update(source).digest("hex")).toBe(r.provenance.sourceSha256);
    const rawPath = "traces/pi-feedback-live-01/report.json";
    if (existsSync(rawPath)) {
      expect(createHash("sha256").update(readFileSync(rawPath)).digest("hex")).toBe(
        r.provenance.originalReportSha256,
      );
      const raw = JSON.parse(readFileSync(rawPath, "utf8"));
      expect(raw.usage.reportedTokens).toBe(r.usage.reportedTokens);
      expect(
        raw.ledger.map((row: { stage: string; usage: object }) => ({
          stage: row.stage,
          ...row.usage,
        })),
      ).toEqual(r.ledger);
      expect(
        createHash("sha256")
          .update(readFileSync("traces/pi-feedback-live-01/trace.jsonl"))
          .digest("hex"),
      ).toBe(r.provenance.originalTraceSha256);
    }
  },
);
