# FoldPoint limitations

Everything below is a real limitation of v0.1, not a to-do list. They are the honest
consequences of the design constraints: no content, no extra model calls, no I/O, O(1)
decisions.

- [1. It cannot judge semantic quality](#1-it-cannot-judge-semantic-quality)
- [2. The future is estimated, not known](#2-the-future-is-estimated-not-known)
- [3. The cost model is a short-horizon approximation](#3-the-cost-model-is-a-short-horizon-approximation)
- [4. Provider cache behaviour is a probability](#4-provider-cache-behaviour-is-a-probability)
- [5. Compactors differ, and learning is slow](#5-compactors-differ-and-learning-is-slow)
- [6. The cold-start prior can be wrong](#6-the-cold-start-prior-can-be-wrong)
- [7. Cheap is not better](#7-cheap-is-not-better)
- [8. Session identity is the host's responsibility](#8-session-identity-is-the-hosts-responsibility)
- [9. The benchmark is a simulation](#9-the-benchmark-is-a-simulation)
- [10. Numeric guards are not semantics](#10-numeric-guards-are-not-semantics)
- [11. What v0.1 deliberately does not do](#11-what-v01-deliberately-does-not-do)

## 1. It cannot judge semantic quality

FoldPoint never reads the context, so it cannot know whether a compaction dropped the one
detail a task needed. It reduces that risk structurally, not semantically: a cooldown between
attempts, a minimum reclaim (absolute and relative), a required safe boundary, a window
reserve, and a preference for `KEEP` whenever the economics are not clearly positive.

A host that needs semantic protection must add it — for example by refusing compaction inside
a critical tool call (`compactionAllowed: false`) or by using a compactor that keeps what
matters. FoldPoint will respect that decision, and `FORCE` is the only case where it will
insist that the window itself is at risk.

## 2. The future is estimated, not known

`expectedFutureCalls` is the host's claim about the calls that remain. FoldPoint can learn a
rough horizon from `endSession`, but inside a single session it cannot know whether the task
has 3 calls or 300 left, and it is explicitly forbidden from guessing that from content.

Two consequences:

- with no host horizon and no history, the default horizon is 3 calls, so FoldPoint behaves
  conservatively and mostly waits for the window guard;
- a host that overstates its horizon (for example by reporting a constant "20 calls remain"
  for a session with 200 steps left) makes every compaction look more valuable than it is,
  and FoldPoint will compact more often. The benchmark's simulator caps the declared horizon
  by the steps the session really has left for exactly this reason.

## 3. The cost model is a short-horizon approximation

FoldPoint compares "keep for R calls" against "compact now, then replay for R calls". It does
not solve an optimal control problem:

- it does not model what happens after those R calls;
- it does not model further compactions inside the horizon (the quick-payback guard limits
  how far a compaction may look below the soft window, but nothing bounds it above);
- it assumes the cached share of the context stays roughly what it is now;
- it does not model the output tokens of the agent's future calls, only replay cost.

The formulas are published in [algorithm.md](algorithm.md) so a host can disagree with them
and tune the defaults.

## 4. Provider cache behaviour is a probability

Even with an unchanged prefix a provider cache may miss. FoldPoint estimates aliveness from
an exact expiry, a configured TTL, a half-life, or simply assumes the candidate prefix is
alive when nothing is known about expiry. It never probes the provider, never compares
prefixes, never hashes content and never queries an external cache. Treat
`estimatedCacheAliveProbability` as a belief, not as state.

The coverage ratio has its own limitation: when the host does not report `cachedTokens`,
FoldPoint uses the learned average coverage, which cannot know that *this* prompt is the
first one after a long tool output.

The first real trace quantifies that. On DeepSeek the cache is automatic and cheap
(`cacheRead` 0.006 against `input` 0.30 per million), so per-call coverage swings between 0.16
and 0.99 depending on how much new text the call carries. A `cacheCoverageRatioEma` with
`alpha = 0.25` cannot track that: over ten decisions it walked 0 → 0.88 while the truth was
0.95–0.99, and the predicted cost of a call stayed 8–22× above the real one, improving slowly.
The number is honest, the shape is wrong — coverage is a property of the *last delta*, not of
the profile. Treat the call-cost error on an automatically cached provider as a known model
error until the estimator is given a better coverage input.

The forecast for the calls *after* the current one is a belief too, and it is deliberately
separate from the current call's verdict: a lapsed TTL says this request has to write its
prefix, not that every later request will. The model keeps the smooth form of a half-life
policy and otherwise assumes the prefix the current call writes survives. A host whose gaps
reliably exceed its TTL should describe that regime with a half-life policy, or report no
served prefix, rather than expect FoldPoint to infer it from one lapsed gap.

The prefix a later call can reuse is estimated rather than observed: the largest prefix the
evidence supports (what this call was served, the learned coverage, or the prompt just sent).
In a session where the cache never serves anything the learned coverage falls to zero and the
future is priced as rewrites, but a single lapsed call in an otherwise healthy session does not
make the whole future look like a rewrite. Treat `estimatedCacheLaterCandidateTokens` as an
estimate with that bias, not as state.

## 5. Compactors differ, and learning is slow

Different compactors produce very different retention ratios, and the same compactor varies
by task and phase. State is isolated per `compactorId` for that reason.

EMA learning (`alpha = 0.25`) means several successful compactions are needed before the
estimate approaches reality, and a profile whose compactor fails often learns nothing from
the failures at all (by design — a failure says nothing about compression quality).

## 6. The cold-start prior can be wrong

The default `retentionRatio = 0.40` assumes a decent compactor. With a bad one, the first
economic compactions are justified by an assumption that turns out to be false. The
uncertainty penalty, the confidence floor and the minimum reclaim gate make that window as
small as possible without making FoldPoint useless on a fresh profile, but they do not
eliminate it. Benchmark scenario `F` shows it: FoldPoint keeps compacting while its learned
retention ratio walks from 0.40 towards the real 0.95.

The first real trace (Pi + DeepSeek, 7 compactions in one session) shows the same walk in the
other direction: the learned reclaim ratio fell from 0.60 to 0.489 over seven samples, against
a real retention of ~0.52, so it converged within the session. Retention is learnable in a way
the per-call cache coverage is not (see §4).

## 6.1 A host may not let you decide every call

Pi reports `getContextUsage().tokens = null` until an assistant message after a compaction
reports usage, so the first call after every compaction has no known context size. An
observe-only adapter must not invent one, so it records that call's real usage under a
`#unpaired-N` label and makes no prediction for it. In the first real session that was 7 of 16
calls — and they are the calls where the compaction decision matters most, because they are the
first replay of the new prefix.

An acting integration has the same hole: whatever decides whether to compact cannot be asked
about that call either. Anything FoldPoint does on Pi is therefore decided one call *before* the
compaction takes effect, which is fine for a keep/compact choice at a boundary but means the
post-compaction replay is never itself a decision point.

## 7. Cheap is not better

FoldPoint optimises *when* to compact, not what the summary contains, and "fewer tokens" is
not "better task outcome". Two honest caveats from the benchmark:

- in the cold-cache scenarios FoldPoint keeps the context near 12–15% of the window and
  compacts roughly every cooldown period. Each of those compactions repays itself within
  about two calls, and the session is about 2.3x cheaper than the best fixed threshold — but
  it is also **more** compactions than the 70/80/90% baselines make, which means more
  exposures to potential information loss;
- a host that prefers fewer compactions should raise `minCallsBetweenCompactions` or
  `minReclaimRatio`, lower `softWindowBreakEvenCalls`, or set `compactionAllowed: false` in
  the phases where context matters most. All of those are configuration, not new code.

## 8. Session identity is the host's responsibility

`sessionId` must be stable and unique per session. Two sessions that share a `sessionId` share
their runtime state: request counts, call counters, cooldown and the exact cache expiry. That
is the intended meaning of a session, but it means a host that reuses one id for a new
conversation will carry the old cooldown and cache timing into it. Use a UUID per session and
call `endSession` when it ends (or `resetSession` to discard the runtime state without
learning the horizon).

The id is also *not* a place for sensitive data: it is stored in the exported state and used
in keys. Never pass message text as a `sessionId`.

## 9. The benchmark is a simulation

`npm run benchmark` runs deterministic simulated sessions with synthetic ground truth. It
validates that the algorithm behaves as specified (no window overflow, fewer economically
unrepaid compactions than the fixed thresholds, failures absorbed by the cooldown) and it
measures decision latency. It does **not** prove anything about real task quality, real
provider cache behaviour or real compactor output. Its numbers may only be used to claim
simulated cost, compaction counts, failures, overflows and unrepaid compactions — and fewer
compactions reduce the number of exposures to potential information loss, which is not the
same as better task quality.

## 10. Numeric guards are not semantics

`retentionRatio ∈ [0.05, 1]`, `compactPromptRatio ∈ [0, 2]`, `compactOutputRatio ∈ [0, 1]`,
`compactCostScale ∈ [0.1, 10]`, `breakEvenCalls = null` when there is no positive saving, and
`Number.MAX_SAFE_INTEGER` for an overflowing break-even are numerical safety nets. They keep
the formulas finite and monotone; they are not statements about the world.

One consequence worth knowing: with `minReclaimTokens: 0` and `minReclaimRatio: 0` a host
disables the only gate that stops compaction when a compactor reclaims nothing, and the
economics are then decided purely by the price of a rebuilt prefix.

## 11. What v0.1 deliberately does not do

No summarization, no message pruning, no prompt rewriting, no tool-output pruning, no
embeddings, no vector search, no RAG, no long-term memory, no content or task classification,
no UI, no HTTP server, no database, no telemetry, no price fetching, no agent orchestration,
no Pi/dsh/MemoEcho plugins, no basic/pro/enterprise algorithm tiers, no machine-learned
predictor, no LLM in the decision path, and no scenario-specific branches.
