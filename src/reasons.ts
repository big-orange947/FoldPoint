import type { FoldPointReason } from "./types";

/** Every reason code FoldPoint can emit, in documentation order. */
export const ALL_REASONS: readonly FoldPointReason[] = Object.freeze([
  "HARD_WINDOW_RATIO",
  "PROJECTED_WINDOW_GROWTH",
  "RESERVE_TOKENS_REACHED",
  "COMPACTOR_INPUT_LIMIT",
  "COMPACTION_DISABLED",
  "UNSAFE_BOUNDARY",
  "COOLDOWN_ACTIVE",
  "INSUFFICIENT_RECLAIM_TOKENS",
  "INSUFFICIENT_RECLAIM_RATIO",
  "BELOW_SOFT_WINDOW",
  "CACHE_STILL_VALUABLE",
  "CACHE_LIKELY_EXPIRED",
  "NO_POSITIVE_SAVING",
  "NO_BREAK_EVEN",
  "BREAK_EVEN_BEYOND_HORIZON",
  "LOW_CONFIDENCE",
  "ECONOMIC_TRIGGER",
  "BREAK_EVEN_WITHIN_HORIZON",
  "DEFERRED_COMPACTION_COSTLIER",
  "DEFAULT_KEEP",
]);

/**
 * Stable one-line descriptions, for host logs and dashboards.
 * Hosts should key on the code, never on this text.
 */
export const REASON_DESCRIPTIONS: Readonly<Record<FoldPointReason, string>> = Object.freeze({
  HARD_WINDOW_RATIO: "Context utilization reached the hard window ratio.",
  PROJECTED_WINDOW_GROWTH:
    "Recent prompt growth predicts that the next request could cross the force boundary.",
  RESERVE_TOKENS_REACHED: "Remaining window dropped to the configured reserve.",
  COMPACTOR_INPUT_LIMIT: "The host-declared safe compactor input budget was reached.",
  COMPACTION_DISABLED: "The host disabled economic compaction for this step.",
  UNSAFE_BOUNDARY: "The host is not at a step boundary where compaction may run.",
  COOLDOWN_ACTIVE: "Too few model calls have passed since the last compaction attempt.",
  INSUFFICIENT_RECLAIM_TOKENS: "Estimated reclaim is below the minimum reclaim token floor.",
  INSUFFICIENT_RECLAIM_RATIO: "Estimated reclaim is below the minimum reclaim ratio.",
  BELOW_SOFT_WINDOW: "Context utilization has not reached the economic decision band yet.",
  CACHE_STILL_VALUABLE:
    "The candidate cached prefix is probably still usable, so keeping the context is cheap.",
  CACHE_LIKELY_EXPIRED:
    "The candidate cached prefix is probably gone, so replaying the context costs full input price.",
  NO_POSITIVE_SAVING: "Adjusted net saving did not clear the configured minimum.",
  NO_BREAK_EVEN: "There is no positive per-call saving, so compaction can never repay itself.",
  BREAK_EVEN_BEYOND_HORIZON: "Break-even needs more future calls than the horizon provides.",
  LOW_CONFIDENCE: "The estimate is not backed by enough observed samples.",
  ECONOMIC_TRIGGER:
    "Adjusted net saving is positive against the applicable keep-or-defer alternative.",
  BREAK_EVEN_WITHIN_HORIZON: "Break-even calls fit inside the expected future calls.",
  DEFERRED_COMPACTION_COSTLIER:
    "Waiting for the later mandatory compaction is estimated to cost more than compacting now.",
  DEFAULT_KEEP: "No rule applied; the conservative default is to keep the context.",
  ECONOMIC_ESTIMATE_FRAGILE:
    "Economic saving disappears under a shorter runtime and higher retained context.",
  ECONOMIC_MARGIN_TOO_SMALL: "Adjusted saving does not cover the price-scaled economic margin.",
  RUNTIME_IDLE:
    "The current agent runtime has ended; do not finance compaction with unknown future commands.",
});
