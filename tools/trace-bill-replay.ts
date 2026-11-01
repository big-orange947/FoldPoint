/** Replay recorded provider usage as a bill; does not simulate a different policy. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costOfUsage, parseTraceJsonl, resolveUnitPrices, type TraceEvent } from "../src/index";
import { summaryHistoryBinding } from "./pi-steady-history";

const int = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const usageFields = [
  "promptTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
] as const;

export function replayRecordedBill(events: readonly TraceEvent[]) {
  const profiles = events.filter((e) => e.type === "decision");
  const first = profiles[0];
  if (first?.profile.pricing?.currency !== "USD") throw new Error("missing USD prices");
  const binding = summaryHistoryBinding(first.profile);
  if (
    profiles.some(
      (e) => e.sessionId !== first.sessionId || summaryHistoryBinding(e.profile) !== binding,
    )
  )
    throw new Error("multiple sessions or prices");
  const prices = resolveUnitPrices(first.profile.pricing);
  const seen = new Set<string>();
  let ordinaryCost = 0,
    summaryCost = 0,
    warmCost = 0,
    ordinaryCalls = 0,
    summaries = 0,
    prewarms = 0;
  const checkedUsage = (usage: {
    promptTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
  }) => {
    if (!usageFields.every((field) => int(usage[field]))) throw new Error("incomplete usage");
    const { promptTokens, cachedInputTokens, cacheWriteTokens, outputTokens } = usage as Required<
      typeof usage
    >;
    if (cachedInputTokens + cacheWriteTokens > promptTokens) throw new Error("invalid cache usage");
    return costOfUsage(prices, { promptTokens, cachedInputTokens, cacheWriteTokens, outputTokens });
  };
  for (const event of events) {
    if (event.type === "request") {
      if (event.sessionId !== first.sessionId || seen.has(event.callId))
        throw new Error("ambiguous request");
      if (event.outcome !== "ok") throw new Error("unknown or failed request billing");
      seen.add(event.callId);
      ordinaryCost += checkedUsage(event.usage);
      ordinaryCalls++;
    } else if (event.type === "compaction") {
      if (event.sessionId !== first.sessionId) throw new Error("multiple sessions");
      if (!event.success && event.errorCode === "vetoed") continue;
      if (!event.success || !event.usage) throw new Error("unknown failed summary billing");
      if (event.usage.actualCost !== undefined) {
        if (!Number.isFinite(event.usage.actualCost) || event.usage.actualCost < 0)
          throw new Error("invalid summary cost");
        summaryCost += event.usage.actualCost;
      } else summaryCost += checkedUsage(event.usage);
      summaries++;
    } else if (event.type === "cache_warm") {
      if (
        event.sessionId !== first.sessionId ||
        !Number.isFinite(event.usage.actualCost) ||
        event.usage.actualCost < 0
      )
        throw new Error("unknown warm billing");
      warmCost += event.usage.actualCost;
      prewarms++;
    }
  }
  if (!events.some((e) => e.type === "session_end" && e.sessionId === first.sessionId))
    throw new Error("incomplete session");
  return {
    ordinaryCalls,
    summaries,
    prewarms,
    ordinaryCost,
    summaryCost,
    warmCost,
    totalCost: ordinaryCost + summaryCost + warmCost,
    currency: "USD",
    counterfactual: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: trace-bill-replay <trace>");
  const bytes = readFileSync(process.argv[2] as string);
  const parsed = parseTraceJsonl(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (parsed.errors.length) throw new Error("invalid trace");
  process.stdout.write(
    `${JSON.stringify({ traceSha256: createHash("sha256").update(bytes).digest("hex"), ...replayRecordedBill(parsed.events), paidCalls: 0 }, null, 2)}\n`,
  );
}
