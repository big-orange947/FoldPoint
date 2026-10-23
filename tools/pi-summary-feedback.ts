/** Numeric-only observation of Pi's immediate HOST estimate; never provider token truth. */
import { type CompactorTokenModel, predictCompactorTokens } from "../src/experimental-compactor";
import { costOfUsage, type UnitPrices } from "../src/pricing";

export interface ImmediateSummaryFeedback {
  v: 1;
  source: "pi-compaction-result-estimatedTokensAfter";
  sequence: number;
  stage: number;
  binding: string;
  compactorBinding: string;
  beforeTokens: number;
  afterTokens: number;
  estimatedOnly: true;
  canDrivePolicy: false;
  usage: {
    promptTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  } | null;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const tokens = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Pass only a successful, non-aborted compaction_end result, not a message or entry. */
export function extractImmediateSummary(
  result: unknown,
  context: {
    sequence: number;
    stage: number;
    binding: string;
    compactorBinding: string;
  },
): ImmediateSummaryFeedback | undefined {
  if (
    !tokens(context.sequence) ||
    context.sequence === 0 ||
    !tokens(context.stage) ||
    context.stage === 0
  )
    throw new RangeError("invalid feedback order");
  if (![context.binding, context.compactorBinding].every((v) => /^[a-f0-9]{64}$/i.test(v)))
    throw new RangeError("invalid feedback binding");
  const r = record(result);
  if (!r || !tokens(r.tokensBefore) || r.tokensBefore === 0 || !tokens(r.estimatedTokensAfter))
    return undefined;
  const u = record(r.usage);
  let usage: ImmediateSummaryFeedback["usage"] = null;
  if (u && tokens(u.input) && tokens(u.cacheRead) && tokens(u.cacheWrite) && tokens(u.output)) {
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    if (Number.isSafeInteger(prompt))
      usage = {
        promptTokens: prompt,
        cachedInputTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
        outputTokens: u.output,
      };
  }
  return {
    v: 1,
    source: "pi-compaction-result-estimatedTokensAfter",
    sequence: context.sequence,
    stage: context.stage,
    binding: context.binding,
    compactorBinding: context.compactorBinding,
    beforeTokens: r.tokensBefore,
    afterTokens: r.estimatedTokensAfter,
    estimatedOnly: true,
    canDrivePolicy: false,
    usage,
  };
}

/** Compare a model frozen BEFORE the stage, conditioned on input size known at compaction.
 * This does not learn from this sample, change decisions, or assert provider-size accuracy.
 */
export function scoreImmediateSummary(
  sample: ImmediateSummaryFeedback,
  model: CompactorTokenModel | undefined,
  prices: UnitPrices,
  basis:
    | "pre-stage-model-conditioned-on-compaction-input"
    | "recorded-pre-compaction-decision-model" = "pre-stage-model-conditioned-on-compaction-input",
) {
  if (!model) return null;
  const p = predictCompactorTokens(model, sample.beforeTokens);
  const predictedInput = sample.beforeTokens * model.summaryInputCostPerToken;
  if (![p.afterTokens, p.outputTokens, predictedInput].every((v) => Number.isFinite(v) && v >= 0))
    throw new RangeError("invalid forecast");
  const actualInput = sample.usage
    ? costOfUsage(prices, { ...sample.usage, outputTokens: 0 })
    : null;
  const predictedCost = predictedInput + p.outputTokens * prices.outputPerToken;
  const actualCost = sample.usage ? costOfUsage(prices, sample.usage) : null;
  return {
    basis,
    comparedWithHostEstimate: true,
    predictedAfterTokens: p.afterTokens,
    afterErrorTokens: p.afterTokens - sample.afterTokens,
    afterRelativeError:
      sample.afterTokens === 0 ? null : (p.afterTokens - sample.afterTokens) / sample.afterTokens,
    predictedOutputTokens: p.outputTokens,
    predictedInputCost: predictedInput,
    actualInputCost: actualInput,
    predictedSummaryCost: predictedCost,
    actualSummaryCost: actualCost,
    summaryCostError: actualCost === null ? null : predictedCost - actualCost,
    policyConsumed: false,
  };
}
