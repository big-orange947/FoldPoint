# FoldPoint algorithm

This document is the reference for what `decide()` actually computes. The implementation is
[`src/estimator.ts`](../src/estimator.ts); every formula below appears there in the same
order.

- [1. Inputs](#1-inputs)
- [2. Notation](#2-notation)
- [3. Cache survival](#3-cache-survival)
- [4. Reclaim estimate](#4-reclaim-estimate)
- [5. Cost model](#5-cost-model)
- [6. Horizon](#6-horizon)
- [7. Break-even and net saving](#7-break-even-and-net-saving)
- [8. Confidence and the uncertainty penalty](#8-confidence-and-the-uncertainty-penalty)
- [9. Decision order](#9-decision-order)
- [10. Reason codes](#10-reason-codes)
- [11. nextCheckAtTokens](#11-nextcheckattokens)
- [12. Defaults](#12-defaults)
- [13. Online learning rules](#13-online-learning-rules)
- [14. Worked example](#14-worked-example)
- [15. Sensitivity](#15-sensitivity)

## 1. Inputs

`decide(input, state, options?)` reads:

| From `input` | Meaning |
| --- | --- |
| `profile.contextWindowTokens` | window size, `> 0` |
| `contextTokens` | tokens the next call would carry |
| `cachedTokens` | tokens known to sit in the cached prefix (≤ `contextTokens`) |
| `timestamp`, `idleMs` | now, and time since the last real request (derived from state when omitted) |
| `safeBoundary`, `compactionAllowed` | host permissions for *economic* compaction |
| `expectedFutureCalls` | host horizon, `>= 1` |
| `cacheExpiresAt` | exact provider cache expiry, when known |
| `profile.pricing` | price snapshot, or none for normalized token cost |
| `profile.cachePolicy` | `ttlMs`, `halfLifeMs`, `disabled` |

| From `state` | Meaning |
| --- | --- |
| `retentionRatioEma` (+ `retentionSamples`) | learned `after/before` |
| `compactOutputRatioEma` | learned compaction output / context |
| `compactionCostEma` (+ `compactionCostSamples`) | learned cost of one compaction call |
| `cacheHitRatioEma` (+ `cacheSamples`) | learned cached / prompt |
| `reuseHorizonEma` (+ `horizonSamples`) | learned calls remaining after a compaction |
| `growthPerCallEma` (+ `growthSamples`) | learned tokens added per call |
| `lastRequestAt`, `lastCacheExpiresAt` | timing metadata |
| `compactionCount`, `callsSinceLastCompaction` | cooldown metadata |

A learned value is used only when its sample counter is `> 0`; otherwise the cold-start
default applies. That rule is what makes a fresh profile behave exactly like the documented
defaults.

## 2. Notation

```
T   = contextTokens                     W  = contextWindowTokens
C   = min(cachedTokens, T)              U  = T - C
q   = estimatedCacheSurvival            r  = retention ratio (after/before)
Pin = input price per token             Pcache = cache-read price per token
Pwrite = cache-write price per token    Pout   = output price per token
R   = expectedFutureCalls
```

Per-token prices come from `PricingSnapshot` (`price / 1_000_000`). Missing snapshot →
normalized token cost, all prices `1`, `hasCacheDiscount = false`. Missing
`cacheReadPerMillion` → `Pcache = Pin` and no discount is assumed. Missing
`cacheWritePerMillion` → `Pwrite = Pin`.

## 3. Cache survival

`q` is the probability that the cached prefix is still alive, resolved in this order:

1. `hasCacheDiscount === false` or `cachePolicy.disabled === true` → `q = 0`.
2. Exact expiry known (`input.cacheExpiresAt`, else `state.lastCacheExpiresAt`):
   `q = base * (timestamp < cacheExpiresAt ? 1 : 0)`.
3. `cachePolicy.ttlMs` known: `q = base * (idleMs < ttlMs ? 1 : 0)`.
4. `cachePolicy.halfLifeMs` known: `q = base * 2^(-idleMs / halfLifeMs)`.
5. Otherwise: `q = base` (no decay knowledge).

where

```
base = cacheSamples > 0
         ? clamp(cacheHitRatioEma, 0, 1)
         : (T > 0 && C > 0 ? clamp(C / T, 0, 1) : 0)
```

`base` is the learned cache-hit ratio, or — with no history at all — the cache coverage the
host reports for the current context. With no history and no cached tokens, `q = 0`, which
cannot affect a decision because `C = 0` anyway.

`q` is a probability, never a claim about provider internals. FoldPoint does not probe,
hash or inspect prefixes.

## 4. Reclaim estimate

```
r                = clamp(learnedRetentionRatio, 0.05, 1)      (default 0.40)
Ta               = T * r                                      estimated post-compaction tokens
reclaimTokens    = T - Ta
reclaimRatio     = reclaimTokens / T                          (0 when T = 0)
```

The `[0.05, 1]` clamp is a numeric guard against a compactor that reports an absurd ratio,
not a scenario switch. A learned `r` of `1` means "this compactor reclaims nothing": the
minimum-reclaim gate then refuses economic compaction, and after such an event FoldPoint
becomes strictly more conservative.

## 5. Cost model

### 5.1 Replaying the current context (once)

```
currentReplayCost = U * Pin + C * (q * Pcache + (1 - q) * Pin)
```

The uncached part always costs the input price. The cached part costs the cache-read price
when the cache is alive and the input price when it is not.

### 5.2 Replaying the context after a compaction (once)

```
qNew                = clamp(min(base, q), 0, 1)        (0 when there is no cache discount)
laterReplayCost     = Ta * (qNew * Pcache + (1 - qNew) * Pin)
firstReplayCost     = Ta * Pwrite
```

The first replay after a compaction rebuilds the prefix, so it is charged at the cache-write
price (which defaults to the input price). Later replays may benefit from the cache again,
but the rebuilt prefix is never assumed to be *better* cached than the current one — hence
`qNew <= q`. This is an approximation: it does not model a cache state machine.

### 5.3 The compaction call itself

```
S              = T * compactOutputRatio                       (default 0.12)
coldStartCall  = T * Pin + S * Pout                           (compaction reads the context)
compactCallCost = compactionCostSamples > 0 && compactionCostEma >= 0
                    ? compactionCostEma
                    : coldStartCall
```

The cold-start form is deliberately conservative: it assumes the compaction call reads the
whole context at the normal input price and cannot use the cache. A learned cost is an
absolute, per-event cost in the snapshot's currency, so it reflects the context sizes that
were actually compacted — see [limitations](limitations.md#3-the-learned-compaction-cost-is-an-absolute-value).

## 6. Horizon

```
R = input.expectedFutureCalls            (host wins)
  ?? (horizonSamples > 0 ? reuseHorizonEma : DEFAULTS.expectedFutureCalls)
```

`R >= 1` is enforced (an explicit value below 1 throws). Two caps bound the horizon used by
the economic gate:

```
callsUntilRefill = growthPerCall > 0 ? reclaimTokens / growthPerCall : Infinity
softCap          = utilization < softWindowRatio ? softWindowBreakEvenCalls : R
effectiveHorizon = max(1, min(R, softCap, callsUntilRefill))
```

- **`callsUntilRefill`** — a compaction's benefit cannot outlive the tokens it reclaimed. If
  the context regrows by `growthPerCall` tokens per call, the reclaimed tokens are consumed
  after `reclaimTokens / growthPerCall` calls, and the situation repeats. Counting the saving
  over a longer horizon systematically overstates the benefit; this cap removes that
  optimism. It is learned from `promptTokens` deltas, so it costs nothing and reads no
  content.
- **`softCap`** — below the soft window the window is not scarce, so a compaction must repay
  itself quickly (`softWindowBreakEvenCalls`, default 3) instead of over the whole session.
  This is what prevents "compact a small context every few calls" churn while still allowing
  an overwhelming economic win below the soft window.

`estimatedKeepCost` and `estimatedCompactCost` are still computed over the full `R`, as the
cost-model definition of "keep for the rest of the session vs compact now"; only the gate
uses `effectiveHorizon`.

## 7. Break-even and net saving

```
estimatedKeepCost    = R * currentReplayCost
estimatedCompactCost = compactCallCost + firstReplayCost + max(R - 1, 0) * laterReplayCost
estimatedNetSaving   = estimatedKeepCost - estimatedCompactCost
savingPerFutureCall  = currentReplayCost - laterReplayCost

breakEvenCalls = savingPerFutureCall > 0
                   ? (compactCallCost + firstReplayCost) / savingPerFutureCall
                   : null
```

`breakEvenCalls = null` means "no positive per-call saving exists, so compaction can never
repay itself". A division that overflows is reported as `Number.MAX_SAFE_INTEGER`
(effectively unreachable) so metrics stay JSON-safe. `breakEvenCalls` is the most important
explanatory number FoldPoint produces: it converts the whole estimate into "how many future
calls must this pay off over?".

## 8. Confidence and the uncertainty penalty

`confidence` is an *evidence score*, not a probability of task quality:

```
f(n)       = n / (n + confidenceHalfSaturationSamples)         (half-saturation, default 2)
evidence   = 0.50 * f(retentionSamples) + 0.25 * f(cacheSamples) + 0.25 * f(horizonSamples)
confidence = clamp(confidenceFloor + (1 - confidenceFloor) * evidence, 0, 1)   (floor 0.35)
```

So: 0 samples → 0.35, 1 successful compaction → ≈0.53, 4 compactions + cache + horizon
history → ≈0.76, and it approaches 1 as evidence accumulates.

```
penalty   = uncertaintyPenalty * (utilization < softWindowRatio ? softWindowPenaltyMultiplier : 1)
adjustedNetSaving = estimatedNetSaving * confidence - penalty * compactCallCost
```

Properties this must (and does) satisfy:

- with zero samples, a compaction must be clearly profitable before it is chosen;
- more samples move the estimate towards the raw estimate;
- uncertainty only ever affects the economic `COMPACT`, never the window-safety `FORCE`;
- the formula is public, deterministic and has no hidden heuristic.

## 9. Decision order

Gates are evaluated in this order; the first match wins. All metrics are computed *before*
the gates, so every branch returns the same complete metrics block.

1. **Window guard → `FORCE`** if
   `utilization >= hardWindowRatio` **or** `remainingTokens <= reserveTokens`.
   Reasons: `HARD_WINDOW_RATIO` and/or `RESERVE_TOKENS_REACHED`. If the host has disabled
   compaction or is not at a safe boundary, `COMPACTION_DISABLED` / `UNSAFE_BOUNDARY` are
   added so the host knows it must compact at the nearest safe boundary. FoldPoint never
   runs the compactor itself.
2. **Host opt-out → `KEEP`** if `compactionAllowed === false` (`COMPACTION_DISABLED`).
3. **Safe boundary → `KEEP`** if `safeBoundary === false` (`UNSAFE_BOUNDARY`).
4. **Cooldown → `KEEP`** if a compaction happened before and
   `callsSinceLastCompaction < minCallsBetweenCompactions` (`COOLDOWN_ACTIVE`).
5. **Minimum reclaim → `KEEP`** if `reclaimTokens < minReclaimTokens` or
   `reclaimRatio < minReclaimRatio` (`INSUFFICIENT_RECLAIM_TOKENS` /
   `INSUFFICIENT_RECLAIM_RATIO`).
6. **Economics → `COMPACT`** if
   `adjustedNetSaving > minNetSaving` **and** `breakEvenCalls !== null` **and**
   `breakEvenCalls <= effectiveHorizon`.
   Reasons: `ECONOMIC_TRIGGER`, `BREAK_EVEN_WITHIN_HORIZON`, plus `CACHE_LIKELY_EXPIRED`
   when the profile has cache evidence and `q` is below `cacheValuableThreshold`.
7. **Otherwise → `KEEP`**, annotated with the diagnosis: `CACHE_STILL_VALUABLE` /
   `CACHE_LIKELY_EXPIRED`, `NO_BREAK_EVEN`, `BREAK_EVEN_BEYOND_HORIZON`,
   `NO_POSITIVE_SAVING`, `LOW_CONFIDENCE`, and `DEFAULT_KEEP` when nothing else applies.

`KEEP` also carries `nextCheckAtTokens`; `COMPACT` and `FORCE` do not, because the host
should act rather than re-check.

## 10. Reason codes

| Code | Emitted when |
| --- | --- |
| `HARD_WINDOW_RATIO` | utilization reached `hardWindowRatio` |
| `RESERVE_TOKENS_REACHED` | remaining window dropped to `reserveTokens` |
| `COMPACTION_DISABLED` | host opt-out (also annotates a `FORCE`) |
| `UNSAFE_BOUNDARY` | host is not at a step boundary (also annotates a `FORCE`) |
| `COOLDOWN_ACTIVE` | too few calls since the last compaction |
| `INSUFFICIENT_RECLAIM_TOKENS` | estimated reclaim below `minReclaimTokens` |
| `INSUFFICIENT_RECLAIM_RATIO` | estimated reclaim ratio below `minReclaimRatio` |
| `CACHE_STILL_VALUABLE` | cache evidence exists and `q >= cacheValuableThreshold` |
| `CACHE_LIKELY_EXPIRED` | cache evidence exists and `q < cacheValuableThreshold` |
| `NO_POSITIVE_SAVING` | adjusted net saving did not clear `minNetSaving` |
| `NO_BREAK_EVEN` | `breakEvenCalls === null` |
| `BREAK_EVEN_BEYOND_HORIZON` | `breakEvenCalls > effectiveHorizon` |
| `LOW_CONFIDENCE` | evidence score below `lowConfidenceThreshold`, with no positive saving |
| `ECONOMIC_TRIGGER` | economics gate passed |
| `BREAK_EVEN_WITHIN_HORIZON` | `breakEvenCalls <= effectiveHorizon` |
| `DEFAULT_KEEP` | no other reason applied |

Codes are stable and machine-readable; `REASON_DESCRIPTIONS` provides log text but hosts
must key on the code. `BREAK_EVEN_BEYOND_HORIZON` is the one code added on top of the task
book's minimum list — see [§16](#16-additions-beyond-the-task-book).

## 11. nextCheckAtTokens

An advisory hint (present only on `KEEP`) for hosts that do not want to ask on every token.
It is the smallest of:

- `ceil(softWindowRatio * W)` — the soft-window boundary;
- `ceil(minReclaimTokens / (1 - r))` — where the reclaim floor starts to be met;
- the economic boundary derived from the same linear model:
  `(minNetSaving + penalty * fixedCompactCost) / slope`, where
  `slope = (effectiveHorizon * perTokenReplayCost - perTokenCompactExtraCost) * confidence -
  penalty * perTokenCompactExtraCost` (and `Infinity` when `slope <= 0`, i.e. the economics
  can never turn positive in this configuration);

clamped so that it never exceeds the force boundary and is always greater than the current
`contextTokens`. It is a hint, not a promise: the host may ask again earlier.

## 12. Defaults

All defaults live in [`src/defaults.ts`](../src/defaults.ts), are overridable through
`FoldPointOptions.defaults`, and are validated on construction.

| Default | Value | Why this value |
| --- | --- | --- |
| `retentionRatio` | 0.40 | a generic "summarize to 40% of the context" prior; deliberately not optimistic, and replaced by real data as soon as one compaction succeeds |
| `compactOutputRatio` | 0.12 | a summary is usually far shorter than the context it summarizes; used only to price the compaction call before real usage is known |
| `expectedFutureCalls` | 3 | the horizon used when neither the host nor history provides one; short, so a fresh profile does not over-commit |
| `minCallsBetweenCompactions` | 3 | cooldown: prevents back-to-back compaction of an unchanged context |
| `minReclaimTokens` | 4096 | an absolute floor: compacting to save a few hundred tokens is never worth a model call |
| `minReclaimRatio` | 0.20 | a relative floor: a compactor that reclaims under 20% is not earning its call |
| `softWindowRatio` | 0.65 | below this utilization the window is not scarce, so payback must be quick (see `softWindowBreakEvenCalls`) |
| `softWindowBreakEvenCalls` | 3 | the "quick payback" requirement below the soft window |
| `hardWindowRatio` | 0.90 | window-safety boundary; above it the answer is `FORCE` |
| `reserveTokens` | 8192 | absolute safety margin for the next call's output and overhead |
| `emaAlpha` | 0.25 | standard smoothing: adapts within a handful of events without over-reacting to one outlier |
| `minNetSaving` | 0 | compaction must save *something* after the uncertainty penalty |
| `uncertaintyPenalty` | 0.15 | discounts an unproven benefit by 15% of the compaction call cost |
| `softWindowPenaltyMultiplier` | 2 | doubles that penalty below the soft window |
| `confidenceFloor` | 0.35 | keeps overwhelming economics actionable on a fresh profile |
| `confidenceHalfSaturationSamples` | 2 | evidence score reaches half its remaining range after 2 samples |
| `cacheValuableThreshold` | 0.50 | above this survival, the cache counts as "still valuable" for explanations |
| `lowConfidenceThreshold` | 0.50 | below this evidence score, `KEEP` is annotated `LOW_CONFIDENCE` |

Numeric bounds (`NUMERIC_BOUNDS`): `retentionRatio ∈ [0.05, 1]`, `compactOutputRatio ∈
[0, 1]`. These are safety clamps, not tuned thresholds.

The defaults are starting points, not validated optima. The benchmark measures their
sensitivity (see [benchmarks/README.md](../benchmarks/README.md)).

## 13. Online learning rules

```
newEstimate = alpha * observation + (1 - alpha) * oldEstimate
```

| Update | Rule | Guard |
| --- | --- | --- |
| retention | `clamp(afterTokens / beforeTokens, 0.05, 1)`, only on `success` | a compactor that grows the context clamps to 1 and makes future economic compaction strictly harder |
| compact output ratio | `outputTokens / beforeTokens`, clamped to `[0, 1]` | only when the host reports `outputTokens` |
| compaction cost | `actualCost`, else usage × prices, else normalized tokens | only when some cost data exists; the first sample initializes the EMA instead of being blended with an invented prior |
| cache hit ratio | `cachedInputTokens / promptTokens` | only when `promptTokens > 0` |
| reuse horizon | calls between the last compaction and `endSession` | only after at least one compaction in that profile |
| growth per call | `promptTokens - previousPromptTokens` | only when the prompt grew: a smaller prompt means a compaction, not growth |

Failed compactions increment `compactionCount` but never touch retention, output ratio or
cost, and they do not reset `callsSinceLastCompaction`: a failing compactor cannot be
hammered, while `FORCE` remains available because the cooldown never blocks the window guard.

## 14. Worked example

A 200,000-token window, input `$3/M`, cache read `$0.30/M`, cache write `$3.75/M`, output
`$15/M`. The profile has learned `r = 0.25`, a compaction cost of `$0.05`, a horizon of 10
calls, and its cache expired (`idleMs > ttlMs`).

```
T = 150,000, C = 140,000, U = 10,000, q = 0, R = 10
currentReplayCost = 10,000*3e-6 + 140,000*3e-6                     = 0.4500
Ta                = 150,000 * 0.25                                 = 37,500
qNew              = 0                       (expired cache, no credit)
laterReplayCost   = 37,500 * 3e-6                                  = 0.1125
firstReplayCost   = 37,500 * 3.75e-6                               = 0.1406
compactCallCost   = 0.05                    (learned)
keepCost          = 10 * 0.45                                      = 4.5000
compactCost       = 0.05 + 0.1406 + 9 * 0.1125                     = 1.2031
netSaving         = 4.5000 - 1.2031                                = 3.2969
savingPerCall     = 0.4500 - 0.1125                                = 0.3375
breakEvenCalls    = (0.05 + 0.1406) / 0.3375                       = 0.56
confidence        = 0.35 + 0.65 * (0.5*4/6 + 0.25*3/5 + 0.25*3/5)  = 0.7617
penalty           = 0.15                    (utilization 0.75 >= soft window)
adjustedNetSaving = 3.2969 * 0.7617 - 0.15 * 0.05                  = 2.5035
effectiveHorizon  = min(10, 10, Infinity)                          = 10
```

`adjustedNetSaving > 0` and `0.56 <= 10` → **COMPACT**, with reasons `ECONOMIC_TRIGGER`,
`BREAK_EVEN_WITHIN_HORIZON`, `CACHE_LIKELY_EXPIRED`.

Change one input — make the cache warm and cheap (`q = 0.95`, `Pcache = $0.30/M`) — and the
same context at the same utilization produces a much smaller saving, because keeping is
nearly free; with a short horizon the same session becomes **KEEP**.

## 15. Sensitivity

- **`retentionRatio`** — the dominant term. Worse compaction reduces `reclaimTokens` linearly
  and raises `breakEvenCalls`; below `minReclaimRatio` it stops economic compaction entirely.
- **`uncertaintyPenalty` / `softWindowPenaltyMultiplier`** — the main brake on acting with
  little evidence. Raising them makes FoldPoint behave more like a wall-only policy.
- **`minReclaimTokens` / `minReclaimRatio`** — the main brake on small-context churn.
- **`hardWindowRatio` / `reserveTokens`** — pure safety; they also set the ceiling for
  `nextCheckAtTokens`.
- **`emaAlpha`** — how fast learned behaviour replaces the prior. Higher adapts faster and is
  noisier; it cannot make `FORCE` less safe.
- **Prices** — cheap cache reads make keeping attractive at any utilization; expensive output
  makes the compaction call itself expensive and delays compaction.
- **`growthPerCallEma`** — fast regrowth caps the horizon and therefore suppresses repeated
  compaction.

`npm run benchmark` exercises all of these across the ten scenarios; the raw numbers are in
[`benchmarks/reports/benchmark-report.json`](../benchmarks/reports/benchmark-report.json).

## 16. Additions beyond the task book

The task book allows the data model, state model and defaults to be adjusted, and requires
every default to be documented and configurable. Everything FoldPoint adds is listed here so
a reviewer can accept or reject it explicitly. Nothing else deviates.

**Extra defaults** (the task book's list plus these; all are overridable and documented in
§12):

| Default | Why it exists |
| --- | --- |
| `softWindowBreakEvenCalls` | the task book requires that below the soft window a compaction must "repay quickly" (13.7). Without a number for "quickly", the only options were a fixed threshold (forbidden) or an unenforced sentence. |
| `softWindowPenaltyMultiplier` | the second half of 13.7 ("weak economic gain or low confidence → prefer KEEP"): below the soft window the uncertainty penalty is doubled. |
| `confidenceFloor` | the confidence model of 13.9 needs a value with zero samples; without a floor, `COMPACT` would be unreachable on a fresh profile, which contradicts 13.7 and the acceptance criterion that all three actions are reachable. |
| `confidenceHalfSaturationSamples` | the saturation point of the evidence curve. |
| `cacheValuableThreshold` | the boundary between the `CACHE_STILL_VALUABLE` and `CACHE_LIKELY_EXPIRED` reason codes. |
| `lowConfidenceThreshold` | the boundary for the `LOW_CONFIDENCE` reason code. |

**Extra state fields:**

| Field | Why it exists |
| --- | --- |
| `growthPerCallEma`, `growthSamples` | the learned growth rate that caps the horizon at `callsUntilRefill`. Without it, a host that declares a long horizon gets repeated compaction of a small context (the churn case in §17.3 of the benchmark). |
| `lastPromptTokens` | the previous prompt size, used only to learn the growth rate. |
| `lastCacheExpiresAt` | the task book allows an exact expiry to be reported per observation (11.1); storing the last one lets it apply to later decisions without the host repeating it. |

**Extra metrics:** `adjustedNetSaving` (13.9 requires the penalty; exposing the result makes
the gate explainable), `effectiveHorizonCalls` (the gate does not always use
`expectedFutureCalls`, so the difference must be visible), `callsUntilRefill` (the horizon
cap that prevents churn).

**Extra reason code:** `BREAK_EVEN_BEYOND_HORIZON`, so that "no positive saving" and "saving
exists but is too slow" are distinguishable. The task book's list is a minimum ("至少包括").

**Extra input field:** `cacheExpiresAt` on `FoldPointInput`, mirroring the observation field,
so a host can pass the expiry at decision time without an observation in between.

**One deliberate correction to a §12 formula:** the task book's 12.4 fixes the first
post-compaction replay at the plain input price (`Ta × Pin`). FoldPoint charges it at the
cache-write price (`Ta × Pwrite`, where `Pwrite` defaults to `Pin`), because that replay is
what rebuilds the prefix. With no `cacheWritePerMillion` in the price snapshot the two are
identical, so the difference only appears for providers that charge a cache-write premium —
and there it makes FoldPoint slightly *more* conservative, never less.

**Extra API:** `FoldPoint.getDefaults()` (inspect the resolved defaults),
`resolveDefaults`/`validateDefaults`/`isResolvedDefaults`, `estimateCacheSurvival`,
`resolveCacheHitRatio`, `resolveIdleMs`, `resolveCacheExpiresAt`, `computeConfidence`,
`emaUpdate`, `sampleConfidence`, `percentile`, and the state helpers
(`createProfileState`, `normalizeProfileState`, `applyRequestObservation`,
`applyCompactionObservation`, `applySessionEnd`). All are pure functions; none widen the
decision surface.
