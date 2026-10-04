import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  buildQualityPlan,
  gradeQuality,
  qualityExpected,
  qualityMessages,
} from "../benchmarks/summary-quality-corpus";

it("freezes multiple-summary exposure schedules without quality feedback or endpoint hints", () => {
  const plan = buildQualityPlan();
  expect(plan.schedules.fixed60).toEqual([18, 35, 52]);
  expect(plan.schedules.experimental).toEqual([0, 12, 20, 30, 38, 47, 56]);
  expect(plan.summaryCalls + plan.checkpointCalls).toBe(19);
  expect(plan.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(buildQualityPlan()).toEqual(plan);
  expect(qualityMessages(20)).not.toEqual(qualityMessages(21));
  expect(qualityMessages(20)[0]?.content[0]?.text).not.toContain('"expected"');
});

it("fails lost constraints, stale corrections, invented completion and malformed answers", () => {
  const expected = qualityExpected(59);
  expect(gradeQuality(JSON.stringify(expected), 59).exact).toBe(true);
  expect(
    gradeQuality(JSON.stringify({ ...expected, deployment_window: "23:00Z" }), 59).fields
      .deployment_window,
  ).toBe(false);
  expect(gradeQuality(JSON.stringify({ ...expected, backup: "verified" }), 59).fields.backup).toBe(
    false,
  );
  const missing = { ...expected };
  delete missing.rollback;
  expect(gradeQuality(JSON.stringify(missing), 59).correct).toBe(7);
  expect(gradeQuality("null", 59).correct).toBe(0);
  expect(gradeQuality("not JSON", 59).exact).toBe(false);
  expect(gradeQuality(JSON.stringify(qualityExpected(19)), 39).exact).toBe(false);
});

const piRoot = resolve(process.env.FOLDPOINT_PI_ROOT ?? "D:/pi");
it.skipIf(!existsSync(`${piRoot}/packages/coding-agent/src/core/compaction/compaction.ts`))(
  "runs native Pi initial/update prompts offline without treating fake responses as quality results",
  () => {
    const output = execFileSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "tools/pi-summary-quality.mjs", "--pi", piRoot],
      { encoding: "utf8", timeout: 30_000 },
    );
    const report = JSON.parse(output);
    expect(report.mode).toBe("dry-run-fake");
    expect(report.usage.httpCalls).toBe(0);
    expect(report.usage.reportedTokens).toBe(0);
    expect(report.usage.logicalCalls).toBe(19);
    expect(report.requestAudit.initialSummaries).toBe(2);
    expect(report.requestAudit.updatedSummaries).toBe(8);
    expect(report.requestAudit.summariesWithoutCacheRetentionNone).toBe(0);
    expect(report.requestAudit.summaryOutputCaps).toEqual(Array(10).fill(13107));
    expect(report.checkpoints).toHaveLength(9);
    expect(
      report.checkpoints.every(
        (c: { grade: unknown; measured: boolean }) => c.grade === null && !c.measured,
      ),
    ).toBe(true);
    expect(report.hardFailure).toBeNull();
    expect(output).not.toContain("Owner requirements");
  },
  35_000,
);

it.skipIf(!existsSync(`${piRoot}/packages/coding-agent/src/core/compaction/compaction.ts`))(
  "records an incomplete summary usage before Pi rejects it, and rejects silently stripped CLI options",
  () => {
    const out = join(mkdtempSync(join(tmpdir(), "foldpoint-summary-cap-")), "result");
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "tools/pi-summary-quality.mjs",
        "--pi",
        piRoot,
        "--arms",
        "fixed60",
        "--fake-summary-cap",
        "--out",
        out,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(1);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.hardFailure).toBe("output-token-cap");
    expect(report.usageLedger).toHaveLength(1);
    expect(report.usageLedger[0].stopReason).toBe("length");
    expect(report.usageLedger[0].usageKnown).toBe(true);
    expect(report.calls).toHaveLength(0);
    expect(report.usage.httpCalls).toBe(0);
    expect(report.evidenceRetentionMeasured).toBe(false);
    const invalid = spawnSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "tools/pi-summary-quality.mjs", "D:/pi"],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Unknown or incomplete argument");
  },
  35_000,
);
