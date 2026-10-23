import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const r = JSON.parse(readFileSync("benchmarks/reports/pi-floor-attribution-20261023.json", "utf8"));
it("reconciles the recovered historical bill and labels retrospective size evidence honestly", () => {
  const mean =
    r.fixedCheckpoints.reduce(
      (n: number, c: { reconstructedAfter: number }) => n + c.reconstructedAfter,
      0,
    ) / 3;
  const cost = r.fixedCheckpoints.reduce(
    (n: number, c: { summaryCost: number }) => n + c.summaryCost,
    0,
  );
  expect(mean).toBe(r.summary.fixedMeanReconstructedAfter);
  expect(mean).toBe(23134);
  expect(cost).toBeCloseTo(0.5361915, 12);
  for (const c of r.fixedCheckpoints) {
    expect(c.priorAfter).toBeCloseTo(c.before * 0.1, 7);
    expect(c.delayedTraceAfter).toBeGreaterThan(c.reconstructedAfter);
  }
  expect(r.summary.fixedMeanPriorAfter / mean - 1).toBeCloseTo(
    r.summary.fixedMeanRelativeOverestimate,
    7,
  );
  expect(r.firstDecisionSensitivity).toMatchObject({
    policyExecuted: false,
    realizedSavings: null,
  });
  expect(r.firstDecisionSensitivity.retrospectiveFixedSizeBefore).toBeGreaterThan(
    r.firstDecisionSensitivity.originalBefore,
  );
  expect(r.paidCalls).toBe(0);
  for (const hash of Object.values(r.hashes)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
});

it("rejects live/unknown options without printing keys or reading source files", () => {
  const p = spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/pi-floor-attribution.mjs", "--live"],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, DEEPSEEK_API_KEY: "attribution-secret-sentinel" },
    },
  );
  expect(p.status).toBe(1);
  expect(p.stderr).toContain("failed validation");
  expect(p.stderr).not.toContain("attribution-secret-sentinel");
});

it("refuses to replace an existing artifact even with missing input paths", () => {
  const out = join(mkdtempSync(join(tmpdir(), "floor-attribution-")), "existing.json");
  writeFileSync(out, "preserve");
  const args = [
    "--pi",
    "--v2-report",
    "--v2-audit",
    "--v2-feedback",
    "--fixed-report",
    "--fixed-session",
  ].flatMap((flag) => [flag, "missing"]);
  const p = spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/pi-floor-attribution.mjs", ...args, "--out", out],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(p.status).toBe(1);
  expect(readFileSync(out, "utf8")).toBe("preserve");
});
