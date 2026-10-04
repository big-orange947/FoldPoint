import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const piRoot = resolve(process.env.FOLDPOINT_PI_ROOT ?? "D:/pi");
const available = existsSync(`${piRoot}/packages/coding-agent/src/core/extensions/runner.ts`);

it.skipIf(!available)(
  "audits the real local Pi transform pipeline with no network and no private output",
  () => {
    const output = execFileSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "tools/pi-prefix-audit.mjs", piRoot],
      { encoding: "utf8", timeout: 30_000 },
    );
    const report = JSON.parse(output);
    expect(report.runner).toBe("foldpoint.pi-prefix-audit.v1");
    expect(report.piCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof report.piTrackedDirty).toBe("boolean");
    expect(report.runnerSourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.passed).toBe(true);
    expect(report.scenarios).toHaveLength(8);
    expect(report.scenarios.every((row: { passed: boolean }) => row.passed)).toBe(true);
    expect(report.earlyFalsePositives).toBe(5);
    expect(report.networkAttempts).toBe(0);
    expect(report.paidCalls).toBe(0);
    expect(report.providerSerializationExercised).toBe(false);
    expect(report.cacheHitsMeasured).toBe(false);
    expect(report.taskQualityMeasured).toBe(false);
    expect(output).not.toContain("Synthetic private fixture");
    expect(output).not.toContain("Synthetic system instructions");
    expect(output).not.toContain("Synthetic compacted summary");
  },
  35_000,
);
