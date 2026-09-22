# FoldPoint simulation benchmark

```bash
npm run benchmark
```

Runs ten deterministic simulated agent sessions against five baselines and FoldPoint, prints
two tables, and writes the raw report to
[`reports/benchmark-report.json`](reports/benchmark-report.json).

The goal of v0.1 is **not** to prove that FoldPoint improves real task quality. It is to
check four things:

1. does it compact less often than a fixed threshold when compaction is not worth it;
2. does it cost less in the scenarios where a fixed threshold is clearly wrong;
3. does it ever let the window overflow;
4. does it avoid compaction churn.

## Files

| File | Contents |
| --- | --- |
| `scenarios.ts` | the ten scenarios, their ground truth and the seeded RNG |
| `fixed-threshold.ts` | the strategy interface, `never` and the fixed 50/70/80/90% baselines |
| `simulator.ts` | the session loop, FoldPoint wiring, metrics, tables, JSON report, micro-benchmark |
| `reports/benchmark-report.json` | the raw report of the last run |

## Simulation model

One simulated session is a loop over steps. Every strategy goes through exactly the same
loop; the only difference is the decision it returns.

1. The step's new tokens are appended to the context (seeded growth plus any sudden jump).
2. The strategy decides `KEEP` / `COMPACT` / `FORCE` from the metadata a host would have.
3. On `COMPACT`/`FORCE` the simulated compactor runs: it costs `beforeTokens * inputPrice +
   round(beforeTokens * outputRatio) * outputPrice`, produces
   `round(beforeTokens * retentionRatio)` tokens, and invalidates the provider cache.
4. The model call is charged: `(prompt - cached) * inputPrice + cached * cachePrice +
   outputTokens * outputPrice`.
5. After a successful call the provider holds a cache for that whole prompt. The cache stays
   alive while the idle gap is below the scenario's TTL and no compaction has rebuilt the
   prefix.
6. FoldPoint additionally receives `observeRequest`, `recordCompaction` and `endSession`
   events. The baselines ignore them.

**Ground truth is hidden.** The compactor's real retention ratio, the real cache behaviour
and the real prices never reach a strategy except through the host-style observations above.
FoldPoint never sees the scenario's `retentionRatio`; it learns it from `recordCompaction`.

**Overflow.** A call whose prompt exceeds the context window is an overflow: the provider
rejects it, the host is forced to compact at the worst possible moment, and the strategy pays
for that emergency recovery. The overflow is counted, and `minRemainingHeadroom` is measured
*before* the recovery, so an overflow shows up as a negative headroom.

**Baselines.** `fixed-50/70/80/90` compact as soon as utilization reaches the threshold and
deliberately get no cooldown and no minimum-reclaim gate — they are the naive comparison
point, so their churn has to be visible. `never` never compacts.

**Scenarios.** Each scenario isolates one variable. `E`/`F` use a cold cache so that
compactor quality is the only thing that changes between them, and `C`/`D` use the same warm
and cold cache with a very cheap cache read.

| id | name | what it isolates |
| --- | --- | --- |
| A | short-task | tiny session: nobody should compact |
| B | long-tool-task | steady growth with a stable, replayed prefix |
| C | cache-alive | warm cache, very cheap cache reads, short idle gaps |
| D | cache-expired | idle gaps beyond the TTL: the prefix is plain input again |
| E | good-compactor | retention 0.25 |
| F | bad-compactor | retention 0.95 |
| G | expensive-compaction | large, expensive compaction output |
| H | sudden-growth | one step adds a huge tool output |
| I | compaction-churn | the context regrows fast after every compaction |
| J | no-cache-discount | cache reads cost the same as plain input |

Scenarios that plausibly know their remaining budget declare `hostHorizon` (the host's
`expectedFutureCalls`); scenario A does not, so the cold-start path is exercised too.

## Metric definitions

| Metric | Definition |
| --- | --- |
| `totalSimulatedCost` | every model call, every compaction call and every overflow recovery, in the scenario's currency |
| `totalPromptTokens` / `totalCachedTokens` / `totalOutputTokens` | sums over model calls (the overflow recovery is a compaction, not a call) |
| `compactionCount` | compactions the strategy asked for |
| `forcedCompactionCount` | compactions that happened while pre-compaction `utilization >= 0.90` (the library's default hard window ratio) — a strategy-independent, operational definition |
| `forceDecisionCount` | decisions whose action was `FORCE` (FoldPoint only; other strategies have no such concept) |
| `overflowCount` | model calls whose prompt exceeded the window |
| `overflowRecoveryCount` | emergency compactions the host had to run because of an overflow |
| `minRemainingHeadroom` | smallest `window - contextTokens` seen at call time, measured before any recovery |
| `averageUtilizationAtCompaction` | mean pre-compaction utilization, weighted by compactions |
| `unnecessaryCompactionCount` | compactions that were **not** forced and whose realized replay savings until the end of the session did not cover their compaction cost |
| `meanBreakEvenCallsAtCompaction` | ground-truth `compactionCost / (counterfactualPerCallCost - actualPerCallCost)` at the moment of the compaction, over all compactions with a positive per-call saving |
| `meanEstimatedBreakEvenCallsAtCompaction` | FoldPoint's own `metrics.breakEvenCalls`, for comparison with the ground truth above |
| `decisionLatencyP50/P95/P99Ms` | wall-clock time around the strategy's decision call |

**Realized saving** for a compaction is accumulated per subsequent model call as
`counterfactualCost - actualCost`, where the counterfactual charges the same call against
`actualPromptTokens + (beforeTokens - afterTokens)` with the same cached-token coverage ratio
as the actual call. Accumulation stops at the next compaction or at the end of the session.
This is a counterfactual, not a subjective label: it answers "would this session have been
cheaper if this compaction had not happened?".

A forced compaction that prevents an overflow can still be economically unnecessary by this
definition; it is excluded from the unnecessary count precisely because it was not a free
choice.

## Determinism

Every scenario has a fixed seed and its own `mulberry32` stream, and each strategy gets a
fresh instance per scenario. Two runs produce identical costs, token counts, compaction
counts and decision outcomes; only `generatedAt` and the latency measurements differ.
FoldPoint's decisions are pure functions of `(input, state, options)`, so there is no hidden
state anywhere in the pipeline.

## Reading the report

- `aggregate` — one row per strategy across all scenarios; this is the headline table.
- `perScenario` — the same metrics per (scenario, strategy), so you can see *where* a
  strategy wins or loses.
- `microBenchmark` — 100,000 pure `decideFoldPoint` calls on a fixed input and state. It is
  a measurement, never a pass/fail gate.
- `scenarios` — the ground truth that produced the numbers (prices, TTLs, compactor
  behaviour, horizons), so any result can be reproduced and challenged.

## Honest notes

- **FoldPoint does not win everything.** `fixed-50` has the lowest raw cost in the aggregate
  and FoldPoint does not beat it on cost; FoldPoint's advantage there is 4 unnecessary
  compactions against 80. See the README table.
- **In the warm-cache scenarios FoldPoint behaves like a wall-only policy.** That is the
  intended answer: with a cheap, alive cache, keeping is nearly free and compaction is not
  worth it.
- **A cold-start profile with a bad compactor compacts a few times more than it should**
  before learning. Scenario F shows it: 4 of 29 compactions are economically unjustified,
  all of them early.
- **The simulator is a model, not a provider.** It charges a full prompt replay per call,
  assumes the provider caches the whole prompt, and treats a cache miss as binary. Real
  providers are messier.
