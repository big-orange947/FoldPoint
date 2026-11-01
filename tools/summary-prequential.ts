/** One-step-ahead diagnostics only: every prediction precedes observing that sample. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costOfUsage, parseTraceJsonl, resolveUnitPrices, type UnitPrices } from "../src/index";
import { matchSummaryFeedback } from "./match-summary-feedback";
import { SummaryInputCostLearner } from "./summary-input-cost";

type Sample = ReturnType<typeof matchSummaryFeedback>[number];
const error = (predicted: number, actual: number) =>
  actual > 0 ? (predicted - actual) / actual : null;
const meanAbsolute = (xs: Array<number | null>) => {
  const valid = xs.filter((v): v is number => v !== null);
  return valid.length ? valid.reduce((sum, v) => sum + Math.abs(v), 0) / valid.length : null;
};

export function auditSummaryForecast(samples: readonly Sample[], prices: UnitPrices) {
  const learner = new SummaryInputCostLearner("trace-bound");
  const outputs: number[] = [];
  let previousAfter: number | undefined;
  const rows = samples.map((s) => {
    const usage = s.usage as {
      promptTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
    };
    const actualCost = costOfUsage(prices, usage);
    const snapshot = learner.snapshot("trace-bound");
    const predictedCost =
      snapshot.effectiveInputCostPerBeforeToken === null || !outputs.length
        ? null
        : s.beforeTokens * snapshot.effectiveInputCostPerBeforeToken +
          (outputs.reduce((a, b) => a + b, 0) / outputs.length) * prices.outputPerToken;
    const row = {
      sequence: s.sequence,
      priorSamples: snapshot.samples,
      beforeTokens: s.beforeTokens,
      actualAfterTokens: s.immediateAfterHostEstimate,
      tenPercentRelativeError: error(s.beforeTokens * 0.1, s.immediateAfterHostEstimate),
      previousAfterRelativeError:
        previousAfter === undefined ? null : error(previousAfter, s.immediateAfterHostEstimate),
      actualSummaryCost: actualCost,
      predictedSummaryCost: predictedCost,
      costRelativeError: predictedCost === null ? null : error(predictedCost, actualCost),
    };
    if (
      !learner.observe({
        binding: "trace-bound",
        sequence: s.sequence,
        success: true,
        beforeTokens: s.beforeTokens,
        usage,
        prices,
      })
    )
      throw new Error("invalid or unordered sample");
    outputs.push(usage.outputTokens);
    if (outputs.length > 8) outputs.shift();
    previousAfter = s.immediateAfterHostEstimate;
    return row;
  });
  return {
    samples: rows.length,
    coldCostPredictions: rows.filter((r) => r.predictedSummaryCost === null).length,
    scoredCostPredictions: rows.filter((r) => r.costRelativeError !== null).length,
    tenPercentMeanAbsoluteRelativeError: meanAbsolute(rows.map((r) => r.tenPercentRelativeError)),
    previousAfterMeanAbsoluteRelativeError: meanAbsolute(
      rows.map((r) => r.previousAfterRelativeError),
    ),
    summaryCostMeanAbsoluteRelativeError: meanAbsolute(rows.map((r) => r.costRelativeError)),
    rows,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error("Usage: summary-prequential <trace> <feedback> <reference>");
  const [trace, feedback, reference] = process.argv.slice(2).map((p) => readFileSync(p));
  if (!trace || !feedback || !reference) throw new Error("missing inputs");
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const decode = (b: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(b);
  const ref = JSON.parse(decode(reference));
  if (ref.rawSha256?.trace !== hash(trace) || ref.rawSha256?.feedback !== hash(feedback))
    throw new Error("reference fingerprint mismatch");
  const parsed = parseTraceJsonl(decode(trace));
  const feedbackText = decode(feedback);
  if (parsed.errors.length || !feedbackText.endsWith("\n")) throw new Error("invalid input");
  const rows = matchSummaryFeedback(
    parsed.events,
    feedbackText
      .slice(0, -1)
      .split("\n")
      .map((l) => JSON.parse(l)),
  );
  const profile = parsed.events.find((e) => e.type === "decision")?.profile;
  if (!profile?.pricing) throw new Error("missing pricing");
  process.stdout.write(
    `${JSON.stringify({ traceSha256: hash(trace), feedbackSha256: hash(feedback), ...auditSummaryForecast(rows, resolveUnitPrices(profile.pricing)), hostEstimateOnly: true, counterfactual: false, paidCalls: 0 }, null, 2)}\n`,
  );
}
