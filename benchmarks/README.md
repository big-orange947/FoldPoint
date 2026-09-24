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
3. how many of its compactions were not economically repaid — measured against an
   independent counterfactual, not an approximation;
4. does it keep the window safe when a compactor is unreliable.

It does **not** measure task quality, answer accuracy or information retention — see
[Conclusion discipline](#conclusion-discipline).

## Files

| File | Contents |
| --- | --- |
| `scenarios.ts` | the eleven scenarios, their ground truth, the growth schedule, the two RNG streams |
| `fixed-threshold.ts` | the strategy interface, raw baselines, guarded baselines |
| `simulator.ts` | the session loop, both branches, FoldPoint wiring, metrics, tables, JSON report, micro-benchmark |
| `reports/benchmark-report.json` | the raw report of the last run |

## Simulation model

One simulated session is a loop over steps. Every strategy goes through exactly the same
loop; the only difference is the decision it returns.

1. The step's new tokens are appended to the context, from the scenario's growth schedule.
2. The strategy decides `KEEP` / `COMPACT` / `FORCE` from the metadata a host would have.
3. On `COMPACT`/`FORCE` a compaction **attempt** happens. It succeeds with probability
   `successRate` (failure RNG). The attempt is always billed
   (`costOfUsage(prices, { promptTokens: beforeTokens, outputTokens })`). On success the
   context becomes `round(beforeTokens * retentionRatio)` and the provider cache is
   invalidated; on failure the context is unchanged, no cache prefix is built and no
   counterfactual branch is opened.
4. The model call is charged with `costOfCall`, the same helper the engine uses. Caching is
   "in play" when the scenario has a cache discount and a cache policy. Then:
   - a call whose prefix is alive pays the cache-read price for the previously cached part and
     the plain input price for the appended tail;
   - a call that has to (re)build a prefix — the first call, the first call after a successful
     compaction, and any call whose prefix has lapsed — writes its **whole prompt** at the
     cache-write price;
   - a call with no prefix at all writes its prompt too: there is nothing to read from.
   Without a cache discount the prompt is plain input and no write premium is invented.
   `Pwrite` defaults to `Pin`, so a scenario without a cache-write price bills such calls as
   plain input.
5. After a successful call the provider holds a cache for that whole prompt. The cache stays
   alive while the idle gap before the next call is below the scenario's TTL and no successful
   compaction has rebuilt the prefix since. A scenario may vary the idle gap with
   `idleMsAfterStep`.
6. FoldPoint additionally receives `observeRequest`, `recordCompaction` (with the real
   `success` flag) and `endSession` events. The baselines ignore them.

The simulator and the engine use the same `costOfCall` / `costOfUsage` / `resolveUnitPrices`
helpers, the same `estimateCacheModel` forecast and the core `computeBreakEvenCalls`, so there
is no second formula anywhere in the project.

**Ground truth is hidden.** The compactor's real retention ratio, the real failure rate, the
real cache behaviour and the real prices never reach a strategy except through the
host-style observations above. FoldPoint never sees `retentionRatio`; it learns it.

**Overflow (actual branch).** A call whose prompt exceeds the context window is an overflow:
the host is forced to compact at the worst possible moment and pays for that recovery. The
overflow is counted, and `minRemainingHeadroom` is measured *before* the recovery.

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

## Counterfactual accounting (the "unnecessary compaction" metric)

A compaction is only worth judging if we can say what the session would have cost without it.
Approximating that with "the actual cache coverage applied to a counterfactual prompt" is wrong:
the counterfactual branch has its own cache history. So every successful, non-forced compaction
opens an **independent shadow branch**:

```
CounterfactualState {
  contextTokens      // the pre-compaction context
  lastPromptTokens   // that branch's own last prompt
  lastCallAt         // that branch's own last call time
  cacheHeld          // that branch's own cache state
  rebuildingCache    // that branch's own rebuild flag
  cumulativeCost     // that branch's own call costs
}
```

From the next step on:

1. the actual branch runs on the compacted context with its own cache;
2. the shadow branch receives **exactly the same growth**;
3. the shadow branch decides its own cache state from its own `lastPromptTokens`, `lastCallAt`
   and the scenario's TTL;
4. both branches price their own call separately with the same price snapshot;
5. at the next successful compaction, or at the end of the session, the interval settles:
   `realizedSaving = shadowCumulativeCost - actualIntervalCallCost - attemptCost`;
6. a judged compaction is **unnecessary** when `realizedSaving < 0`.

Only model call costs enter the interval comparison, symmetrically on both sides. Failed
attempts inside an interval are reported separately (attempt/failure counts, and their cost in
the session total) rather than charged to an earlier compaction.

**Shadow overflow rule.** If the shadow branch — the "we did not compact here" world — would
run past the context window during the interval, that compaction is **never** counted as
unnecessary, because the alternative was not actually available. The shadow branch simulates an
emergency recovery and that recovery is recorded as a *counterfactual* cost inside
`shadowCumulativeCost`. Each record exposes `shadowOverflowed` so the rule is auditable. (In
the current scenarios this guard rarely changes a verdict, because a shadow that overflows is
usually also more expensive; the rule is enforced and tested regardless.)

Forced compactions are never judged (there was no economic choice), and neither are failed
attempts. `judgedCompactionCount` reports how many compactions the metric actually covers.

## Metric definitions

| Metric | Definition |
| --- | --- |
| `totalSimulatedCost` | every model call, every compaction attempt and every overflow recovery, in the scenario's currency |
| `totalPromptTokens` / `totalCachedTokens` / `totalOutputTokens` | sums over model calls |
| `totalOfferedGrowthTokens` | sum of every growth value the scenario offered — strategy-independent by construction |
| `growthSequenceFingerprint` | FNV-1a fingerprint of the offered growth sequence, for auditing fairness |
| `compactionAttemptCount` | compaction attempts the strategy asked for |
| `successfulCompactionCount` / `failedCompactionCount` | how those attempts turned out |
| `economicAttemptCount` | attempts taken while the decision was `COMPACT` |
| `forcedAttemptCount` | attempts taken while the decision was `FORCE` |
| `forceDecisionCount` | decisions whose action was `FORCE` (FoldPoint only; the baselines have no such concept) |
| `overflowCount` / `overflowRecoveryCount` | calls whose prompt exceeded the window, and the emergency compactions the host had to run because of them |
| `minRemainingHeadroom` | smallest `window - contextTokens` seen at call time, before any recovery |
| `averageUtilizationAtCompaction` | mean pre-compaction utilization, weighted by attempts |
| `judgedCompactionCount` | successful, non-forced compactions whose counterfactual payback was measured |
| `unnecessaryCompactionCount` | judged compactions with `realizedSaving < 0`, excluding any whose shadow branch overflowed |
| `meanStaticBreakEvenCallsAtCompaction` | mean of `computeBreakEvenCalls({ C_now, C_later, K, F, L })` at the moment of a successful attempt. **A local static approximation** — it assumes the context does not keep growing — not the session's real payback. The dynamic answer comes from the shadow branch |
| `meanFoldPointEstimatedBreakEvenCallsAtCompaction` | FoldPoint's own `metrics.breakEvenCalls` at the same moment, for comparison |
| `decisionLatencyP50/P95/P99Ms` | wall-clock time around the strategy's decision call |

The static inputs are recorded per compaction (`staticBreakEvenInputs`) so any value can be
recomputed with the exported solver. They are the core's rule evaluated on the inputs the host
reports, plus the hit rate this host has observed: `C_now` is this call as it really is
(including a write when the prefix is not alive), `C_later` is the forecast for the calls after
it, `K` is the attempt cost, `F` is the post-compaction prefix write, and `L` follows from the
scenario's policy and the same `laterCandidateTokens` / `laterAliveProbability` the engine uses.
Model output tokens are excluded from all five because they are identical on both sides and
cancel.

`C_now` and `C_later` are separate on purpose, and so are the prefixes they use. A call that
finds the cache lapsed writes its whole prompt at the cache-write price; the later calls it
enables do not have to, and the forecast neither inherits this call's verdict nor reuses its
served-token count. In a scenario where every gap exceeds the TTL, the observed hit rate falls
to zero, so both are priced as writes and the model still sees the true regime.

## Determinism and fairness auditing

Each scenario has a fixed seed and **two independent streams**: `createRng(seed)` for growth
and `createFailureRng(seed)` (= `createRng(seed ^ 0x9e3779b9)`) for compaction failures. The
growth schedule is materialized once, from a single RNG advanced step by step
(`buildGrowthSequence`), so a strategy that attempts more compactions cannot change the growth
anyone else sees. Each strategy also gets a fresh instance per scenario.

Every run reports `totalOfferedGrowthTokens` and `growthSequenceFingerprint`. The benchmark
tests assert that all nine strategies of a scenario agree on both, that failure RNG consumption
does not change them, that the same seed reproduces the same run and that a different seed
produces a different fingerprint.

Two runs produce identical costs, token counts, attempt counts and decision outcomes; only
`generatedAt` and the latency measurements differ. FoldPoint's decisions are pure functions of
`(input, learning state, session state, options)`.

## Reading the report

- `aggregate` — one row per strategy across all scenarios.
- `perScenario` — the same metrics per (scenario, strategy), so you can see *where* a strategy
  wins or loses. All eleven scenarios are reported for all nine strategies; nothing is filtered
  to make FoldPoint look good.
- `growth` — the fingerprint and total of each scenario's offered growth.
- `counterfactual` — a one-line statement of the rule above, stored with the numbers.
- `microBenchmark` — 100,000 pure `decideFoldPoint` calls on a fixed input and state. It is a
  measurement, never a pass/fail gate.
- `scenarios` — the ground truth that produced the numbers (prices, TTLs, compactor behaviour,
  horizons), so any result can be reproduced and challenged.

## What the current report shows (aggregate over all 11 scenarios)

| strategy | cost | attempts | ok | failed | econ | forced | judged | unneeded | overflows | min headroom | avg util @ comp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Never | 217.82 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 45 | -32,528 | n/a |
| Fixed 50% raw | 170.93 | 117 | 109 | 8 | 117 | 0 | 109 | 89 | 0 | 57,396 | 0.558 |
| Fixed 70% raw | 189.33 | 81 | 76 | 5 | 81 | 0 | 76 | 44 | 0 | 43,114 | 0.722 |
| Fixed 80% raw | 197.73 | 66 | 64 | 2 | 66 | 0 | 64 | 35 | 0 | 25,106 | 0.823 |
| Fixed 90% raw | 208.35 | 55 | 53 | 2 | 55 | 0 | 53 | 29 | 0 | 6,618 | 0.922 |
| Fixed 70% guarded | 191.32 | 66 | 64 | 2 | 39 | 27 | 37 | 7 | 0 | 20,149 | 0.807 |
| Fixed 80% guarded | 199.07 | 60 | 58 | 2 | 31 | 29 | 30 | 4 | 0 | 18,996 | 0.869 |
| Fixed 90% guarded | 208.35 | 55 | 53 | 2 | 0 | 55 | 0 | 0 | 0 | 6,618 | 0.922 |
| **FoldPoint** | **136.37** | 121 | 119 | 2 | 80 | 41 | 80 | **7** | **0** | 6,618 | 0.434 |

Read that honestly:

- FoldPoint is the cheapest strategy in aggregate, and it never overflows. The cost advantage
  comes from the scenarios where the cache does not save the session (`D`, `E`, `J`), where
  every call replays the whole context and keeping the context small is directly cheaper: in
  `D` FoldPoint spends 9.57 against 23.67 for the cheapest fixed threshold, in `E` 5.90 against
  18.16, in `J` 7.30 against 17.09.
- **FoldPoint also compacts more often than the 70/80/90% baselines** (121 attempts against
  55–81). In the cold-cache scenarios it keeps the context near 12–15% of the window and
  compacts roughly every cooldown period, because each of those compactions repays itself.
  Fewer compactions would cost more tokens; more compactions mean more exposure to potential
  information loss. The knobs that trade this back are `minCallsBetweenCompactions`,
  `minReclaimRatio` and `softWindowBreakEvenCalls`; the trade-off is documented rather than
  hidden, and the algorithm was not tuned per scenario to change it.
- The guarded baselines isolate the effect of the guards: guarded 70% compacts 66 times instead
  of 81 and cuts unnecessary compactions from 44 to 7 at the same cost, so most of the raw
  baselines' churn was the missing cooldown, not the threshold.
- FoldPoint's 7 unnecessary compactions out of 80 judged (9%) compare with 29–89 out of 53–109
  (55–82%) for the raw baselines and 4–7 out of 30–37 (11–19%) for the guarded ones.
- Scenario `F` (a compactor that reclaims 5%) is the honest counter-example for the cold-start
  prior: FoldPoint still compacts while its learned retention ratio is walking from the 0.40
  default towards the real 0.95, and it is not the cheapest strategy there (59.20 against 53.24
  for the 50% baseline). It is also not the cheapest in `B` (6.45 against 6.21), `G` (21.05
  against 19.10) or `K` (9.37 against 8.92 for the guarded 70% baseline). In `B`, `C`, `G`, `H`
  and `K` every compaction it runs is a window-safety `FORCE`: the model judges that the cache
  makes keeping cheap enough that no economic compaction is repaid.
- Scenario `K` is where the failure handling shows: half of all attempts fail, and the cooldown
  keeps the retries from turning into a storm.

### Withdrawn from earlier revisions

The earlier report measured "unnecessary compactions" with an approximation (the actual cache
coverage applied to a counterfactual prompt) and quoted `meanBreakEvenCallsAtCompaction` as if
it were a ground-truth payback. Both are withdrawn:

- the metric is now measured against the shadow branch described above, and it is stricter:
  FoldPoint moved from 5 to 6 unnecessary compactions, from a 4% to a 7% rate over the judged
  set;
- the static metric is renamed `meanStaticBreakEvenCallsAtCompaction` because it is a local,
  static estimate, not the session's dynamic payback. The dynamic answer is the shadow branch's
  `realizedSaving`.

The billing semantics were unified afterwards (FoldPoint 136.44 → 136.00 in aggregate):

- a call that rebuilds a lapsed prefix is billed at the cache-write price. Earlier revisions
  billed the *current* call at the plain input price while the simulator billed it at the write
  price, so the engine under-stated what keeping a lapsed context costs;
- the keep cost used to be `horizon × currentReplayCost`, which charged every future call as if
  it too would find the cache gone. The current call and the later calls are now priced
  separately (`C_now` and `C_later`), and the break-even is
  `1 + (K + F - C_now) / (C_later - L)`;
- a prompt is only billed at the write price when caching is in play, so a profile without a
  cache discount (scenario `J`) is priced as plain input on both sides.

Two bugs in that revision were fixed after review (FoldPoint 136.00 → 136.37, 125 → 121
attempts, 6 → 7 unneeded of 80 judged):

- the later-call candidate reused this call's served-token count, so a host that reported
  `cachedTokens: 0` for a lapsed prefix — the behaviour
  [docs/integration.md](../docs/integration.md) asks for — had every future call priced as a
  rewrite. The reusable prefix is now its own quantity, and both reporting styles reach the
  same decision;
- `computeBreakEvenCalls` returned `null` as soon as `C_later - L <= 0`, which reported "no
  recurring saving" as "never worth it" even when the compaction was already cheaper than the
  current call alone. Immediate repayment is now checked first.

The corrected economics make FoldPoint compact less often in the warm scenarios (`B`, `C`,
`H`, `K` now run no economic compaction at all) and more often in the churn scenario `I`. The
numbers in the table above are the current ones; the earlier 136.00 / 6 of 82 rows are
withdrawn with the bugs.

## Conclusion discipline

These results may be described as **a reproducible cost comparison over synthetic scenarios**.
7 of 80 judged compactions did not repay themselves *within these scenarios and their
settlement intervals*; the costs, counts and overflows reproduce exactly from the committed
seeds.

**Task quality and real provider traces still need separate validation.** The benchmark says
nothing about whether a compaction kept the information a task needed, nothing about answer
accuracy, and nothing about how a real provider's cache actually behaves. Fewer compactions
reduce the number of exposures to potential information loss without proving better task
quality.
