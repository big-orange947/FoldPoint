import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { costOfUsage, resolveUnitPrices } from "../src/pricing";
import { publishCheckpoint, renderCheckpoint } from "../tools/pi-checkpoint-report";
import { PiRetainedShadow } from "../tools/pi-retained-shadow";

function fixture() {
  const prices = resolveUnitPrices({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
    }),
    shadow = new PiRetainedShadow(prices);
  shadow.beforeSummary(609860);
  const ledger = ["summary", "first-post", "second-post"].map((stage) => ({
    stage,
    promptHostEstimate: 1000,
    httpAttempts: 1,
    stopReason: "stop",
    usage: { input: 900, output: 10, cacheRead: 0, cacheWrite: 0 },
    cost: costOfUsage(prices, {
      promptTokens: 900,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    }),
  }));
  for (const row of ledger) {
    shadow.beforeRequest(row.stage, row.promptHostEstimate);
    shadow.afterRequest(row.stage, row.usage);
    if (row.stage === "summary") shadow.afterSummary(609860, 24000);
  }
  return {
    mode: "live",
    completed: true,
    archiveUnchanged: true,
    unknownHttpCalls: 0,
    httpCalls: 3,
    archiveSha256: "a".repeat(64),
    producerSha256: "b".repeat(64),
    helperSha256: "c".repeat(64),
    declaredWindowTokens: 1000000,
    preparedBefore: 609860,
    historicalBefore: 609860,
    prices,
    totalCost: ledger.reduce((s, r) => s + r.cost, 0),
    compaction: { beforeHostTokens: 609860, immediateAfterHostEstimate: 24000 },
    ledger,
    shadow: shadow.report(),
    privateBody: "private-content-never-export",
  };
}
it("publishes only checked numeric results and rejects incomplete billing or provenance", () => {
  const f = fixture(),
    r = publishCheckpoint(f);
  expect(r.recordedPaidHttpCalls).toBe(3);
  expect(JSON.stringify(r)).not.toContain(f.privateBody);
  expect(() => publishCheckpoint({ ...f, archiveUnchanged: false })).toThrow();
  expect(() => publishCheckpoint({ ...f, unknownHttpCalls: 1 })).toThrow();
  expect(() => publishCheckpoint({ ...f, totalCost: NaN })).toThrow();
  expect(() => publishCheckpoint({ ...f, preparedBefore: 600000 })).toThrow();
  const bad = fixture();
  const row = bad.ledger[0];
  if (!row) throw new Error("missing fixture");
  row.usage.input++;
  expect(() => publishCheckpoint(bad)).toThrow();
});
it("keeps the recorded target-size bill and report synchronized", () => {
  const r = JSON.parse(
    readFileSync("benchmarks/reports/pi-checkpoint-retained-live.json", "utf8"),
  ) as ReturnType<typeof publishCheckpoint>;
  expect(r.recordedPaidHttpCalls).toBe(3);
  expect(r.preparedBeforeHostTokens).toBe(609860);
  expect(r.calls.find((c) => c.stage === "summary")?.promptTokens).toBe(593612);
  expect(r.actualAfterHostEstimate).toBe(23180);
  expect(r.totalCost).toBeCloseTo(0.18412518, 12);
  expect(r.totalCost).toBeCloseTo(
    r.calls.reduce((s, c) => s + c.cost, 0),
    12,
  );
  expect(r.policyChanged).toBe(false);
  expect(r.qualityMeasured).toBe(false);
  expect(
    readFileSync("benchmarks/pi-checkpoint-retained-live.md", "utf8").replace(/\r\n/g, "\n"),
  ).toBe(renderCheckpoint(r));
});
