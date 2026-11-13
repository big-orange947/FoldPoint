import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { costOfUsage, resolveUnitPrices } from "../src/pricing";
import { publishRetainedCapture, renderRetainedReport } from "../tools/pi-retained-report";
import { PiRetainedShadow } from "../tools/pi-retained-shadow";

function fixture() {
  const prices = resolveUnitPrices({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
    }),
    shadow = new PiRetainedShadow(prices);
  const ledger = ["pre-compaction", "summary", "first-post", "second-post"].map((stage) => ({
    stage,
    usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
  }));
  for (const row of ledger) {
    if (row.stage === "summary") shadow.beforeSummary(1000);
    shadow.beforeRequest(row.stage, 110);
    shadow.afterRequest(row.stage, row.usage);
    if (row.stage === "summary") shadow.afterSummary(1000, 150);
  }
  return {
    completed: true,
    mode: "live",
    sourceSha256: "a".repeat(64),
    piCommit: "b".repeat(40),
    model: { provider: "deepseek", id: "deepseek-flash", contextWindow: 1000000 },
    checks: { fourCompletedCalls: true, oneNativeCompaction: true, noHiddenHttp: true },
    usage: { httpCalls: 4, unaccountedHttpAttempts: 0, reportedTokens: 404 },
    ledger,
    retainedShadow: shadow.report(),
    analysis: {
      sessionCosts: [
        {
          totalCost:
            4 *
            costOfUsage(prices, {
              promptTokens: 100,
              outputTokens: 1,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
            }),
        },
      ],
    },
    privateText: "secret-body-must-not-persist",
  };
}

it("publishes only metadata and rejects incomplete, reordered or mismatched billing", () => {
  const f = fixture(),
    r = publishRetainedCapture(f);
  expect(r.httpCalls).toBe(4);
  expect(JSON.stringify(r)).not.toContain(f.privateText);
  expect(() => publishRetainedCapture({ ...f, completed: false })).toThrow();
  expect(() => publishRetainedCapture({ ...f, analysis: { sessionCosts: [] } })).toThrow();
  const future = fixture();
  const prediction = future.retainedShadow.events[0];
  if (!prediction) throw new Error("missing fixture prediction");
  prediction.seq = 100;
  expect(() => publishRetainedCapture(future)).toThrow();
  const mismatch = fixture();
  const first = mismatch.ledger[0];
  if (!first) throw new Error("missing fixture request");
  first.usage.input++;
  expect(() => publishRetainedCapture(mismatch)).toThrow();
});

it("keeps the public live report, total costs and documentation synchronized", () => {
  const r = JSON.parse(readFileSync("benchmarks/reports/pi-retained-shadow-live.json", "utf8")) as {
    runs: ReturnType<typeof publishRetainedCapture>[];
  };
  expect(r.runs).toHaveLength(2);
  expect(r.runs.reduce((s, x) => s + x.httpCalls, 0)).toBe(8);
  expect(r.runs.reduce((s, x) => s + x.totalCost, 0)).toBeCloseTo(0.004818456, 12);
  for (const x of r.runs) {
    expect(x.totalCost).toBeCloseTo(
      x.calls.reduce((s, c) => s + c.totalCost, 0),
      12,
    );
    expect(x.timingControlExercised).toBe(false);
    expect(x.maxActualPromptTokens).toBeLessThan(10000);
  }
  expect(
    r.runs[1]?.calls.find((x) => x.stage === "first-post")?.hypotheticalAfterHostTokens,
  ).not.toBeNull();
  expect(readFileSync("benchmarks/pi-retained-shadow-live.md", "utf8").replace(/\r\n/g, "\n")).toBe(
    renderRetainedReport(r),
  );
});
