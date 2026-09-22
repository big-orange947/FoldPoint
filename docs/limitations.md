# FoldPoint limitations

Everything below is a real limitation of v0.1, not a to-do list. They are the honest
consequences of the design constraints: no content, no extra model calls, no I/O, O(1)
decisions.

- [1. It cannot judge semantic quality](#1-it-cannot-judge-semantic-quality)
- [2. The future is estimated, not known](#2-the-future-is-estimated-not-known)
- [3. The learned compaction cost is an absolute value](#3-the-learned-compaction-cost-is-an-absolute-value)
- [4. The cost model is a short-horizon approximation](#4-the-cost-model-is-a-short-horizon-approximation)
- [5. Provider cache behaviour is a probability](#5-provider-cache-behaviour-is-a-probability)
- [6. Compactors differ, and learning is slow](#6-compactors-differ-and-learning-is-slow)
- [7. The cold-start prior can be wrong](#7-the-cold-start-prior-can-be-wrong)
- [8. Cheap is not better](#8-cheap-is-not-better)
- [9. The benchmark is a simulation](#9-the-benchmark-is-a-simulation)
- [10. Numeric guards are not semantics](#10-numeric-guards-are-not-semantics)
- [11. What v0.1 deliberately does not do](#11-what-v01-deliberately-does-not-do)

## 1. It cannot judge semantic quality

FoldPoint never reads the context, so it cannot know whether a compaction dropped the one
detail the task needed. It reduces that risk structurally, not semantically:

- a cooldown between compactions;
- a minimum reclaim (both absolute and relative);
- a requirement that the host is at a safe boundary;
- a window reserve and a hard window ratio;
- a preference for `KEEP` whenever the economics are not clearly positive.

If a host needs semantic protection, it must add it — for example by refusing compaction
inside a critical tool call (`compactionAllowed: false`) or by using a compactor that keeps
the information that matters. FoldPoint will respect that decision.

## 2. The future is estimated, not known

`expectedFutureCalls` is the host's claim about how many calls remain. FoldPoint can learn a
rough horizon from `endSession`, but within a single session it cannot know whether the task
has 3 calls or 300 left, and it is explicitly forbidden from guessing that from content.

Two consequences:

- with no host horizon and no history, the default horizon is 3 calls, so FoldPoint behaves
  conservatively and mostly waits for the window guard;
- if the host overstates the horizon, FoldPoint will compact more often than it should. The
  `callsUntilRefill` cap bounds the damage (a compaction's benefit cannot outlive the tokens
  it reclaimed) but does not remove the problem.

## 3. The learned compaction cost is an absolute value

`compactionCostEma` stores the cost of one compaction call in the profile's currency, as it
was observed. If the context was 40k tokens when it was learned and is 180k now, the stored
number is too low. FoldPoint prefers the learned value anyway (it is real data), so an old
profile can under-estimate the cost of a large compaction.

Mitigations: the cost EMA keeps following new observations, the cold-start estimate is used
until the first real sample exists, and the uncertainty penalty still applies. A host that
knows its prices can also reset a profile (`resetProfile`) after a major model or price
change.

Units matter too: mixing `actualCost` in USD with `tokenOnlyPricing()` in tokens makes the
EMA meaningless. Pick one convention per profile.

## 4. The cost model is a short-horizon approximation

FoldPoint compares "keep for R calls" against "compact now, then replay for R calls". It does
not solve an optimal control problem:

- it does not model what happens after those R calls;
- it does not model future compactions inside the horizon (the `callsUntilRefill` cap is a
  heuristic answer to exactly this);
- it assumes the cached fraction of the context stays roughly the same as it is now;
- it does not model output tokens of the *agent's* future calls, only replay cost.

The formulas are published in [algorithm.md](algorithm.md) precisely so that a host can
disagree with them and tune the defaults.

## 5. Provider cache behaviour is a probability

Even with an unchanged prefix, a provider cache may miss. FoldPoint estimates survival from
`cacheExpiresAt`, a configured TTL, a half-life, or the learned cache-hit ratio — it never
probes the provider, never compares prefixes, never hashes content, and never queries an
external cache. Treat `estimatedCacheSurvival` as a belief, not as state.

Note also that `estimatedCacheSurvival` is reported even when `cachedTokens` is 0 (the
current prompt simply has nothing cached), where it has no effect on cost. Reason codes for
the cache are only emitted when the profile has cache evidence (cached tokens now, or a
learned history).

## 6. Compactors differ, and learning is slow

Different compactors produce very different retention ratios, and the same compactor varies
by task and phase. That is why state is isolated per `compactorId`, and why FoldPoint uses a
conservative prior rather than assuming the best case.

EMA learning (`alpha = 0.25`) means it takes several compactions before the estimate
approaches reality. A brand-new profile with a very weak compactor will compact a few times
more than it should before it learns — this is visible in scenario F of the benchmark
(4 economically unjustified compactions out of 29, all early in the session).

Failed compactions do not update the retention ratio at all, and v0.1 does not build a
failure-prediction model: it only counts them.

## 7. The cold-start prior can be wrong

The default `retentionRatio = 0.40` assumes a decent compactor. With a bad one, the first
compactions are justified by an assumption that turns out to be false. The uncertainty
penalty (`0.15` of the compaction cost, doubled below the soft window) and the confidence
floor (`0.35`) make that window as small as possible without making FoldPoint useless on a
fresh profile, but they do not eliminate it.

## 8. Cheap is not better

FoldPoint optimises *when* to compact. It has no opinion about the quality of the summary a
compactor produces, and "fewer tokens" is not the same as "better task outcome". A host that
finds FoldPoint's decisions too aggressive should raise `uncertaintyPenalty`, raise
`minReclaimRatio`, or set `compactionAllowed: false` in the phases where context matters
most; a host that finds them too passive should provide a real horizon and real prices.

## 9. The benchmark is a simulation

`npm run benchmark` runs a deterministic simulation of agent sessions with synthetic ground
truth. It validates that the algorithm behaves sensibly (fewer unnecessary compactions than
fixed thresholds, no window overflow, no churn, cheaper when the cache is gone), and it
measures decision latency. It does **not** prove anything about real task quality, real
provider cache behaviour, or real compactor output — those need production telemetry that
v0.1 deliberately does not collect.

The simulator charges an overflow call as a forced emergency compaction plus a counted
overflow, and it reports strategies honestly, including where a fixed threshold beats
FoldPoint (see `fixed-50` on raw cost in the README table).

## 10. Numeric guards are not semantics

`retentionRatio ∈ [0.05, 1]`, `compactOutputRatio ∈ [0, 1]`, `breakEvenCalls = null` when
there is no positive saving, and `Number.MAX_SAFE_INTEGER` for an overflowing break-even are
numerical safety nets. They exist so the formulas stay finite and monotone; they are not
statements about the world.

One asymmetry is worth knowing about: the current context is charged with its *known* cached
tokens, while the post-compaction context is charged with a uniform `qNew` for all of its
tokens. That means a compaction can show a small positive per-call saving even when it
reclaims nothing (`r = 1`) if the current context has a large uncached tail. In practice the
minimum-reclaim gate blocks that case (a compactor with `r = 1` reclaims 0 tokens), but a
host that sets `minReclaimTokens: 0` and `minReclaimRatio: 0` can reach it.

## 11. What v0.1 deliberately does not do

No summarization, no message pruning, no prompt rewriting, no tool-output pruning, no
embeddings, no vector search, no RAG, no long-term memory, no content or task classification,
no UI, no HTTP server, no database, no telemetry, no price fetching, no agent orchestration,
no Pi/dsh/MemoEcho plugins, no basic/pro/enterprise algorithm tiers, no machine-learned
predictor, no LLM in the decision path, and no scenario-specific branches.
