import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FoldPoint, type FoldPointProfile, TraceRecorder } from "../src/index";
import { buildSteadyHistory } from "../tools/pi-steady-history";

const profile: FoldPointProfile = {
  provider: "local",
  model: "model",
  contextWindowTokens: 1_000_000,
  compactorId: "native",
  pricing: { currency: "USD", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
};
const trace = new TraceRecorder(),
  engine = new FoldPoint();
const input = { sessionId: "test", timestamp: 1, contextTokens: 600_000, profile };
const events = [
  trace.header(),
  trace.decision(input, engine.decide(input)),
  trace.compaction(
    "test",
    {
      timestamp: 2,
      beforeTokens: 600_000,
      afterTokens: 56_000,
      success: true,
      promptTokens: 590_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 450,
    },
    { action: "COMPACT", afterTokensSource: "host-estimate" },
  ),
];

it("uses historical aggregate billing but labels delayed retention a proxy and keeps structural priors", () => {
  const model = buildSteadyHistory(events, profile, 20_000);
  expect(model).toMatchObject({
    samples: 1,
    estimatedOnly: true,
    model: {
      after: { slope: 0.1, intercept: 20_000 },
      output: { slope: 0.002 },
    },
  });
  expect(model?.model.summaryInputCostPerToken).toBeCloseTo((590_000 * 3e-6) / 600_000, 12);
});
it("does not carry models across pricing/model changes or treat missing/failed usage as free", () => {
  expect(buildSteadyHistory(events, { ...profile, model: "other" }, 20_000)).toBeUndefined();
  expect(
    buildSteadyHistory(
      events,
      { ...profile, pricing: { ...profile.pricing, inputPerMillion: 5, outputPerMillion: 15 } },
      20_000,
    ),
  ).toBeUndefined();
  const broken = events.map((e) => (e.type === "compaction" ? { ...e, usage: undefined } : e));
  expect(buildSteadyHistory(broken, profile, 20_000)).toBeUndefined();
  expect(
    buildSteadyHistory(
      events.map((e) => (e.type === "compaction" ? { ...e, success: false } : e)),
      profile,
      20_000,
    ),
  ).toBeUndefined();
});
it("does not require the same cache-namespace prefix but does require compatible prices", () => {
  expect(
    buildSteadyHistory(events, { ...profile, prefixId: "new-isolated-namespace" }, 20_000)?.samples,
  ).toBe(1);
});

it("refuses an invalid paid seed before loading a Pi process or task manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "steady-bad-seed-")),
    seed = join(dir, "seed.jsonl"),
    out = join(dir, "result");
  writeFileSync(seed, "not-json\n");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "tools/pi-million-rpc.ts",
      "--manifest",
      "does-not-exist",
      "--agent-base",
      dir,
      "--out",
      out,
      "--arm",
      "dynamic",
      "--steady-history",
      seed,
      "--max-cost-usd",
      "1",
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PI_CLI: process.execPath,
        DEEPSEEK_API_KEY: "sentinel-must-not-persist",
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Steady history is invalid");
  expect(result.stderr).not.toContain("sentinel-must-not-persist");
  expect(existsSync(`${out}-report.json`)).toBe(false);
});
