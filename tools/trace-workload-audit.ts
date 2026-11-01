/** Descriptive trace diagnostics. No alternative policy or counterfactual is simulated. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceJsonl, type TraceEvent, type TraceRequestEvent } from "../src/index";

const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null);
  return { count: sorted.length, p10: at(0.1), median: at(0.5), p90: at(0.9) };
};

/** Only within-session successive observations without an intervening successful compaction. */
export function auditTraceWorkload(events: readonly TraceEvent[]) {
  const decisions = new Map<string, number>();
  const seen = new Set<string>();
  const previous = new Map<string, { context: number; timestamp: number; cacheRatio?: number }>();
  const growth: number[] = [],
    gaps: number[] = [],
    ratios: number[] = [],
    cacheDelta: number[] = [];
  const before: number[] = [],
    after: number[] = [];
  let requests = 0,
    unknownCache = 0,
    unpaired = 0,
    duplicates = 0,
    resets = 0;
  let successfulSummaries = 0,
    missingAfter = 0,
    unpricedSummaries = 0,
    failedSummaries = 0;
  const key = (session: string, call: string) => JSON.stringify([session, call]);
  for (const event of events) {
    if (event.type === "decision") {
      const id = key(event.sessionId, event.callId);
      if (seen.has(id) || decisions.has(id)) {
        duplicates++;
        decisions.delete(id);
        seen.add(id);
        continue;
      }
      decisions.set(id, event.input.contextTokens);
    } else if (event.type === "compaction") {
      if (event.success) {
        successfulSummaries++;
        resets++;
        previous.delete(event.sessionId);
        before.push(event.beforeTokens);
        if (event.afterTokens === null) missingAfter++;
        else after.push(event.afterTokens);
        if (
          event.usage?.actualCost === undefined &&
          (event.usage?.promptTokens === undefined ||
            event.usage?.outputTokens === undefined ||
            event.usage?.cachedInputTokens === undefined ||
            event.usage?.cacheWriteTokens === undefined)
        )
          unpricedSummaries++;
      } else if (event.errorCode !== "vetoed") failedSummaries++;
    } else if (event.type === "request") {
      requests++;
      const id = key(event.sessionId, event.callId);
      if (seen.has(id)) {
        duplicates++;
        previous.delete(event.sessionId);
        continue;
      }
      seen.add(id);
      const context = decisions.get(id);
      decisions.delete(id);
      const ratio = cacheReadRatio(event);
      if (ratio === undefined) unknownCache++;
      else ratios.push(ratio);
      if (context === undefined || event.outcome !== "ok") {
        unpaired++;
        previous.delete(event.sessionId);
        continue;
      }
      const prior = previous.get(event.sessionId);
      if (prior) {
        growth.push(context - prior.context);
        if (event.timestamp >= prior.timestamp) gaps.push(event.timestamp - prior.timestamp);
        if (ratio !== undefined && prior.cacheRatio !== undefined)
          cacheDelta.push(Math.abs(ratio - prior.cacheRatio));
      }
      previous.set(event.sessionId, { context, timestamp: event.timestamp, cacheRatio: ratio });
    } else if (event.type === "session_end") previous.delete(event.sessionId);
  }
  return {
    requests,
    unpairedOrFailedRequests: unpaired,
    unmatchedDecisions: decisions.size,
    duplicateIds: duplicates,
    successfulSummaries,
    failedSummaries,
    missingAfter,
    unpricedSummaries,
    compactionResets: resets,
    contextGrowthPerObservedCall: summarize(growth),
    negativeGrowth: growth.filter((n) => n < 0).length,
    callGapMs: summarize(gaps),
    cacheReadRatio: summarize(ratios),
    unknownCache,
    absoluteCacheRatioChange: summarize(cacheDelta),
    summaryBefore: summarize(before),
    summaryAfter: summarize(after),
    limitations: [
      "observational-within-recorded-policy",
      "no-counterfactual",
      "host-context-not-provider-tokens",
      "call-gaps-not-provider-cache-ttl",
      "after-may-be-delayed",
    ],
  };
}

function cacheReadRatio(event: TraceRequestEvent) {
  const { promptTokens, cachedInputTokens, cacheWriteTokens } = event.usage;
  if (
    promptTokens === undefined ||
    promptTokens <= 0 ||
    cachedInputTokens === undefined ||
    cacheWriteTokens === undefined ||
    cachedInputTokens + cacheWriteTokens > promptTokens
  )
    return undefined;
  return cachedInputTokens / promptTokens;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: trace-workload-audit <trace.jsonl>");
  const bytes = readFileSync(process.argv[2] as string);
  const parsed = parseTraceJsonl(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (parsed.errors.length) throw new Error("Invalid trace: refusing partial analysis");
  process.stdout.write(
    `${JSON.stringify({ traceSha256: createHash("sha256").update(bytes).digest("hex"), ...auditTraceWorkload(parsed.events) }, null, 2)}\n`,
  );
}
