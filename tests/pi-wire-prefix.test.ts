import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const piRoot = resolve(process.env.FOLDPOINT_PI_ROOT ?? "D:/pi");
const available = existsSync(join(piRoot, "packages/coding-agent/src/core/sdk.ts"));
const script = "tools/pi-wire-prefix-probe.mjs";
const sentinel = "wire-probe-secret-must-not-persist";
const env = () => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  DEEPSEEK_API_KEY: sentinel,
});

describe("Pi serialized HTTP boundary", () => {
  it.skipIf(!available)(
    "checks actual loopback bodies after payload transforms and reconciles multi-request summary usage",
    () => {
      const out = join(mkdtempSync(join(tmpdir(), "foldpoint-wire-test-")), "result");
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", script, "--pi", piRoot, "--out", out],
        { encoding: "utf8", timeout: 45_000, env: env() },
      );
      const r = JSON.parse(output);
      expect(r).toMatchObject({
        completed: true,
        paidCalls: 0,
        policyChanged: false,
        providerSerializationExercised: true,
        cacheHitsMeasured: false,
        taskQualityMeasured: false,
      });
      expect(r.usage.externalAttempts).toBe(0);
      expect(r.rows).toHaveLength(7);
      expect(r.rows.every((row: { passed: boolean }) => row.passed)).toBe(true);
      const all = r.rows as Array<{
        id: string;
        ordinaryRequests: number;
        summaryRequests: number;
        serverRequests: number;
        simulatedCost: number;
        expectedSimulatedCost: number;
        pricedSummaries: number;
        comparisons: Array<{
          earlyAppendOnly: boolean;
          wirePrefixUnchanged: boolean;
          messagePrefixSame: boolean;
          otherFieldsSame: boolean;
        }>;
      }>;
      expect(all.find((row) => row.id === "append-only")?.comparisons[0]?.wirePrefixUnchanged).toBe(
        true,
      );
      for (const row of all.filter((row) => row.id.startsWith("payload-"))) {
        expect(row.comparisons[0]).toMatchObject({
          earlyAppendOnly: true,
          wirePrefixUnchanged: false,
        });
      }
      expect(all.find((row) => row.id === "payload-tools")?.comparisons[0]).toMatchObject({
        messagePrefixSame: true,
        otherFieldsSame: false,
      });
      expect(all.find((row) => row.id === "payload-model")?.comparisons[0]).toMatchObject({
        messagePrefixSame: true,
        otherFieldsSame: false,
      });
      const compact = all.find((row) => row.id === "native-compaction");
      expect(compact?.comparisons.map((c) => c.wirePrefixUnchanged)).toEqual([true, false, true]);
      expect(compact?.pricedSummaries).toBe(1);
      expect(compact?.summaryRequests).toBeGreaterThan(0);
      if (r.piCommit === "d201760ffee16564aa8d9a759e0c85b70db33674")
        expect(compact?.summaryRequests).toBe(2);
      expect(r.usage.httpCalls).toBe(all.reduce((sum, row) => sum + row.serverRequests, 0));
      for (const row of all) expect(row.simulatedCost).toBeCloseTo(row.expectedSimulatedCost, 12);
      for (const file of readdirSync(out, { recursive: true, withFileTypes: true })) {
        if (file.isFile()) {
          const text = readFileSync(join(file.parentPath, file.name), "utf8");
          expect(text).not.toContain(sentinel);
          expect(text).not.toContain("Synthetic first task.");
          expect(text).not.toContain("Synthetic payload rewrite.");
        }
      }
      const before = readFileSync(join(out, "report.json"), "utf8");
      const retry = spawnSync(process.execPath, ["--import", "tsx", script, "--out", out], {
        encoding: "utf8",
        timeout: 10_000,
        env: env(),
      });
      expect(retry.status).not.toBe(0);
      expect(retry.stderr).toContain("Refusing to overwrite");
      expect(readFileSync(join(out, "report.json"), "utf8")).toBe(before);
    },
    50_000,
  );

  it("refuses paid or unknown options before creating output or opening a server", () => {
    for (const flag of ["--live", "--unknown"]) {
      const out = join(mkdtempSync(join(tmpdir(), "foldpoint-wire-refuse-")), "result");
      const r = spawnSync(process.execPath, ["--import", "tsx", script, "--out", out, flag], {
        encoding: "utf8",
        timeout: 10_000,
        env: env(),
      });
      expect(r.status).not.toBe(0);
      expect(existsSync(out)).toBe(false);
      expect(r.stderr).not.toContain(sentinel);
    }
  });
});
