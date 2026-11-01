/** Match separately recorded immediate feedback to trace summaries; never fabricate missing data. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceJsonl, type TraceCompactionEvent, type TraceEvent } from "../src/index";
import { summaryHistoryBinding } from "./pi-steady-history";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const integer = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);

export function matchSummaryFeedback(events: readonly TraceEvent[], feedback: readonly unknown[]) {
  const decisions = events.filter((e) => e.type === "decision");
  const summaries = events.filter(
    (e): e is TraceCompactionEvent => e.type === "compaction" && e.success,
  );
  const firstDecision = decisions[0];
  if (!firstDecision || !summaries.length || summaries.length !== feedback.length)
    throw new Error("incomplete inputs");
  if (
    new Set(decisions.map((d) => d.sessionId)).size !== 1 ||
    summaries.some((s) => s.sessionId !== firstDecision.sessionId)
  )
    throw new Error("ambiguous session");
  const profileBinding = sha(summaryHistoryBinding(firstDecision.profile));
  if (decisions.some((d) => sha(summaryHistoryBinding(d.profile)) !== profileBinding))
    throw new Error("profile changed");
  const signatures = new Set<string>();
  let previousStage = 0,
    compactorBinding = "";
  return summaries.map((summary, i) => {
    const sample = feedback[i];
    if (!object(sample) || !object(sample.usage) || !summary.usage)
      throw new Error("missing sample usage");
    const usage = sample.usage;
    if (
      sample.v !== 1 ||
      sample.source !== "pi-compaction-result-estimatedTokensAfter" ||
      sample.estimatedOnly !== true ||
      sample.canDrivePolicy !== false ||
      sample.sequence !== i + 1 ||
      !integer(sample.stage) ||
      sample.stage <= previousStage ||
      !integer(sample.afterTokens) ||
      sample.binding !== profileBinding ||
      typeof sample.compactorBinding !== "string" ||
      !/^[a-f0-9]{64}$/.test(sample.compactorBinding)
    )
      throw new Error("invalid feedback");
    if (compactorBinding && compactorBinding !== sample.compactorBinding)
      throw new Error("compactor changed");
    compactorBinding = sample.compactorBinding;
    previousStage = sample.stage;
    const fields = [
      "promptTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "outputTokens",
    ] as const;
    if (
      sample.beforeTokens !== summary.beforeTokens ||
      fields.some((field) => !integer(usage[field]) || usage[field] !== summary.usage?.[field])
    )
      throw new Error("summary mismatch");
    if (
      (usage.cachedInputTokens as number) + (usage.cacheWriteTokens as number) >
      (usage.promptTokens as number)
    )
      throw new Error("invalid usage partition");
    const signature = JSON.stringify([
      summary.beforeTokens,
      ...fields.map((field) => usage[field]),
    ]);
    if (signatures.has(signature)) throw new Error("ambiguous duplicate summary");
    signatures.add(signature);
    return {
      sequence: i + 1,
      stage: sample.stage,
      beforeTokens: summary.beforeTokens,
      immediateAfterHostEstimate: sample.afterTokens,
      usage: Object.fromEntries(fields.map((field) => [field, usage[field]])),
    };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error("Usage: match-summary-feedback <trace> <feedback> <reference-report>");
  const [traceBytes, feedbackBytes, referenceBytes] = process.argv
    .slice(2)
    .map((path) => readFileSync(path));
  if (!traceBytes || !feedbackBytes || !referenceBytes) throw new Error("missing inputs");
  const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const reference = JSON.parse(decode(referenceBytes));
  if (
    reference.rawSha256?.trace !== sha(traceBytes) ||
    reference.rawSha256?.feedback !== sha(feedbackBytes)
  )
    throw new Error("reference fingerprint mismatch");
  const parsed = parseTraceJsonl(decode(traceBytes));
  if (parsed.errors.length) throw new Error("invalid trace");
  const feedbackText = decode(feedbackBytes);
  if (!feedbackText.endsWith("\n")) throw new Error("incomplete feedback");
  const rows = matchSummaryFeedback(
    parsed.events,
    feedbackText
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  process.stdout.write(
    `${JSON.stringify({ traceSha256: sha(traceBytes), feedbackSha256: sha(feedbackBytes), samples: rows, hostEstimateOnly: true, counterfactual: false, paidCalls: 0 }, null, 2)}\n`,
  );
}
