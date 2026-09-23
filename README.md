# FoldPoint

**Compact at the right moment.**

A lightweight, cache-aware break-even trigger for agent context compaction.

> **FoldPoint does not compact context.** It decides when compaction is economically
> justified or operationally required.
>
> **FoldPoint 不执行上下文压缩。** 它只判断压缩在经济上是否值得，或者在窗口安全上是否已经必要。

FoldPoint answers exactly one question:

> Should this agent session compact its context right now?

and answers it with one of three actions: `KEEP`, `COMPACT`, `FORCE`.

It reads metadata only — token counts, timestamps, cache statistics, prices and past
compaction results. It never sees message content, never calls a model, never touches the
network, never reads a file and never allocates unbounded memory.

```ts
import { FoldPoint, tokenOnlyPricing } from "foldpoint";

const foldPoint = new FoldPoint();
const sessionId = crypto.randomUUID(); // stable, unique, non-sensitive

const profile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "native-summary-v1",
  pricing: tokenOnlyPricing(),
};

const decision = foldPoint.decide({
  sessionId,
  profile,
  timestamp: Date.now(),
  contextTokens: 84_000,
  cachedTokens: 70_000,
  safeBoundary: true,
  compactionAllowed: true,
});

if (decision.action === "COMPACT" || decision.action === "FORCE") {
  const result = await hostAgent.compact();
  foldPoint.recordCompaction(sessionId, profile, {
    timestamp: Date.now(),
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
    promptTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    success: true,
  });
}

foldPoint.endSession(sessionId, profile, { timestamp: Date.now() });
```

The host agent always keeps the last word. FoldPoint never calls the compactor itself.

- [What FoldPoint is not](#what-foldpoint-is-not)
- [Two kinds of state](#two-kinds-of-state)
- [Why a fixed percentage threshold is not enough](#why-a-fixed-percentage-threshold-is-not-enough)
- [Why the cache changes the right moment](#why-the-cache-changes-the-right-moment)
- [Why the first run can only use default estimates](#why-the-first-run-can-only-use-default-estimates)
- [How online learning works](#how-online-learning-works)
- [KEEP, COMPACT, FORCE](#keep-compact-force)
- [Saving and restoring state](#saving-and-restoring-state)
- [Profiles](#profiles)
- [Unknown prices: normalized token cost](#unknown-prices-normalized-token-cost)
- [Cache TTL](#cache-ttl)
- [Integrating with an existing agent](#integrating-with-an-existing-agent)
- [Quality protection](#quality-protection)
- [Benchmark](#benchmark)
- [Current limitations](#current-limitations)
- [Future plugins](#future-plugins)
- [Public API](#public-api)
- [Development](#development)

## What FoldPoint is not

FoldPoint is not a compactor and not a context-management framework. It does not:

- summarize anything, or write compaction prompts;
- decide which messages, tool calls or files to keep;
- prune tool output, rewrite prompts, or store/restore raw context;
- manage long-term memory, embeddings, vector search or RAG;
- classify content, tasks or phases;
- ship a UI, an HTTP server, a database or cloud telemetry;
- fetch model prices or read API keys;
- call an LLM to decide whether to compact.

All of that belongs to the host agent or to a specific compactor. FoldPoint only decides
*timing*, and it says so with structured reason codes.

## Two kinds of state

State is split, and the split matters as soon as you have more than one conversation:

| | Scope | Contents | Lifetime |
| --- | --- | --- | --- |
| **Profile learning** | every session of one `provider + model + contextWindowTokens + compactorId` | retention ratio, compaction usage ratios, actual-cost scale, cache coverage, reuse horizon | kept until you reset it |
| **Session runtime** | one `sessionId` of one profile | request count, attempt counts, calls since the last attempt, timestamps, exact cache expiry | deleted by `endSession` |

Everything in profile learning is a ratio or a count — never an absolute amount — so it stays
valid when the context size changes or when prices change. Session runtime is what makes two
conversations independent: one session's cooldown, request timing and cache expiry never
affect another's.

## Why a fixed percentage threshold is not enough

Most agents compact at a fixed utilization, for example 70% of the window. That number
ignores everything that decides whether compacting is actually a good idea:

| Fixed threshold ignores | Consequence |
| --- | --- |
| Different window sizes | 70% of 8k is not 70% of 1M |
| Different input / cache-read / output prices | the same token saving is worth wildly different money |
| How much of the prompt is actually cached right now | replaying a warm context is nearly free |
| Cache TTL and idle time | the cache may already be gone, which makes keeping expensive |
| How well *this* compactor compresses | a weak compactor costs a call and reclaims nothing |
| Whether the compactor even succeeds | a failed attempt costs money and reclaims nothing |
| The cost of the compaction call itself | compaction is a model call over the whole context |
| That compaction destroys the cache prefix | the next calls pay full price until the cache is rebuilt |
| How many calls are still coming | saving tokens on the last call is worthless |
| Compaction jitter | re-compacting every few calls destroys information for pennies |

FoldPoint replaces the fixed percentage with a break-even computation plus a small set of
quality guards. A percentage still appears in the model, but as a *safety* boundary
(`hardWindowRatio`) and as a *conservatism switch* (`softWindowRatio`), never as the trigger.

## Why the cache changes the right moment

Compaction rewrites the prefix of the context, which invalidates the provider's prompt cache.
So a compaction has two costs: the compaction call itself, which reads the whole context at
the normal input price, and rebuilding the cache afterwards, which makes the following calls
more expensive.

If the cache is warm and cache reads are cheap, *keeping* the context costs almost nothing per
call, and compaction is a bad trade even at high utilization. If the cache has expired or the
provider gives no cache discount, every call replays the whole context at the input price, and
compacting early pays off quickly.

FoldPoint models this with two separate quantities:

- **cache coverage** — how much of the context the cache *could* serve;
- **cache alive probability** — whether that candidate prefix is still usable.

They are multiplied together exactly once, in `estimatedEffectiveCachedTokens`, and never
folded into each other.

## Why the first run can only use default estimates

FoldPoint cannot know how well a given compactor compresses before that compactor has run, and
it refuses to guess from content. It also cannot invent a price it was never given.

So a fresh profile starts from the cold-start defaults in
[`src/defaults.ts`](src/defaults.ts) — a retention ratio of 0.40, compaction usage ratios of
1.0 prompt / 0.12 output, a reuse horizon of 3 calls — and the uncertainty penalty discounts
the estimated benefit until real samples exist. With no evidence at all, FoldPoint needs a
large positive saving before it will say `COMPACT`; `FORCE` is never weakened by uncertainty.

## How online learning works

Every real event updates one exponential moving average (EMA), `new = alpha * observed +
(1 - alpha) * previous`, with `alpha = 0.25` by default:

| Quantity | Observed from | Updated when |
| --- | --- | --- |
| `retentionRatioEma` | `afterTokens / beforeTokens` | a **successful** compaction is recorded |
| `compactPromptRatioEma` | compaction `promptTokens / beforeTokens` | a successful compaction reports usage |
| `compactOutputRatioEma` | compaction `outputTokens / beforeTokens` | a successful compaction reports usage |
| `compactCachedInputRatioEma` | compaction `cachedInputTokens / promptTokens` | a successful compaction reports it |
| `compactCacheWriteRatioEma` | compaction `cacheWriteTokens / promptTokens` | a successful compaction reports it |
| `compactCostScaleEma` | `actualCost / modeledCost`, dimensionless, clamped to `[0.1, 10]` | a successful compaction reports a real cost *and* a currency price snapshot |
| `cacheCoverageRatioEma` | `cachedInputTokens / promptTokens` | a request observation has `promptTokens > 0` |
| `reuseHorizonEma` | calls between a successful compaction and session end | the host reports `endSession` |

The compaction call is priced by scaling those ratios to the current context and applying the
*current* prices, so a ratio learned on a 10k context prices a 180k context correctly and a
price change is picked up immediately. No absolute currency amount is stored anywhere.

Failed attempts increment the attempt and failure counters, restart the cooldown, and update
nothing in the profile: a failed attempt teaches nothing about the compactor.

State is isolated per profile, because compaction quality differs per compactor.

## KEEP, COMPACT, FORCE

| Action | Meaning |
| --- | --- |
| `KEEP` | Keeping the current context is the better option right now. |
| `COMPACT` | Given expected cost and the observed compaction behaviour, compacting has a positive expected return. |
| `FORCE` | Even if the economics are uncertain, the window must keep a safe margin. |

Every decision also carries `reasons` (stable codes), `confidence` (how much real evidence
backs the estimate) and a full `metrics` block, including `breakEvenCalls`,
`estimatedCacheCoverageRatio`, `estimatedCacheAliveProbability` and
`estimatedEffectiveCachedTokens`. Nothing is hidden behind a boolean.

`FORCE` is a statement about the window, not a command: it is still the host that decides
whether it can run the compactor *here*. If the host is not at a safe boundary, the decision
says so in `reasons` (`UNSAFE_BOUNDARY` / `COMPACTION_DISABLED`).

## Saving and restoring state

State is plain JSON, contains no message content and no secrets, and is versioned.

```ts
const saved = JSON.stringify(foldPoint.exportState()); // { version: 2, profiles, sessions }
// ... later, in another process ...
const restored = new FoldPoint({ state: JSON.parse(saved) });
```

Unknown fields are ignored and missing fields fall back to the defaults, so a snapshot can
never break the decision path. `decide()` never mutates state — only `observeRequest`,
`recordCompaction` and `endSession` do. A pre-release version 1 snapshot is rejected with an
explicit error rather than reinterpreted.

## Profiles

A profile is the identity of "a model with a compactor":

```ts
const profile = {
  provider: "anthropic",           // optional, part of the learning key
  model: "claude-sonnet-4",
  contextWindowTokens: 200_000,
  compactorId: "summary-v3",       // different compactors learn separately
  pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
  cachePolicy: { ttlMs: 300_000 },
};
```

The learning key is the JSON tuple `[provider, model, contextWindowTokens, compactorId]`;
session keys extend it with the `sessionId`. Profiles are never derived from message content.

## Unknown prices: normalized token cost

If you do not know the real prices, pass `tokenOnlyPricing()` (or nothing at all). Costs are
then denominated in tokens, and the decision logic is unchanged: it still weighs reclaim
against the compaction call and the cache.

```ts
import { tokenOnlyPricing } from "foldpoint";
const pricing = tokenOnlyPricing(); // 1 unit per token, no cache discount
```

When a price snapshot has no `cacheReadPerMillion`, FoldPoint assumes cache reads cost the same
as normal input and sets the alive probability to 0 — no discount, no invented savings. In
token-only mode the actual-cost scale is never learned, so a token count can never be
reinterpreted as money.

## Cache TTL

Three levels of knowledge, in priority order:

1. `cacheExpiresAt` on the observation or the input — used exactly (`timestamp <
   cacheExpiresAt`);
2. `cachePolicy.ttlMs` — the cache counts as alive while `idleMs < ttlMs`;
3. `cachePolicy.halfLifeMs` — `aliveProbability = 2^(-idleMs / halfLife)`.

The exact expiry belongs to the session and is cleared by any request observation that does
not report one, so a stale expiry cannot control a newer prefix. Without any of these,
FoldPoint assumes a candidate prefix is alive — the learned coverage ratio is already an
observed hit rate and must not be discounted twice.

## Integrating with an existing agent

```ts
// after every model call
foldPoint.observeRequest(sessionId, profile, {
  timestamp: Date.now(),
  promptTokens: usage.inputTokens,
  cachedInputTokens: usage.cacheReadTokens,
  outputTokens: usage.outputTokens,
});

// at every step boundary where the agent could pause
const decision = foldPoint.decide({
  sessionId,
  profile,
  timestamp: Date.now(),
  contextTokens: estimatedNextPromptTokens,
  cachedTokens: usage.cacheReadTokens,
  safeBoundary: true,
  compactionAllowed: true,
  expectedFutureCalls: remainingSteps, // only if you really know it, and let it shrink
});

// after running the compactor
foldPoint.recordCompaction(sessionId, profile, {
  timestamp: Date.now(),
  beforeTokens,
  afterTokens,
  success,
});

// when the session ends
foldPoint.endSession(sessionId, profile, { timestamp: Date.now() });
```

See [docs/integration.md](docs/integration.md) for the full checklist, including session ids,
state persistence, multi-compactor setups and failure handling.

## Quality protection

`KEEP` is the default. `COMPACT` has to earn its way past every one of these gates:

- **safe boundary** — the host says the agent may pause here;
- **host opt-out** — `compactionAllowed: false` suppresses economic compaction entirely;
- **cooldown** — at least `minCallsBetweenCompactions` (3) calls since the last attempt,
  successful or not;
- **minimum reclaim** — both `minReclaimTokens` (4,096) and `minReclaimRatio` (0.20);
- **uncertainty penalty** — `adjustedNetSaving = netSaving * confidence - penalty *
  compactCallCost`, doubled below the soft window;
- **quick-payback policy guard** — below 65% utilization the break-even must fit in
  `softWindowBreakEvenCalls` (3) calls. A quality-oriented policy, not a mathematical
  optimum;
- **window guard** — at `hardWindowRatio` (0.90) or inside `reserveTokens` (8,192) the answer
  is `FORCE`, whatever the economics say.

## Benchmark

`npm run benchmark` runs a deterministic simulation of 11 scenarios (short task, long tool
task, warm cache, expired cache, strong compactor, weak compactor, expensive compaction,
sudden growth, churn risk, no cache discount, flaky compactor) against eight baselines and
FoldPoint itself. The raw report is written to
[`benchmarks/reports/benchmark-report.json`](benchmarks/reports/benchmark-report.json) and the
methodology is documented in [benchmarks/README.md](benchmarks/README.md).

Aggregate over all 11 scenarios. "judged" counts the successful, non-forced compactions whose
payback was measured against an independent counterfactual branch; "unneeded" counts how many
of those did not repay themselves:

| strategy | cost | attempts | ok | failed | econ | forced | judged | unneeded | overflows | avg util @ comp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Never | 218.26 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 45 | n/a |
| Fixed 50% raw | 171.13 | 117 | 109 | 8 | 117 | 0 | 109 | 89 | 0 | 0.558 |
| Fixed 70% raw | 189.51 | 81 | 76 | 5 | 81 | 0 | 76 | 44 | 0 | 0.722 |
| Fixed 80% raw | 197.88 | 66 | 64 | 2 | 66 | 0 | 64 | 35 | 0 | 0.823 |
| Fixed 90% raw | 208.52 | 55 | 53 | 2 | 55 | 0 | 53 | 29 | 0 | 0.922 |
| Fixed 70% guarded | 191.50 | 66 | 64 | 2 | 39 | 27 | 37 | 7 | 0 | 0.807 |
| Fixed 80% guarded | 199.23 | 60 | 58 | 2 | 31 | 29 | 30 | 4 | 0 | 0.869 |
| Fixed 90% guarded | 208.52 | 55 | 53 | 2 | 0 | 55 | 0 | 0 | 0 | 0.922 |
| **FoldPoint** | **136.44** | 125 | 123 | 2 | 82 | 43 | 82 | **6** | **0** | 0.423 |

Costs, token counts and attempt counts are deterministic and reproduce exactly; latency is
machine- and run-dependent, so the README does not quote it — the recorded values are in the
report. Typical magnitudes on the machine that produced this table: FoldPoint `decide`
p50 ≈ 0.005 ms and p99 ≈ 0.06 ms inside a session (including GC), against p50 ≈ 0.0002 ms for
a fixed threshold; the pure decision micro-benchmark runs 100,000 `decideFoldPoint` calls at
≈ 0.8 µs each.

"Unneeded" is measured, not approximated: each successful non-forced compaction opens an
independent counterfactual branch that keeps the pre-compaction context **and its own cache
history**, receives exactly the same growth, and prices its own calls. If that branch would
have run past the window, the compaction is never counted as unneeded. See
[benchmarks/README.md](benchmarks/README.md).

Honest reading of that table:

- FoldPoint is the cheapest strategy in aggregate and never overflows. The advantage comes from
  the cold-cache scenarios, where every call replays the whole context and keeping the context
  small is directly cheaper (scenario `D`: 8.66 against 19.93 for the cheapest fixed
  threshold).
- **FoldPoint also compacts more often than the 70/80/90% baselines** (125 attempts against
  55–81). Each of those compactions repays itself, but more compactions mean more exposures to
  potential information loss. Raise `minCallsBetweenCompactions` or `minReclaimRatio` to trade
  cost back for fewer compactions.
- The guarded baselines isolate the guards from the economics: guarded 70% cuts unnecessary
  compactions from 44 to 7 at the same cost, so most of the raw baselines' churn was the
  missing cooldown, not the threshold.
- FoldPoint's 6 unnecessary compactions out of 82 judged (7%) compare with 29–89 out of 53–109
  (55–82%) for the raw baselines and 4–7 out of 30–37 (11–19%) for the guarded ones.
- Scenario `K` (half of all attempts fail) is where the failure handling shows: failures are
  billed, teach nothing, and restart the cooldown instead of turning into a retry storm.

The numbers may only be used to claim simulated cost, compaction counts, failures, overflows
and unrepaid compactions. **Fewer compactions reduce the number of exposures to potential
information loss, but that does not prove better task quality.**

Earlier revisions of this README quoted "5 unnecessary compactions" and "a 4% unnecessary
rate" from an approximate counterfactual (the actual cache coverage applied to a
counterfactual prompt). Those numbers are withdrawn: they are replaced by the measured
counterfactual above, which is stricter (6 of 82 judged, 7%).

## Current limitations

The full list is in [docs/limitations.md](docs/limitations.md). The short version:

- FoldPoint cannot judge whether a compaction dropped something important; it reduces that
  risk with cooldowns, minimum reclaim, safe boundaries and a window reserve.
- The future-call horizon is a guess unless the host provides one, and an overstated horizon
  makes it compact more often.
- The cost model is a short-horizon approximation, not an optimal controller.
- Provider cache behaviour is modelled as a probability, not known state.
- The cold-start prior (retention 0.40) can allow a few economically wrong compactions before
  the first real results arrive — visible in scenario `F`.
- In cold-cache sessions FoldPoint compacts more often than the conservative fixed thresholds
  (cheaper, but more exposures to information loss).
- "Cheaper" is not "better quality": FoldPoint only optimises *when* to compact.

## Future plugins

v0.1 is the core only. Thin adapters for Pi, dsh and MemoEcho are planned as separate packages
once the core has been reviewed; they will translate host events into `observeRequest` /
`recordCompaction` / `decide` calls and nothing more. No plugin is implemented here.

## Public API

```ts
class FoldPoint {
  constructor(options?: { defaults?: Partial<FoldPointDefaults>; state?: FoldPointState });
  observeRequest(sessionId, profile, observation): void;
  decide(input): FoldPointDecision;
  recordCompaction(sessionId, profile, observation): void;
  endSession(sessionId, profile, observation): void;
  exportState(): FoldPointState;
  importState(state): void;
  getProfileState(profile): FoldPointProfileLearningState;
  getSessionState(sessionId, profile): FoldPointSessionState;
  resetProfile(profile): void;
  resetSession(sessionId, profile): void;
  getDefaults(): FoldPointDefaults;
}

function decideFoldPoint(input, learning, session, options?): FoldPointDecision; // pure
function computeBreakEvenCalls(input): number | null;                           // pure
function profileKey(profile): string;
function sessionKey(sessionId, profile): string;
function tokenOnlyPricing(): PricingSnapshot;
function resolveDefaults(overrides?): FoldPointDefaults;
```

Plus the building blocks used by the estimator (`resolveUnitPrices`, `costOfUsage`,
`isTokenOnlyPricing`, `estimateCacheModel`, `resolveCacheCoverageRatio`, `resolveIdleMs`,
`resolveCacheExpiresAt`, `computeConfidence`, `emaUpdate`, `clamp`, `safeDivide`,
`sampleConfidence`, `percentile`), the state helpers (`createProfileLearningState`,
`createSessionState`, `normalizeProfileLearningState`, `normalizeSessionState`,
`applyRequestObservation`, `applyCompactionObservation`, `applySessionEnd`), the validators
(`validateFoldPointInput`, `validateRequestObservation`, `validateCompactionObservation`,
`validateDefaults`) and the reason catalog (`ALL_REASONS`, `REASON_DESCRIPTIONS`).

The core has **zero runtime dependencies** and no Node-specific APIs: it runs in browsers and
any JS runtime.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # biome check .
npm test            # vitest run
npm run build       # tsup + tsc declarations -> dist/
npm run benchmark   # simulation benchmark + JSON report
npm run example:basic
npm run example:online-learning
npm run example:cache-expiration
```

Documentation: [algorithm](docs/algorithm.md) · [integration](docs/integration.md) ·
[limitations](docs/limitations.md) · [benchmark](benchmarks/README.md).

MIT licensed.
