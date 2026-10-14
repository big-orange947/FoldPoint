import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRepeatedQualityPlan,
  gradeRepeated,
  repeatedExpected,
  repeatedMessages,
} from "../tools/repeated-summary-corpus";

describe("frozen repeated-summary evidence retention probe", () => {
  it("binds the new matrix and freezes a 23-call three-arm prefix without quality feedback", () => {
    const plan = buildRepeatedQualityPlan();
    expect(plan.stages).toBe(90);
    expect(plan.checkpoints).toEqual([29, 59, 89]);
    expect(plan.schedules.fixed60).toEqual([27, 52, 77]);
    expect(plan.schedules.experimental).toEqual([0, 15, 22, 29, 37, 45, 53, 60, 68, 76, 84]);
    expect(plan.summaryCalls).toBe(14);
    expect(plan.summaryCalls + plan.checkpointCalls).toBe(23);
    expect(plan.maxHttpCalls).toBe(24);
    expect(plan.matrixSha256).toHaveLength(64);
    expect(buildRepeatedQualityPlan()).toEqual(plan);
  });
  it("grades stale facts, forgotten constraints and premature deployment separately", () => {
    for (const step of [29, 59, 89])
      expect(gradeRepeated(JSON.stringify(repeatedExpected(step)), step).exact).toBe(true);
    const current = repeatedExpected(59);
    const bad = gradeRepeated(
      JSON.stringify({
        ...current,
        deployment_window: "23:00Z",
        owner: "unknown",
        deployment_allowed: true,
        next_action: "deploy",
        backup: "verified",
      }),
      59,
    );
    expect(bad.correct).toBe(7);
    expect(bad.fields.deployment_allowed).toBe(false);
    expect(bad.fields.backup).toBe(false);
    expect(
      gradeRepeated(
        JSON.stringify({ ...repeatedExpected(89), config_path: "config/release.toml" }),
        89,
      ).fields.config_path,
    ).toBe(false);
    expect(gradeRepeated(JSON.stringify(repeatedExpected(29)), 89).exact).toBe(false);
  });
  it("rejects malformed answers, extra fields and a string in place of a boolean", () => {
    for (const text of ["null", "[]", "broken", "{}"])
      expect(gradeRepeated(text, 89).exact).toBe(false);
    expect(
      gradeRepeated(JSON.stringify({ ...repeatedExpected(89), extra: "invented" }), 89).exact,
    ).toBe(false);
    expect(
      gradeRepeated(JSON.stringify({ ...repeatedExpected(89), deployment_allowed: "true" }), 89)
        .fields.deployment_allowed,
    ).toBe(false);
    expect(() => repeatedExpected(-1)).toThrow();
    expect(() => repeatedMessages(90)).toThrow();
  });
  it("keeps evaluator answers out of logs, while old constraints and later corrections have real evidence", () => {
    expect(repeatedMessages(0)[0]?.content[0]?.text).toContain("operator-mira");
    expect(repeatedMessages(63)[0]?.content[0]?.text).toContain("config/prod.toml");
    expect(repeatedMessages(75)[0]?.content[0]?.text).toContain("backup verification succeeded");
    for (let i = 0; i < 90; i++) {
      const text = JSON.stringify(repeatedMessages(i));
      expect(text).not.toContain('"expected"');
      expect(text).not.toContain("deployment_allowed");
      if (i > 0) expect(text).not.toContain("operator-mira");
    }
  });
});

const piRoot = process.env.FOLDPOINT_PI_ROOT ?? "D:/pi";
it.skipIf(!existsSync(`${piRoot}/packages/coding-agent/src/core/compaction/compaction.ts`))(
  "exercises real Pi initial/update prompts offline without awarding fake quality scores",
  () => {
    const output = execFileSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "tools/pi-summary-quality.mjs",
        "--profile",
        "repeated",
        "--pi",
        piRoot,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, DEEPSEEK_API_KEY: "fake-key-must-not-be-used" },
      },
    );
    const report = JSON.parse(output);
    expect(report.mode).toBe("dry-run-fake");
    expect(report.plannedCalls).toBe(23);
    expect(report.usage.logicalCalls).toBe(23);
    expect(report.usage.httpCalls).toBe(0);
    expect(report.usage.reportedTokens).toBe(0);
    expect(report.requestAudit.initialSummaries).toBe(2);
    expect(report.requestAudit.updatedSummaries).toBe(12);
    expect(report.requestAudit.summaryOutputCaps).toEqual(Array(14).fill(13107));
    expect(report.checkpoints).toHaveLength(9);
    expect(
      report.checkpoints.every(
        (c: { measured: boolean; grade: unknown }) => !c.measured && c.grade === null,
      ),
    ).toBe(true);
    expect(report.completedPlannedRun).toBe(true);
    expect(report.comparableThreeArmRun).toBe(false);
    expect(output).not.toContain("fake-key-must-not-be-used");
    expect(output).not.toContain("Owner instructions");
  },
  35000,
);
it.skipIf(!existsSync(`${piRoot}/packages/coding-agent/src/core/compaction/compaction.ts`))(
  "records repeated-summary truncation as an incomplete, unmeasured run",
  () => {
    const out = join(mkdtempSync(join(tmpdir(), "foldpoint-repeated-cap-")), "result");
    const child = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "tools/pi-summary-quality.mjs",
        "--profile",
        "repeated",
        "--pi",
        piRoot,
        "--arms",
        "experimental",
        "--fake-summary-cap",
        "--out",
        out,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    expect(child.status).toBe(1);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.hardFailure).toBe("output-token-cap");
    expect(report.evidenceRetentionMeasured).toBe(false);
    expect(report.completedPlannedRun).toBe(false);
    expect(report.usage.httpCalls).toBe(0);
    expect(report.usageLedger[0]?.stopReason).toBe("length");
  },
  35000,
);
