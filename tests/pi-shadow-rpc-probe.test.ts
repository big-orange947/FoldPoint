import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const pi = resolve(process.env.FOLDPOINT_PI_ROOT ?? "D:/pi");
it.skipIf(!existsSync(join(pi, "packages/coding-agent/dist/cli.js")))(
  "persists actual RPC compaction feedback across two isolated Pi processes using loopback only",
  () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "tools/pi-shadow-rpc-probe.ts", pi],
      {
        encoding: "utf8",
        timeout: 45000,
        env: { ...process.env, DEEPSEEK_API_KEY: "rpc-secret-sentinel" },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("rpc-secret-sentinel");
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      completed: true,
      piRpcProcesses: 2,
      ordinaryCalls: 4,
      restoredSamples: 1,
      finalSamples: 2,
      evaluationRestored: true,
      paidCalls: 0,
      applied: false,
    });
    expect(report.summaryCalls).toBeGreaterThanOrEqual(1);
  },
  50000,
);
