import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { PiRetainedShadow } from "../tools/pi-retained-shadow";

const prices = resolveUnitPrices({
  inputPerMillion: 0.3,
  outputPerMillion: 1.2,
  cacheReadPerMillion: 0.006,
});

it("keeps forecasts before results and learns only after successful host feedback", () => {
  const s = new PiRetainedShadow(prices);
  s.beforeSummary(10000);
  expect(s.report().samples).toBe(0);
  expect(s.report().events[0]?.predictedAfterHostTokens).toBe(1000);
  expect(() => s.afterSummary(10000, 0)).toThrow();
  expect(s.report().events).toHaveLength(1);
  s.beforeRequest("summary", 9000);
  s.afterRequest("summary", { input: 8000, cacheRead: 1000, cacheWrite: 0, output: 500 });
  s.afterSummary(10000, 1500);
  s.beforeRequest("first-post", 1600);
  expect(s.report().events.at(-1)?.priorSamples).toBe(1);
  expect(s.report().events.at(-1)?.cacheUsageKnown).toBe(false);
  expect(s.report().events.at(-1)?.predictedAfterHostTokensIfCompacted).toBe(240);
  s.afterRequest("first-post", { input: 1500, cacheRead: 0, cacheWrite: 0, output: 1 });
  expect(s.report()).toMatchObject({
    samples: 1,
    pendingRequests: 0,
    pendingSummary: false,
    applied: false,
  });
  expect(() => s.beforeRequest("conversation text", 100)).toThrow();
  expect(() =>
    s.afterRequest("second-post", { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 }),
  ).toThrow();
});

it.skipIf(!existsSync("D:/pi/packages/coding-agent/src/core/sdk.ts"))(
  "exercises the real Pi event sequence with zero HTTP and no secret persistence",
  () => {
    const out = join(mkdtempSync(join(tmpdir(), "foldpoint-retained-shadow-")), "capture");
    const sentinel = "private-test-key-do-not-store";
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "tools/pi-feedback-capture.mjs",
        "--pi",
        "D:/pi",
        "--out",
        out,
        "--retained-shadow",
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          DEEPSEEK_API_KEY: sentinel,
        },
      },
    );
    const text = readFileSync(join(out, "report.json"), "utf8"),
      r = JSON.parse(text);
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("Owner instructions:");
    expect(r.completed).toBe(true);
    expect(r.usage.httpCalls).toBe(0);
    expect(r.usage.networkAttempts).toBe(0);
    expect(r.retainedShadow).toMatchObject({
      samples: 1,
      pendingRequests: 0,
      pendingSummary: false,
      applied: false,
      timingControlExercised: false,
    });
    const es = r.retainedShadow.events as Array<Record<string, unknown>>;
    expect(es.filter((e) => e.type === "request_prediction")).toHaveLength(4);
    expect(es.filter((e) => e.type === "request_usage")).toHaveLength(4);
    for (const e of es.filter((e) => e.predictionSeq !== undefined))
      expect(Number(e.seq)).toBeGreaterThan(Number(e.predictionSeq));
    expect(es.find((e) => e.type === "summary_prediction")?.priorSamples).toBe(0);
    expect(
      es.find((e) => e.type === "request_prediction" && e.stage === "first-post")?.priorSamples,
    ).toBe(1);
  },
  40000,
);
