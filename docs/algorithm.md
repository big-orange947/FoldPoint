# FoldPoint algorithm

This document is the reference for what `decide()` computes. The implementation is
[`src/estimator.ts`](../src/estimator.ts); the formulas appear there in the same order.

**State version 2.** FoldPoint keeps two kinds of state, and they never mix:

- **Profile learning state** (`FoldPointProfileLearningState`) is shared by every session of
  a `provider + model + contextWindowTokens + compactorId` profile. It contains only ratios
  and counts: retention, compaction usage ratios, an actual-cost *scale*, cache coverage,
  the reuse horizon. No absolute amount is ever stored.
- **Session runtime state** (`FoldPointSessionState`) belongs to one `sessionId` of one
  profile: request count, attempt counts, the call counters, timestamps and the exact cache
  expiry of the current prefix. `endSession` deletes it.

Keys are JSON tuples, so a `|` inside a field cannot collide:

```
profileKey(profile)        = JSON.stringify([provider ?? "", model, contextWindowTokens, compactorId])
sessionKey(sessionId, p)   = JSON.stringify([profileKey(p), sessionId])
```

The content order below is the order of the computation.

1. [Cache coverage](#1-cache-coverage)
2. [Cache aliveness](#2-cache-aliveness)
3. [Effective cached tokens](#3-effective-cached-tokens)
4. [Current replay cost](#4-current-replay-cost)
5. [Compaction call cost from usage ratios](#5-compaction-call-cost-from-usage-ratios)
6. [Current pricing](#6-current-pricing)
7. [First post-compaction replay](#7-first-post-compaction-replay)
8. [Later post-compaction replay](#8-later-post-compaction-replay)
9. [Break-even](#9-break-even)
10. [Confidence](#10-confidence)
11. [The quick-payback policy guard](#11-the-quick-payback-policy-guard)
12. [Decision gates](#12-decision-gates)
13. [Reason codes](#13-reason-codes)
14. [nextCheckAtTokens](#14-nextcheckattokens)
15. [Defaults](#15-defaults)
16. [Online learning rules](#16-online-learning-rules)
17. [Worked example](#17-worked-example)
18. [Additions and corrections to the task book](#18-additions-and-corrections-to-the-task-book)

## 1. Cache coverage

*How much of the context the cache could serve* — a coverage ratio, not a survival
probability. Resolved in this order:

```
input.cachedTokens is provided                  -> candidateCachedTokens = clamp(cachedTokens, 0, T)
else cacheCoverageSamples > 0                   -> candidateCachedTokens = clamp(T * cacheCoverageRatioEma, 0, T)
else                                            -> candidateCachedTokens = 0

coverageRatio = candidateCachedTokens / T        (0 when T = 0)
```

`cacheCoverageRatioEma` is learned from `cachedInputTokens / promptTokens` of real requests.
It is an observed hit rate, so it must never be discounted again by a survival factor.

## 2. Cache aliveness

*Whether that candidate prefix is still usable.* A probability, and it does **not** contain
the coverage ratio. Resolved in this order:

| Condition | aliveProbability | source |
| --- | --- | --- |
| no cache discount, or `cachePolicy.disabled` | 0 | `no-cache-discount` / `cache-disabled` |
| exact expiry known (`input.cacheExpiresAt`, else the session's) | `timestamp < cacheExpiresAt ? 1 : 0` | `expiry-known` |
| `cachePolicy.ttlMs` known | `idleMs < ttlMs ? 1 : 0` | `ttl-known` |
| `cachePolicy.halfLifeMs` known | `2 ^ (-idleMs / halfLifeMs)` | `half-life` |
| nothing known, and `candidateCachedTokens > 0` | 1 | `assumed-alive` |
| nothing known, and no candidate | 0 | `no-candidate` |

`idleMs` comes from the input, or from the *session's* `lastRequestAt` when omitted. The
exact expiry is stored per session and **cleared** by any request observation that does not
report one, so a stale expiry can never control a newer prefix.

## 3. Effective cached tokens

```
effectiveCachedTokens = candidateCachedTokens * aliveProbability
```

Coverage and aliveness meet exactly here. The cost formula below must never multiply a
coverage ratio in a second time: with coverage 0.8 and aliveness 0.5 the effective share is
0.4, not 0.32.

## 4. Current replay cost

```
currentReplayCost = effectiveCachedTokens * Pcache
                  + (T - effectiveCachedTokens) * Pin
```

`Pin` is the plain input price per token, `Pcache` the cache-read price per token. The
uncached remainder is billed at the input price, because that is what the host pays when it
sends the context again.

## 5. Compaction call cost from usage ratios

The compaction call is priced from scale-free ratios learned from real compactions, not from
a stored amount:

```
estimatedCompactPromptTokens = T * compactPromptRatio          (cold start 1)
estimatedCompactOutputTokens = T * compactOutputRatio          (cold start 0.12)
estimatedCompactCachedTokens = estimatedCompactPromptTokens * compactCachedInputRatio  (0)
estimatedCompactWriteTokens  = estimatedCompactPromptTokens * compactCacheWriteRatio   (0)

modeledCompactCallCost = costOfUsage(prices, {
  promptTokens:     estimatedCompactPromptTokens,
  cachedInputTokens: estimatedCompactCachedTokens,
  cacheWriteTokens:  estimatedCompactWriteTokens,
  outputTokens:      estimatedCompactOutputTokens,
})

compactCallCost = modeledCompactCallCost * compactCostScale     (cold start 1)
```

Consequences that matter:

- a ratio learned on a 10k context prices a 180k context correctly, because everything scales
  with `T`;
- changing the price snapshot reprices the compaction call immediately, without resetting any
  learning;
- switching from `tokenOnlyPricing()` to a currency does not reinterpret a token count as
  money, because no amount is stored.

`compactCostScaleEma` is the only place an `actualCost` enters: it is learned as
`actualCost / modeledCost`, clamped to `[0.1, 10]`, and only when the observation carries an
`actualCost`, a `promptTokens`, and an explicit non-token-only price snapshot. In normalized
token-cost mode it is never updated, so `11000` token units can never become `$11000`.

## 6. Current pricing

Per-token prices come from the profile's `PricingSnapshot` (`price / 1_000_000`):

- no snapshot at all → normalized token cost, every price is `1`, no cache discount;
- no `cacheReadPerMillion` → `Pcache = Pin` and `hasCacheDiscount = false`, so cache
  aliveness is 0 and no saving is invented;
- no `cacheWritePerMillion` → `Pwrite = Pin`.

Prices are read on every decision; a profile is not keyed by price.

## 7. First post-compaction replay

```
firstPostCompactReplayCost = estimatedPostCompactTokens * Pwrite
estimatedPostCompactTokens = T * retentionRatio
```

The first replay after a compaction rebuilds the prefix, so it is billed at the cache-write
price. This is the conservative direction and it matches how the benchmark's ground truth
bills a rebuilt prefix.

## 8. Later post-compaction replay

```
postCompactCoverageRatio     = cacheCoverageSamples > 0 ? cacheCoverageRatioEma : 0
postCompactCandidateTokens   = estimatedPostCompactTokens * postCompactCoverageRatio
postCompactEffectiveTokens   = postCompactCandidateTokens * aliveProbability
laterPostCompactReplayCost   = postCompactEffectiveTokens * Pcache
                             + (estimatedPostCompactTokens - postCompactEffectiveTokens) * Pin
```

With no cache history at all the later replay is priced as plain input, which is the
conservative direction.

## 9. Break-even

Keeping the context for `N` future calls costs `N * C`. Compacting costs
`K + F + (N - 1) * L`. Setting them equal and solving for `N`:

```
N * C = K + F + (N - 1) * L
N * (C - L) = K + F - L
breakEvenCalls = (K + F - L) / (C - L)

C = currentReplayCost            K = compactCallCost
F = firstPostCompactReplayCost   L = laterPostCompactReplayCost
```

- `C - L <= 0` → `null`: there is no positive per-call saving, so compaction can never repay
  itself.
- numerator `<= 0` → `0`: compacting is already not more expensive before the first call.
- a division that overflows is reported as `Number.MAX_SAFE_INTEGER` (effectively
  unreachable) so metrics stay JSON-safe.

`computeBreakEvenCalls` is exported as a pure function so the algebra can be tested directly.
Example: `C = 5, K = 10, F = 4, L = 2` → `(10 + 4 - 2) / (5 - 2) = 4`, and indeed
`Keep(4) = 20 = Compact(4) = 10 + 4 + 3 * 2`.

The keep/compact totals are still reported over the declared horizon:

```
estimatedKeepCost    = R * C
estimatedCompactCost = K + F + max(R - 1, 0) * L
estimatedNetSaving   = estimatedKeepCost - estimatedCompactCost
savingPerFutureCall  = C - L
```

## 10. Confidence

An *evidence score*, not a probability of task quality:

```
f(n)       = n / (n + confidenceHalfSaturationSamples)        (half-saturation, default 2)
evidence   = 0.40 * f(retentionSamples)
           + 0.20 * f(compactionUsageSamples)
           + 0.20 * f(cacheCoverageSamples)
           + 0.20 * f(horizonSamples)
confidence = clamp(confidenceFloor + (1 - confidenceFloor) * evidence, 0, 1)   (floor 0.35)
```

The weights sum to 1. `compactionUsageSamples` is the largest of the compaction usage sample
counts (prompt, output, cached-input, cache-write, cost scale): it counts compaction calls
that reported usage, which is what prices the compaction call. Confidence starts at the
floor, is monotone non-decreasing in every sample count, and never affects `FORCE`.

```
penalty = uncertaintyPenalty * (utilization < softWindowRatio ? softWindowPenaltyMultiplier : 1)
adjustedNetSaving = estimatedNetSaving * confidence - penalty * compactCallCost
```

## 11. The quick-payback policy guard

```
effectiveHorizonCalls = utilization < softWindowRatio
  ? min(expectedFutureCalls, softWindowBreakEvenCalls)     (default 3)
  : expectedFutureCalls
```

Below the soft window the window is not scarce, so a compaction has to repay itself within a
few calls instead of over the whole session. This is a **quality-oriented policy guard, not a
mathematical optimum**: it is the encoded form of "below the soft window, only a quick
payback justifies compacting". It is configurable, and it is not the only trigger — an
overwhelming economic win below the soft window still produces `COMPACT`.

`expectedFutureCalls` is the host value, else the learned `reuseHorizonEma`, else the
cold-start default. There is no context-regrowth heuristic in the model.

## 12. Decision gates

All metrics are computed before the gates, so every branch returns the same complete metrics
block. The first matching gate wins.

1. **Window safety → `FORCE`** if `utilization >= hardWindowRatio` **or**
   `remainingTokens <= reserveTokens`. If the host has disabled compaction or is not at a
   safe boundary, `COMPACTION_DISABLED` / `UNSAFE_BOUNDARY` are added to `reasons`.
2. **Host opt-out → `KEEP`** if `compactionAllowed === false`.
3. **Step boundary → `KEEP`** if `safeBoundary === false`.
4. **Cooldown → `KEEP`** if `compactionAttemptCount > 0` and
   `callsSinceLastAttempt < minCallsBetweenCompactions`. Any attempt — successful or not —
   resets `callsSinceLastAttempt`, so a failing compactor cannot be hammered. The cooldown
   only blocks ordinary economic compaction; `FORCE` still wins, and retry backoff beyond
   that remains the host's responsibility.
5. **Minimum reclaim → `KEEP`** if `estimatedReclaimTokens < minReclaimTokens` or
   `estimatedReclaimRatio < minReclaimRatio`.
6. **Economics → `COMPACT`** if `adjustedNetSaving > minNetSaving` **and**
   `breakEvenCalls !== null` **and** `breakEvenCalls <= effectiveHorizonCalls`.
7. **Otherwise → `KEEP`**, annotated with the diagnosis.

## 13. Reason codes

| Code | Emitted when |
| --- | --- |
| `HARD_WINDOW_RATIO` | utilization reached `hardWindowRatio` |
| `RESERVE_TOKENS_REACHED` | remaining window dropped to `reserveTokens` |
| `COMPACTION_DISABLED` | host opt-out (also annotates a `FORCE`) |
| `UNSAFE_BOUNDARY` | host is not at a step boundary (also annotates a `FORCE`) |
| `COOLDOWN_ACTIVE` | too few calls since the last compaction attempt |
| `INSUFFICIENT_RECLAIM_TOKENS` | estimated reclaim below `minReclaimTokens` |
| `INSUFFICIENT_RECLAIM_RATIO` | estimated reclaim ratio below `minReclaimRatio` |
| `CACHE_STILL_VALUABLE` | cache evidence exists and `aliveProbability >= cacheAliveThreshold` |
| `CACHE_LIKELY_EXPIRED` | cache evidence exists and `aliveProbability < cacheAliveThreshold` |
| `NO_POSITIVE_SAVING` | adjusted net saving did not clear `minNetSaving` |
| `NO_BREAK_EVEN` | `breakEvenCalls === null` |
| `BREAK_EVEN_BEYOND_HORIZON` | `breakEvenCalls > effectiveHorizonCalls` |
| `LOW_CONFIDENCE` | evidence score below `lowConfidenceThreshold`, with no positive saving |
| `ECONOMIC_TRIGGER` | the economics gate passed |
| `BREAK_EVEN_WITHIN_HORIZON` | `breakEvenCalls <= effectiveHorizonCalls` |
| `DEFAULT_KEEP` | no other reason applied |

Codes are stable and machine-readable; `REASON_DESCRIPTIONS` provides log text but hosts must
key on the code. Cache codes are only emitted when the profile has a cache candidate.

## 14. nextCheckAtTokens

An advisory hint (present only on `KEEP`) for hosts that do not want to ask on every token.
It is the smallest of:

- `ceil(softWindowRatio * W)` — the soft-window boundary;
- `ceil(minReclaimTokens / (1 - r))` — where the reclaim floor starts to be met;
- the economic boundary from the same linear model: `minNetSaving / slope`, where
  `slope = (H * perTokenReplayCost - perTokenCompactExtraCost) * confidence -
  penalty * perTokenCompactCost` and `H = effectiveHorizonCalls` (and `Infinity` when
  `slope <= 0`);

clamped so that it never exceeds the force boundary and is always greater than the current
`contextTokens`. It is a hint, not a promise.

## 15. Defaults

All defaults live in [`src/defaults.ts`](../src/defaults.ts), are overridable through
`FoldPointOptions.defaults`, and are validated on construction.

| Default | Value | Why this value |
| --- | --- | --- |
| `retentionRatio` | 0.40 | generic "summarize to 40%" prior, replaced by real data after the first success |
| `compactPromptRatio` | 1.00 | the compaction call reads the context it compacts |
| `compactOutputRatio` | 0.12 | a summary is much shorter than the context it summarizes |
| `compactCachedInputRatio` | 0 | cold start assumes the compaction call cannot read a cache |
| `compactCacheWriteRatio` | 0 | cold start assumes no cache writes on the compaction call |
| `compactCostScale` | 1.00 | the modeled cost is the estimate until real costs say otherwise |
| `expectedFutureCalls` | 3 | used when neither the host nor history provides a horizon |
| `minCallsBetweenCompactions` | 3 | cooldown between attempts |
| `minReclaimTokens` | 4,096 | absolute floor: compacting for a few hundred tokens is never worth a call |
| `minReclaimRatio` | 0.20 | relative floor: a compactor reclaiming under 20% is not earning its call |
| `softWindowRatio` | 0.65 | below this the window is not scarce |
| `softWindowBreakEvenCalls` | 3 | the quick-payback policy guard below the soft window |
| `hardWindowRatio` | 0.90 | window-safety boundary → `FORCE` |
| `reserveTokens` | 8,192 | absolute safety margin |
| `emaAlpha` | 0.25 | adapts within a handful of events without over-reacting to one outlier |
| `minNetSaving` | 0 | compaction must save something after the uncertainty penalty |
| `uncertaintyPenalty` | 0.15 | discounts an unproven benefit by 15% of the compaction call cost |
| `softWindowPenaltyMultiplier` | 2 | doubles that penalty below the soft window |
| `confidenceFloor` | 0.35 | keeps overwhelming economics actionable on a fresh profile |
| `confidenceHalfSaturationSamples` | 2 | the evidence curve reaches half its range after 2 samples |
| `cacheAliveThreshold` | 0.50 | above this alive probability the cache counts as still valuable (the name matches what it compares) |
| `lowConfidenceThreshold` | 0.50 | below this evidence score, `KEEP` is annotated `LOW_CONFIDENCE` |

Numeric bounds (`NUMERIC_BOUNDS`): `retentionRatio ∈ [0.05, 1]`, `compactPromptRatio ∈ [0, 2]`,
`compactOutputRatio ∈ [0, 1]`, `compactCostScale ∈ [0.1, 10]`. These are numerical safety
clamps, not tuned thresholds.

## 16. Online learning rules

```
newEstimate = alpha * observation + (1 - alpha) * oldEstimate
```

| Update | Observation | Where | Guard |
| --- | --- | --- | --- |
| retention | `afterTokens / beforeTokens`, clamped to `[0.05, 1]` | profile | success only |
| compaction prompt ratio | `promptTokens / beforeTokens`, clamped to `[0, 2]` | profile | success, when reported |
| compaction output ratio | `outputTokens / beforeTokens`, clamped to `[0, 1]` | profile | success, when reported |
| compaction cached-input ratio | `cachedInputTokens / promptTokens` | profile | success, when reported |
| compaction cache-write ratio | `cacheWriteTokens / promptTokens` | profile | success, when reported |
| actual-cost scale | `clamp(actualCost / modeledCost, 0.1, 10)` | profile | success, real currency, complete usage |
| cache coverage | `cachedInputTokens / promptTokens` | profile | `promptTokens > 0` |
| reuse horizon | calls between the last successful compaction and session end | profile | `endSession` after a success |
| request count, call counters, expiry | — | session | every observation |

Failed attempts increment `compactionAttemptCount` and `failedCompactionCount`, reset the
cooldown, and update **nothing** in the profile: a failed attempt teaches nothing about the
compactor.

## 17. Worked example

200,000-token window; input `$3/M`, cache read `$0.30/M`, cache write `$3.75/M`, output
`$15/M`. The profile has learned `retentionRatio = 0.25`, `compactPromptRatio = 1`,
`compactOutputRatio = 0.10`, no compaction cache reads, a horizon of 10 calls; the cache has
expired (`idleMs > ttlMs`).

```
T = 150,000   cachedTokens = 140,000   idleMs = 600,000
coverageRatio      = 140,000 / 150,000          = 0.9333
aliveProbability   = 0                          (TTL lapsed)
effectiveCached    = 140,000 * 0              = 0
currentReplayCost  = 0 + 150,000 * 3e-6       = 0.4500
Ta                 = 150,000 * 0.25           = 37,500
firstReplayCost    = 37,500 * 3.75e-6         = 0.1406
postCoverage       = 0.9  (learned)  -> postEffective = 33,750 * 0 = 0
laterReplayCost    = 0 + 37,500 * 3e-6        = 0.1125
compactCallCost    = 150,000 * 3e-6 + 15,000 * 15e-6 = 0.6750
keepCost           = 10 * 0.45                = 4.5000
compactCost        = 0.675 + 0.1406 + 9 * 0.1125 = 1.8281
netSaving          = 4.5000 - 1.8281          = 2.6719
savingPerFutureCall= 0.45 - 0.1125            = 0.3375
breakEvenCalls     = (0.675 + 0.1406 - 0.1125) / 0.3375 = 2.08
confidence         = 0.35 + 0.65 * (0.4*4/6 + 0.2*3/5 + 0.2*3/5 + 0.2*3/5) = 0.757
penalty            = 0.15                      (utilization 0.75 >= soft window)
adjustedNetSaving  = 2.6719 * 0.757 - 0.15 * 0.675 = 1.921
effectiveHorizon   = 10                        (>= soft window)
```

`adjustedNetSaving > 0` and `2.08 <= 10` → **COMPACT**, with `ECONOMIC_TRIGGER`,
`BREAK_EVEN_WITHIN_HORIZON` and `CACHE_LIKELY_EXPIRED`.

Make the cache warm and cheap instead (`aliveProbability = 1`, `Pcache = $0.30/M`): keeping
the context costs `140,000 * 0.3e-6 + 10,000 * 3e-6 = 0.072` per call, the per-call saving
collapses, and the same session becomes **KEEP**.

## 18. Additions and corrections to the task book

The revision task book allows the data model, state model and defaults to be adjusted, and
requires every default to be documented and configurable. Everything FoldPoint adds or
changes is listed here so a reviewer can accept or reject it explicitly.

**Deliberate corrections to the task book's formulas:**

1. **First post-compaction replay price.** The task book fixes it at the plain input price;
   FoldPoint bills it at the cache-write price (`Pwrite`, defaulting to `Pin`), because that
   replay is what rebuilds the prefix, and the benchmark's ground truth bills it the same
   way. With no `cacheWritePerMillion` the two are identical.
2. **Compaction call cost.** The task book's §7.5/§9.3 ask for the compaction call to be
   priced from usage ratios; FoldPoint adds the optional dimensionless `compactCostScale`
   (default 1) so a host that reports a real `actualCost` can correct a modeled cost without
   storing an amount.

**Extra defaults** (all overridable, all documented in §15): `softWindowBreakEvenCalls`,
`softWindowPenaltyMultiplier`, `confidenceFloor`, `confidenceHalfSaturationSamples`,
`cacheAliveThreshold` (renamed from `cacheValuableThreshold` so the name matches what it
compares), `lowConfidenceThreshold`.

**Extra state fields:** the per-ratio sample counters (`compactPromptSamples`,
`compactOutputSamples`, `compactCachedInputSamples`, `compactCacheWriteSamples`,
`compactCostScaleSamples`), `successfulCompactionCount` on both profile and session, and
`failedCompactionCount` on the session.

**Extra metrics:** `adjustedNetSaving`, `effectiveHorizonCalls`, `estimatedCompactCallCost`.

**Extra reason code:** `BREAK_EVEN_BEYOND_HORIZON`, so "no positive saving" and "a saving
that is too slow" are distinguishable. The task book's list is a minimum.

**Removed by this revision:** `growthPerCallEma`, `growthSamples`, `lastPromptTokens`,
`callsUntilRefill`, `compactionCostEma`, `compactionCostSamples`, `lastCacheExpiresAt`,
`callsSinceLastCompaction`, `lastCompactionAt`, `compactionSamples`, `estimatedCacheSurvival`
and the state version 1 shape. Version 1 snapshots are rejected with an explicit error rather
than reinterpreted.
