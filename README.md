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
const profile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "native-summary-v1",
  pricing: tokenOnlyPricing(),
};

const decision = foldPoint.decide({
  profile,
  timestamp: Date.now(),
  contextTokens: 84_000,
  cachedTokens: 70_000,
  safeBoundary: true,
  compactionAllowed: true,
});

if (decision.action === "COMPACT" || decision.action === "FORCE") {
  const result = await hostAgent.compact();
  foldPoint.recordCompaction(profile, {
    timestamp: Date.now(),
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
    promptTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    success: true,
  });
}
```

The host agent always keeps the last word. FoldPoint never calls the compactor itself.

- [What FoldPoint is not](#what-foldpoint-is-not)
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
| The cost of the compaction call itself | compaction is not free: it is a model call over the whole context |
| That compaction destroys the cache prefix | the next calls pay full price until the cache is rebuilt |
| How many calls are still coming | saving tokens on the last call is worthless |
| Compaction jitter | re-compacting every few calls destroys information for pennies |

The result is the familiar failure mode: too many compactions, each one barely worth it, and
a hard wall that still arrives when growth is sudden.

FoldPoint replaces the fixed percentage with a break-even computation and keeps a small set
of quality guards around it. A percentage still appears in the model, but as a *safety*
boundary (`hardWindowRatio`) and as a *conservatism switch* (`softWindowRatio`), never as
the trigger itself.

## Why the cache changes the right moment

Compaction rewrites the prefix of the context, which invalidates the provider's prompt
cache. So a compaction has two costs:

1. the compaction call itself, which reads the whole context at the normal input price; and
2. rebuilding the cache afterwards, which makes the following calls more expensive.

If the cache is warm and cache reads are cheap, *keeping* the context costs almost nothing
per call, and compaction is a bad trade even at high utilization. If the cache has expired
or the provider gives no cache discount, every call replays the whole context at the input
price, and compacting early pays off quickly.

FoldPoint models both cases with one probability — `estimatedCacheSurvival` — and lets the
break-even decide. In the simulation benchmark, this is the difference between "defer until
the window forces us" (warm cache) and "compact early, cheaper than every fixed threshold"
(cold cache).

## Why the first run can only use default estimates

FoldPoint cannot know how well a given compactor compresses before that compactor has run,
and it refuses to guess from content. It also cannot invent a price it was never given.

So a fresh profile starts from the cold-start defaults in
[`src/defaults.ts`](src/defaults.ts) — a retention ratio of 0.40, a compaction output ratio
of 0.12, a reuse horizon of 3 calls, and so on — and the uncertainty penalty discounts the
estimated benefit until real samples exist. With no evidence at all, FoldPoint needs a large
positive saving before it will say `COMPACT`; `FORCE` is never weakened by uncertainty.

## How online learning works

Every real event updates one exponential moving average (EMA), `new = alpha * observed +
(1 - alpha) * previous`, with `alpha = 0.25` by default:

| Quantity | Observed from | Updated when |
| --- | --- | --- |
| `retentionRatioEma` | `afterTokens / beforeTokens` | a **successful** compaction is recorded |
| `compactOutputRatioEma` | compaction output tokens / `beforeTokens` | a successful compaction reports `outputTokens` |
| `compactionCostEma` | `actualCost`, else usage × prices, else normalized tokens | a successful compaction reports cost data |
| `cacheHitRatioEma` | `cachedInputTokens / promptTokens` | a request observation has `promptTokens > 0` |
| `reuseHorizonEma` | calls between a compaction and session end | the host reports `endSession` |
| `growthPerCallEma` | `promptTokens` delta between consecutive calls | the prompt grew (a shrinking prompt means a compaction, not growth) |

Failed compactions increment the counters but never update the retention ratio, and they do
not reset the cooldown, so a failing compactor cannot be hammered.

State is isolated per profile (provider + model + context window + compactor id), because
compaction quality differs per compactor.

## KEEP, COMPACT, FORCE

| Action | Meaning |
| --- | --- |
| `KEEP` | Keeping the current context is the better option right now. |
| `COMPACT` | Given expected cost and the observed compaction behaviour, compacting has a positive expected return. |
| `FORCE` | Even if the economics are uncertain, the window must keep a safe margin. |

Every decision also carries `reasons` (stable codes), `confidence` (how much real evidence
backs the estimate) and a full `metrics` block with the intermediate numbers, including
`breakEvenCalls`. Nothing is hidden behind a boolean.

`FORCE` is a statement about the window, not a command: it is still the host that decides
whether it can run the compactor *here*. If the host is not at a safe boundary, the decision
says so in `reasons` (`UNSAFE_BOUNDARY` / `COMPACTION_DISABLED`).

## Saving and restoring state

State is plain JSON, contains no message content and no secrets, and is versioned.

```ts
const saved = JSON.stringify(foldPoint.exportState());
// ... later, in another process ...
const restored = new FoldPoint({ state: JSON.parse(saved) });
```

Unknown fields are ignored and missing fields fall back to the defaults, so an older or
newer snapshot can never break the decision path. `decide()` never mutates state — only
`observeRequest`, `recordCompaction` and `endSession` do.

## Profiles

A profile is the identity of "a model with a compactor":

```ts
const profile = {
  provider: "anthropic",           // optional, part of the state key
  model: "claude-sonnet-4",
  contextWindowTokens: 200_000,
  compactorId: "summary-v3",       // different compactors learn separately
  pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
  cachePolicy: { ttlMs: 300_000 },
};
```

The state key is `provider | model | contextWindowTokens | compactorId`. Profiles are never
derived from message content.

## Unknown prices: normalized token cost

If you do not know the real prices, pass `tokenOnlyPricing()` (or nothing at all). Costs are
then denominated in tokens, and the decision logic is unchanged: it still weighs reclaim
against the compaction call and the cache.

```ts
import { tokenOnlyPricing } from "foldpoint";
const pricing = tokenOnlyPricing(); // 1 unit per token, no cache discount
```

When a price snapshot has no `cacheReadPerMillion`, FoldPoint assumes cache reads cost the
same as normal input and sets cache survival to 0 — no discount, no invented savings.

## Cache TTL

Three levels of knowledge, in priority order:

1. `cacheExpiresAt` on the observation or the input — used exactly (`timestamp <
   cacheExpiresAt`);
2. `cachePolicy.ttlMs` — the cache counts as alive while `idleMs < ttlMs`;
3. `cachePolicy.halfLifeMs` — `survival = base * 2^(-idleMs / halfLife)`.

Without any of them, FoldPoint uses the learned cache-hit ratio undecayed. `idleMs` is taken
from the input, or derived from the last observed request timestamp when omitted.

## Integrating with an existing agent

```ts
// after every model call
foldPoint.observeRequest(profile, {
  timestamp: Date.now(),
  promptTokens: usage.inputTokens,
  cachedInputTokens: usage.cacheReadTokens,
  outputTokens: usage.outputTokens,
});

// at every step boundary where the agent could pause
const decision = foldPoint.decide({
  profile,
  timestamp: Date.now(),
  contextTokens: estimatedNextPromptTokens,
  cachedTokens: usage.cacheReadTokens,
  safeBoundary: true,
  compactionAllowed: true,
  expectedFutureCalls: remainingSteps, // only if you really know it
});

// after running the compactor
foldPoint.recordCompaction(profile, { timestamp: Date.now(), beforeTokens, afterTokens, success });

// when the session ends, so the horizon can be learned
foldPoint.endSession(profile, { timestamp: Date.now() });
```

See [docs/integration.md](docs/integration.md) for the full checklist, including how to
handle `nextCheckAtTokens`, multi-compactor setups and state persistence.

## Quality protection

`KEEP` is the default. `COMPACT` has to earn its way past every one of these gates:

- **safe boundary** — the host says the agent may pause here;
- **host opt-out** — `compactionAllowed: false` suppresses economic compaction entirely;
- **cooldown** — at least `minCallsBetweenCompactions` (3) calls since the last compaction;
- **minimum reclaim** — both `minReclaimTokens` (4,096) and `minReclaimRatio` (0.20);
- **uncertainty penalty** — `adjustedNetSaving = netSaving * confidence - penalty *
  compactCost`, doubled below the soft window;
- **quick payback below the soft window** — below 65% utilization the payback must fit in
  `softWindowBreakEvenCalls` (3) calls;
- **horizon caps** — the payback must also fit inside the time the context needs to regrow
  to its pre-compaction size (`callsUntilRefill`), because a compaction's benefit cannot
  outlive the context it reclaimed;
- **window guard** — at `hardWindowRatio` (0.90) or inside `reserveTokens` (8,192) the
  answer is `FORCE`, whatever the economics say.

## Benchmark

`npm run benchmark` runs a deterministic simulation of 10 scenarios (short task, long tool
task, warm cache, expired cache, strong compactor, weak compactor, expensive compaction,
sudden growth, churn risk, no cache discount) against five baselines and FoldPoint itself.
The raw report is written to
[`benchmarks/reports/benchmark-report.json`](benchmarks/reports/benchmark-report.json) and
the methodology is documented in [benchmarks/README.md](benchmarks/README.md).

Aggregate over all 10 scenarios (lower cost is better; "unneeded" is the count of
compactions that did not repay themselves before the session ended):

| strategy | cost | compactions | forced | unneeded | overflows | min headroom | avg util @ comp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Never compact | 181.13 | 0 | 0 | 0 | 42 | -32,528 | n/a |
| Fixed 50% | 145.97 | 103 | 1 | 80 | 0 | 85,586 | 0.554 |
| Fixed 70% | 161.82 | 72 | 1 | 56 | 0 | 60,027 | 0.720 |
| Fixed 80% | 169.25 | 60 | 1 | 47 | 0 | 40,067 | 0.821 |
| Fixed 90% | 178.17 | 50 | 50 | 0 | 0 | 20,175 | 0.920 |
| **FoldPoint** | **159.53** | **56** | 39 | **4** | **0** | 20,205 | 0.845 |

Costs, token counts and compaction counts are deterministic and reproduce exactly. Latency
is machine- and run-dependent, so the README does not quote per-strategy numbers: the
recorded values are in
[`benchmarks/reports/benchmark-report.json`](benchmarks/reports/benchmark-report.json).
Typical magnitudes on the machine that produced this table: FoldPoint `decide` p50 ≈ 0.005 ms
and p99 ≈ 0.05–0.08 ms inside a session (including GC), against p50 ≈ 0.0002 ms for a fixed
threshold; the pure decision micro-benchmark runs 100,000 `decideFoldPoint` calls at
≈ 0.6–0.7 µs each (p50 ≈ 0.4 µs, p99 ≈ 2.5 µs).

Honest reading of that table:

- FoldPoint costs less than every fixed threshold from 70% upwards, and far less than never
  compacting (which overflows 42 times and pays for 42 emergency recoveries).
- FoldPoint's real advantage over the 50/70/80% thresholds is quality: 4 compactions that
  failed to repay themselves, against 80, 56 and 47.
- Fixed 50% is cheaper than FoldPoint in raw token cost, and it is the honest counter-example:
  it buys that with 103 compactions, 80 of which never repaid.
- FoldPoint is cheaper than fixed 90% (159.53 vs 178.17) but asks for 6 more compactions
  (56 vs 50), because it also compacts economically in the cold-cache scenarios where
  fixed 90% waits for the wall. That trade is the point of the library, not a free win.
- In the two warm-cache scenarios FoldPoint behaves like a wall-only policy (all compactions
  `FORCE`); it only compacts *early* when the cache is gone or there is no cache discount.

Per-decision latency: 100,000 pure `decideFoldPoint` calls, p50 ≈ 0.4 µs, p99 ≈ 2.5 µs,
roughly 0.7 µs per decision. `decide` is O(1), allocation-bounded, and does no I/O.

## Current limitations

The full list is in [docs/limitations.md](docs/limitations.md). The short version:

- FoldPoint cannot judge whether a compaction dropped something important; it reduces that
  risk with cooldowns, minimum reclaim, safe boundaries and a window reserve.
- The future-call horizon is a guess unless the host provides one.
- The cost model is a short-horizon approximation, not an optimal controller.
- Provider cache behaviour is modelled as a probability, not known state.
- The cold-start prior (retention 0.40) can allow a few economically wrong compactions
  before the first real compaction results arrive — visible in scenario F of the benchmark.
- "Cheaper" is not "better quality": FoldPoint only optimises *when* to compact.

## Future plugins

v0.1 is the core only. Thin adapters for Pi, dsh and MemoEcho are planned as separate
packages once the core has been reviewed; they will translate host events into
`observeRequest` / `recordCompaction` / `decide` calls and nothing more. No plugin is
implemented here.

## Public API

```ts
class FoldPoint {
  constructor(options?: { defaults?: Partial<FoldPointDefaults>; state?: FoldPointState });
  observeRequest(profile, observation): void;
  decide(input): FoldPointDecision;
  recordCompaction(profile, observation): void;
  endSession(profile, observation): void;
  exportState(): FoldPointState;
  importState(state): void;
  getProfileState(profile): FoldPointProfileState;
  resetProfile(profile): void;
  getDefaults(): FoldPointDefaults;
}

function decideFoldPoint(input, state, options?): FoldPointDecision; // pure, stateless
function profileKey(profile): string;
function tokenOnlyPricing(): PricingSnapshot;
function resolveDefaults(overrides?): FoldPointDefaults;
```

Plus the building blocks used by the estimator (`resolveUnitPrices`, `costOfUsage`,
`estimateCacheSurvival`, `resolveCacheHitRatio`, `resolveIdleMs`, `computeConfidence`,
`emaUpdate`, `clamp`, `safeDivide`, `sampleConfidence`, `percentile`), the state helpers
(`createProfileState`, `normalizeProfileState`, `applyRequestObservation`,
`applyCompactionObservation`, `applySessionEnd`), the validators (`validateFoldPointInput`,
`validateRequestObservation`, `validateCompactionObservation`, `validateDefaults`) and the
reason catalog (`ALL_REASONS`, `REASON_DESCRIPTIONS`).

The core has **zero runtime dependencies** and no Node-specific APIs: it runs in browsers
and any JS runtime.

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
