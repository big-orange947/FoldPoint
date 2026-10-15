import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const piRoot = resolve(process.env.FOLDPOINT_PI_ROOT ?? "D:/pi");
const available = existsSync(join(piRoot, "packages/coding-agent/src/core/sdk.ts"));
const script = "tools/pi-feedback-capture.mjs";
const sentinel = "foldpoint-test-secret-must-not-persist";
const cleanEnv = () => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
});

describe("native Pi SDK feedback capture", () => {
  it.skipIf(!available)(
    "records real SDK lifecycle offline, including unknown and delayed context sizes",
    () => {
      const out = join(mkdtempSync(join(tmpdir(), "foldpoint-capture-test-")), "result");
      const stdout = execFileSync(
        process.execPath,
        ["--import", "tsx", script, "--pi", piRoot, "--out", out],
        { encoding: "utf8", timeout: 30_000, env: { ...cleanEnv(), DEEPSEEK_API_KEY: sentinel } },
      );
      const r = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
      expect(r.completed).toBe(true);
      expect(r.mode).toBe("offline-fake-provider");
      expect(Object.values(r.checks).every(Boolean)).toBe(true);
      expect(r.ledger.map((row: { stage: string }) => row.stage)).toEqual([
        "pre-compaction",
        "summary",
        "first-post",
        "second-post",
      ]);
      expect(r.boundaries).toHaveLength(3);
      expect(r.boundaries[1]).toMatchObject({ stage: "first-post", contextTokens: null });
      expect(r.boundaries[2].contextTokens).toBeGreaterThan(0);
      expect(r.compaction.postCompactionContextTokens).toBeNull();
      expect(r.compaction.immediateAfterEstimate).toBeGreaterThan(0);
      expect(r.analysis.compactionMeasurements).toMatchObject({
        hostEstimated: 1,
        hostMeasured: 0,
        firstProviderRequests: 1,
      });
      expect(r.shadow).toMatchObject({
        eligibleFeedback: 0,
        availability: { source: "unavailable" },
        economicForecastProduced: false,
        policyChanged: false,
      });
      expect(r.analysis.overall.retention.count).toBe(0);
      expect(r.analysis.sessionCosts[0]).toMatchObject({
        calls: 3,
        compactions: 1,
        unpricedCompactions: 0,
        cacheWarms: 0,
      });
      expect(r.usage).toMatchObject({
        httpCalls: 0,
        networkAttempts: 0,
        logicalCalls: 4,
        unaccountedHttpAttempts: 0,
      });
      expect(stdout).not.toContain(sentinel);
      for (const path of readdirSync(out, { recursive: true, withFileTypes: true })) {
        if (path.isFile()) {
          const text = readFileSync(join(path.parentPath, path.name), "utf8");
          expect(text).not.toContain(sentinel);
          expect(text).not.toContain("Owner instructions:");
        }
      }
      const retry = spawnSync(
        process.execPath,
        ["--import", "tsx", script, "--pi", piRoot, "--out", out],
        { encoding: "utf8", timeout: 10_000, env: cleanEnv() },
      );
      expect(retry.status).not.toBe(0);
      expect(retry.stderr).toContain("Refusing to overwrite");
    },
    40_000,
  );

  it.skipIf(!available)(
    "preserves usage for a truncated summary without awarding a completed capture",
    () => {
      const out = join(mkdtempSync(join(tmpdir(), "foldpoint-capture-cap-")), "result");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", script, "--pi", piRoot, "--out", out, "--fake-summary-cap"],
        { encoding: "utf8", timeout: 30_000, env: cleanEnv() },
      );
      expect(result.status).toBe(1);
      const r = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
      expect(r.completed).toBe(false);
      expect(r.failure).toBe("incomplete-summary");
      expect(r.ledger).toHaveLength(2);
      expect(r.ledger[1]).toMatchObject({
        stage: "summary",
        stopReason: "length",
        usage: { output: 300 },
      });
      expect(r.checks).toBeNull();
      expect(r.usage.httpCalls).toBe(0);
    },
    40_000,
  );

  it("refuses unknown flags and live runs without a key before creating output", () => {
    for (const flags of [["--unknown"], ["--live"], ["--live", "--fake-summary-cap"]]) {
      const out = join(mkdtempSync(join(tmpdir(), "foldpoint-capture-refuse-")), "result");
      const r = spawnSync(process.execPath, ["--import", "tsx", script, "--out", out, ...flags], {
        encoding: "utf8",
        timeout: 10_000,
        env: cleanEnv(),
      });
      expect(r.status).not.toBe(0);
      expect(existsSync(out)).toBe(false);
    }
  }, 35_000);
});
