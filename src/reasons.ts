import type { FoldPointReason } from "./types";

/** Every reason code FoldPoint can emit, in documentation order. */
export const ALL_REASONS: readonly FoldPointReason[] = Object.freeze([
  "HARD_WINDOW_RATIO",
  "RESERVE_TOKENS_REACHED",
  "COMPACTION_DISABLED",
  "UNSAFE_BOUNDARY",
  "COOLDOWN_ACTIVE",
  "INSUFFICIENT_RECLAIM_TOKENS",
  "INSUFFICIENT_RECLAIM_RATIO",
  "CACHE_STILL_VALUABLE",
  "CACHE_LIKELY_EXPIRED",
  "NO_POSITIVE_SAVING",
  "NO_BREAK_EVEN",
  "BREAK_EVEN_BEYOND_HORIZON",
  "LOW_CONFIDENCE",
  "ECONOMIC_TRIGGER",
  "BREAK_EVEN_WITHIN_HORIZON",
  "DEFAULT_KEEP",
]);

/**
 * Stable one-line descriptions, for host logs and dashboards.
 * Hosts should key on the code, never on this text.
 */
export const REASON_DESCRIPTIONS: Readonly<Record<FoldPointReason, string>> = Object.freeze({
  HARD_WINDOW_RATIO: "Context utilization reached the hard window ratio.",
  RESERVE_TOKENS_REACHED: "Remaining window dropped to the configured reserve.",
  COMPACTION_DISABLED: "The host disabled economic compaction for this step.",
  UNSAFE_BOUNDARY: "The host is not at a step boundary where compaction may run.",
  COOLDOWN_ACTIVE: "Too few model calls have passed since the last compaction.",
  INSUFFICIENT_RECLAIM_TOKENS: "Estimated reclaim is below the minimum reclaim token floor.",
  INSUFFICIENT_RECLAIM_RATIO: "Estimated reclaim is below the minimum reclaim ratio.",
  CACHE_STILL_VALUABLE: "The cached prefix is probably alive, so keeping the context is cheap.",
  CACHE_LIKELY_EXPIRED:
    "The cached prefix is probably gone, so replaying the context is expensive.",
  NO_POSITIVE_SAVING: "Adjusted net saving did not clear the configured minimum.",
  NO_BREAK_EVEN: "There is no positive per-call saving, so compaction can never repay itself.",
  BREAK_EVEN_BEYOND_HORIZON: "Break-even needs more future calls than the horizon provides.",
  LOW_CONFIDENCE: "The estimate is not backed by enough observed samples.",
  ECONOMIC_TRIGGER: "Adjusted net saving is positive and break-even fits inside the horizon.",
  BREAK_EVEN_WITHIN_HORIZON: "Break-even calls fit inside the expected future calls.",
  DEFAULT_KEEP: "No rule applied; the conservative default is to keep the context.",
});
