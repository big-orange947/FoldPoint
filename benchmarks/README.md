# FoldPoint simulation benchmark

```bash
npm run benchmark
```

Runs eleven deterministic simulated agent sessions against eight baselines and FoldPoint,
prints two tables, and writes the raw report to
[`reports/benchmark-report.json`](reports/benchmark-report.json).

The benchmark answers four questions:

1. does FoldPoint avoid window overflows;
2. how does it compare on simulated cost against fixed thresholds, with and without the
   guards it shares with them;
3. how many of its compactions were not economically repaid;
4. does it keep the window safe when a compactor is unreliable.

It does **not** measure task quality, answer accuracy or information retention — see
[Conclusion discipline](#conclusion-discipline).

## Files

| File | Contents |
| --- | --- |
| `scenarios.ts` | the eleven scenarios, their ground truth, the two RNG streams |
| `fixed-threshold.ts` | the strategy interface, raw baselines, guarded baselines |
| `simulator.ts` | the session loop, FoldPoint wiring, metrics, tables, JSON report, micro-benchmark |
| `reports/benchmark-report.json` | the raw report of the last run |

## Simulation model

One simulated session is a loop over steps. Every strategy goes through exactly the same
loop; the only difference is the decision it returns.

1. The step's new tokens are appended to the context, driven **only** by the growth RNG.
2. The strategy decides `KEEP` / `COMPACT` / `FORCE` from the metadata a host would have.
3. On `COMPACT`/`FORCE` a compaction **attempt** happens. It succeeds with probability
   `successRate` (failure RNG). The attempt is always billed
   (`costOfUsage(prices, { promptTokens: beforeTokens, outputTokens })`). On success the
   context becomes `round(beforeTokens * retentionRatio)` and the provider cache is
   invalidated; on failure the context is unchanged and no cache prefix is built.
4. The model call is charged with `costOfUsage`: when the call rebuilds a cache prefix
   (first call, after a successful compaction, after the TTL lapsed) the whole prompt is
   billed at the cache-write price; otherwise the previously cached part is billed at the
   cache-read price and the appended tail at the plain input price.
5. After a successful call the provider holds a cache for that whole prompt. The cache stays
   alive while the idle gap is below the scenario's TTL and no successful compaction has
   rebuilt the prefix since.
6. FoldPoint additionally receives `observeRequest`, `recordCompaction` (with the real
   `success` flag) and `endSession` events. The baselines ignore them.

The simulator and the engine use the same `costOfUsage` / `resolveUnitPrices` helpers, so
there is only one cost formula in the project.

**Ground truth is hidden.** The compactor's real retention ratio, the real failure rate, the
real cache behaviour and the real prices never reach a strategy except through the
host-style observations above. FoldPoint never sees `retentionRatio`; it learns it.

**Overflow.** A call whose prompt exceeds the context window is an overflow: the host is
forced to compact at the worst possible moment and pays for that recovery. The overflow is
counted, and `minRemainingHeadroom` is measured *before* the recovery, so an overflow shows
up as a negative headroom.

**Baselines.** `never` never compacts. The `*-raw` baselines compact as soon as utilization
reaches their threshold and deliberately get no cooldown, no reserve and no safe-boundary
rule — they are the naive comparison point, so their churn has to be visible. The
`*-guarded` baselines have the guards FoldPoint also has (hard window ratio, reserve tokens,
cooldown restarted by *any* attempt, safe boundary, same compactor) but **not** its cost
model, minimum reclaim or economics. A difference against a guarded baseline is therefore a
difference the economic model made, not a difference the guards made.

**Scenarios.** Each scenario isolates one variable. `E`/`F` use a cold cache so that compactor
quality is the only thing that changes between them; `C`/`D` use the same cheap cache read
with a warm and a cold cache; `K` makes half of all compaction attempts fail.

| id | name | what it isolates |
| --- | --- | --- |
| A | short-task | tiny session: nobody should compact |
| B | long-tool-task | steady growth with a stable, replayed prefix |
| C | cache-alive | warm cache, very cheap cache reads, short idle gaps |
| D | cache-expired | idle gaps beyond the TTL: the prefix is plain input again |
| E | good-compactor | retention 0.25 |
| F | bad-compactor | retention 0.95 |
| G | expensive-compaction | large, expensive compaction output |
| H | sudden-growth | one step adds a huge output |
| I | compaction-churn | the context regrows fast after every compaction |
| J | no-cache-discount | cache reads cost the same as plain input |
| K | flaky-compactor | half of all compaction attempts fail |

A scenario that declares `hostHorizon` gives FoldPoint the host's remaining-call estimate,
capped by the steps the session actually has left, so the estimate shrinks as the session
proceeds instead of pretending the session never ends.

## Metric definitions

| Metric | Definition |
| --- | --- |
| `totalSimulatedCost` | every model call, every compaction attempt and every overflow recovery, in the scenario's currency |
| `totalPromptTokens` / `totalCachedTokens` / `totalOutputTokens` | sums over model calls |
| `compactionAttemptCount` | compaction attempts the strategy asked for |
| `successfulCompactionCount` / `failedCompactionCount` | how those attempts turned out |
| `economicAttemptCount` | attempts taken while the decision was `COMPACT` |
| `forcedAttemptCount` | attempts taken while the decision was `FORCE` |
| `forceDecisionCount` | decisions whose action was `FORCE` (FoldPoint only; the baselines have no such concept) |
| `overflowCount` | model calls whose prompt exceeded the window |
| `overflowRecoveryCount` | emergency compactions the host had to run because of an overflow |
| `minRemainingHeadroom` | smallest `window - contextTokens` seen at call time, before any recovery |
| `averageUtilizationAtCompaction` | mean pre-compaction utilization, weighted by attempts |
| `unnecessaryCompactionCount` | **successful** attempts that were not forced and whose realized replay savings until the end of the session did not cover their attempt cost. Failed attempts are reported separately as failures, not double-counted here |
| `meanBreakEvenCallsAtCompaction` | ground-truth `attemptCost / savingPerCall` at the moment of a successful attempt |
| `meanEstimatedBreakEvenCallsAtCompaction` | FoldPoint's own `metrics.breakEvenCalls`, for comparison with the ground truth above |
| `decisionLatencyP50/P95/P99Ms` | wall-clock time around the strategy's decision call |

**Realized saving** for a compaction is accumulated per subsequent model call as
`counterfactualCost - actualCost`, where the counterfactual charges the same call against
`actualPromptTokens + (beforeTokens - afterTokens)` with the same cache coverage as the
actual call. Accumulation stops at the next successful compaction or at the end of the
session. This is a counterfactual, not a subjective label: it answers "would this session
have been cheaper if this compaction had not happened?".

## Determinism

Each scenario has a fixed seed and **two independent streams**: `createRng(seed)` for growth
and `createFailureRng(seed)` (= `createRng(seed ^ 0x9e3779b9)`) for compaction failures. A
strategy that attempts more compactions therefore cannot change the growth sequence other
strategies see. Each strategy also gets a fresh instance per scenario.

Two runs produce identical costs, token counts, attempt counts and decision outcomes; only
`generatedAt` and the latency measurements differ. FoldPoint's decisions are pure functions
of `(input, learning state, session state, options)`.

## Reading the report

- `aggregate` — one row per strategy across all scenarios.
- `perScenario` — the same metrics per (scenario, strategy), so you can see *where* a
  strategy wins or loses. All eleven scenarios are reported for all nine strategies; nothing
  is filtered to make FoldPoint look good.
- `microBenchmark` — 100,000 pure `decideFoldPoint` calls on a fixed input and state. It is
  a measurement, never a pass/fail gate.
- `scenarios` — the ground truth that produced the numbers (prices, TTLs, compactor
  behaviour, horizons), so any result can be reproduced and challenged.

## What the current report shows (aggregate over all 11 scenarios)

| strategy | cost | attempts | ok | failed | econ | forced | unneeded | overflows | min headroom | avg util @ comp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Never | 200.57 | 0 | 0 | 0 | 0 | 0 | 0 | 45 | -32,528 | n/a |
| Fixed 50% raw | 163.83 | 117 | 109 | 8 | 117 | 0 | 86 | 0 | 57,396 | 0.558 |
| Fixed 70% raw | 178.07 | 81 | 76 | 5 | 81 | 0 | 57 | 0 | 43,114 | 0.722 |
| Fixed 80% raw | 184.12 | 66 | 64 | 2 | 66 | 0 | 48 | 0 | 25,106 | 0.823 |
| Fixed 90% raw | 192.54 | 55 | 53 | 2 | 55 | 0 | 39 | 0 | 6,618 | 0.922 |
| Fixed 70% guarded | 178.32 | 66 | 64 | 2 | 39 | 27 | 19 | 0 | 20,149 | 0.807 |
| Fixed 80% guarded | 184.52 | 60 | 58 | 2 | 31 | 29 | 16 | 0 | 18,996 | 0.869 |
| Fixed 90% guarded | 192.54 | 55 | 53 | 2 | 0 | 55 | 0 | 0 | 6,618 | 0.922 |
| **FoldPoint** | **131.31** | 125 | 123 | 2 | 82 | 43 | **5** | **0** | 13,105 | 0.423 |

Read that honestly:

- FoldPoint is the cheapest strategy in aggregate, and it never overflows. The cost
  advantage comes from the cold-cache scenarios (`D`, `E`, `J`), where every call replays the
  whole context at the input price and keeping the context small is directly cheaper: in `D`
  FoldPoint spends 8.66 against 19.93 for the cheapest fixed threshold.
- **FoldPoint also compacts more often than the 70/80/90% baselines** (125 attempts against
  55–81). In the cold-cache scenarios it keeps the context near 12–15% of the window and
  compacts roughly every cooldown period, because each of those compactions individually
  repays itself within about two calls. Fewer compactions would cost more tokens; more
  compactions mean more exposure to potential information loss. The knobs that trade this
  back are `minCallsBetweenCompactions`, `minReclaimRatio` and `softWindowBreakEvenCalls`;
  the trade-off is documented rather than hidden, and the algorithm was not tuned per
  scenario to change it.
- The guarded baselines isolate the effect of the guards: guarded 70% compacts 66 times
  instead of 81 and cuts unnecessary compactions from 57 to 19 at the same cost, so most of
  the raw baselines' churn was the missing cooldown, not the threshold.
- FoldPoint's 5 unnecessary compactions out of 125 attempts (4%) compare with 39–86
  unnecessary out of 55–117 attempts (70–73%) for the raw baselines. Its compactions do
  repay themselves; there are just more of them.
- Scenario `F` (a compactor that reclaims 5%) is the honest counter-example for the
  cold-start prior: FoldPoint still compacts while its learned retention ratio is walking
  from the 0.40 default towards the real 0.95.
- Scenario `K` is where the failure handling shows: half of all attempts fail, and the
  cooldown keeps the retries from turning into a storm.

## Conclusion discipline

The numbers above may only be used to claim simulated cost, compaction counts, failures,
window overflows and economically unrepaid compactions.

**Fewer compactions reduce the number of exposures to potential information loss, but that
does not prove better task quality.** The benchmark says nothing about whether a compaction
kept the information a task needed, nothing about answer accuracy, and nothing about real
provider cache behaviour.
