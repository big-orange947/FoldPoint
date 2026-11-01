import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const pi = resolve(process.env.FOLDPOINT_PI_ROOT ?? "D:/pi");
const available = existsSync(join(pi, "packages/coding-agent/src/core/sdk.ts"));
it.skipIf(!available)(
  "observes actual Pi SDK success, error, retry and abort using loopback only",
  () => {
    const out = join(mkdtempSync(join(tmpdir(), "pi-settlement-")), "result");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "tools/pi-settlement-probe.mjs", "--pi", pi, "--out", out],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, DEEPSEEK_API_KEY: "sentinel-never-persist" },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("sentinel-never-persist");
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report).toMatchObject({ paidCalls: 0, externalAttempts: 0 });
    const byName = Object.fromEntries(
      report.cases.map((c: { scenario: string }) => [c.scenario, c]),
    );
    expect(byName.success.events).toEqual([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_before_settle", outcome: "completed" },
      { type: "agent_settled" },
    ]);
    expect(byName.error.events).toEqual([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_before_settle", outcome: "error" },
      { type: "agent_settled" },
    ]);
    expect(byName.retry.calls).toBe(2);
    expect(byName.retry.activities).toMatchObject([
      {
        attempts: 2,
        agentEnds: 2,
        assistantStopOrToolUseMessages: 1,
        assistantOtherOrUnknownMessages: 1,
        reportedOutcome: "completed",
        canDrivePolicy: false,
      },
    ]);
    expect(byName.error.activities).toMatchObject([{ attempts: 1, reportedOutcome: "error" }]);
    expect(byName.abort.activities).toMatchObject([{ attempts: 1, reportedOutcome: "unknown" }]);
    expect(byName.retry.events).toEqual([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "auto_retry_start" },
      { type: "agent_start" },
      { type: "auto_retry_end", success: true },
      { type: "agent_end" },
      { type: "agent_before_settle", outcome: "completed" },
      { type: "agent_settled" },
    ]);
    expect(byName.abort.events).toEqual([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_settled" },
    ]);
    expect(JSON.stringify(report)).not.toContain("Synthetic task");
  },
  35000,
);
