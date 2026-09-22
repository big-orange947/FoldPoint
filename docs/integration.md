# Integrating FoldPoint

FoldPoint is a library, not a service. It has no I/O, no async API and no configuration
files: you call it from the code that already owns the agent loop.

- [1. The four call sites](#1-the-four-call-sites)
- [2. What to pass as contextTokens](#2-what-to-pass-as-contexttokens)
- [3. Boundaries and permissions](#3-boundaries-and-permissions)
- [4. The horizon](#4-the-horizon)
- [5. Persisting state](#5-persisting-state)
- [6. Profiles for models and compactors](#6-profiles-for-models-and-compactors)
- [7. Prices](#7-prices)
- [8. Cache TTL](#8-cache-ttl)
- [9. Handling the three actions](#9-handling-the-three-actions)
- [10. Failure handling](#10-failure-handling)
- [11. Checklist](#11-checklist)

## 1. The four call sites

```ts
import { FoldPoint, type FoldPointProfile } from "foldpoint";

const foldPoint = new FoldPoint();
const profile: FoldPointProfile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "native-summary-v1",
  pricing: { currency: "USD", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
  cachePolicy: { ttlMs: 300_000 },
};

// (1) after every model call — this is how FoldPoint learns about cache behaviour,
//     growth and, indirectly, how expensive your prompts really are
foldPoint.observeRequest(profile, {
  timestamp: Date.now(),
  promptTokens: usage.inputTokens,
  cachedInputTokens: usage.cacheReadTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
  outputTokens: usage.outputTokens,
});

// (2) at every step boundary where the agent could pause
const decision = foldPoint.decide({
  profile,
  timestamp: Date.now(),
  contextTokens: estimatedNextPromptTokens,
  cachedTokens: usage.cacheReadTokens,
  safeBoundary: true,
  compactionAllowed: true,
});

// (3) after the compactor actually ran
foldPoint.recordCompaction(profile, {
  timestamp: Date.now(),
  beforeTokens: before,
  afterTokens: after,
  promptTokens: compactionUsage.inputTokens,
  outputTokens: compactionUsage.outputTokens,
  actualCost: compactionUsage.cost,
  success: true,
});

// (4) when the session ends
foldPoint.endSession(profile, { timestamp: Date.now() });
```

`observeRequest` and `recordCompaction` are the only way FoldPoint learns. If you skip them,
FoldPoint still works, but it will keep using its cold-start defaults forever.

## 2. What to pass as contextTokens

`contextTokens` is "the token count the next model call would carry if you did nothing". It
does not have to be exact — the decision is a comparison of costs, and a few percent of
error changes nothing. Do not pass the *remaining* window, and do not pass the size of the
last call's output.

`cachedTokens` is the number of tokens in that prompt that are known to be served from the
provider's cache (what the provider reports as cache reads). Omit it if unknown; FoldPoint
then treats the prompt as fully uncached, which is the conservative direction.

## 3. Boundaries and permissions

- `safeBoundary: true` means "the agent may pause here and run the compactor". FoldPoint
  never compacts on its own; this flag is your veto over *economic* compaction.
- `compactionAllowed: false` means "do not compact for cost reasons right now" — for example
  while the agent is mid-tool-call or inside a user-visible operation.
- Neither flag can suppress `FORCE`: window safety always wins. When `FORCE` fires while the
  host is not at a safe boundary, the decision says so in `reasons`, and it is still your job
  to compact at the next safe point.

## 4. The horizon

`expectedFutureCalls` is the one input where being wrong is expensive:

- **too high** → FoldPoint believes every compaction pays off over many calls and compacts
  more often than it should (the refill cap limits the damage, but the input is still
  wrong);
- **too low** → FoldPoint defers compaction until the window forces it.

Pass it only when the host really knows (a fixed-size batch job, a plan with a known number
of steps). Otherwise omit it: FoldPoint then uses its learned `reuseHorizonEma` (if you call
`endSession`) or the cold-start value of 3.

## 5. Persisting state

```ts
// save (any JSON store)
await store.set("foldpoint", foldPoint.exportState());

// restore
const restored = new FoldPoint({ state: await store.get("foldpoint") });
```

- State is plain JSON: numbers, strings and optional fields. No content, no secrets.
- Unknown fields are ignored and missing fields fall back to defaults, so snapshots survive
  upgrades within `version: 1`.
- `importState` replaces all profiles. Use one store key per agent workspace if profiles
  would otherwise collide.
- The state is small (a few hundred bytes per profile). Persisting it once per session, or
  once per compaction, is plenty.

## 6. Profiles for models and compactors

The state key is `provider | model | contextWindowTokens | compactorId`. Use a distinct
`compactorId` for every compactor implementation *and* version: a new summary prompt is a new
compactor, and its compression behaviour has to be learned separately.

```ts
const profiles = {
  cheap: { provider: "openai", model: "gpt-4.1-mini", contextWindowTokens: 128_000, compactorId: "summary-v2" },
  strong: { provider: "anthropic", model: "claude-sonnet-4", contextWindowTokens: 200_000, compactorId: "summary-v2" },
};
```

Do not derive a profile from message content, and do not reuse one profile across compactors.

## 7. Prices

Three options, in order of preference:

1. **Real prices** from your provider adapter. Cache prices matter: they are what makes a
   warm cache cheap to keep.
2. **Partial prices** — omit `cacheReadPerMillion` if the provider has no cache discount.
   FoldPoint will not invent savings from a cache it cannot price.
3. **`tokenOnlyPricing()`** — when you have no prices at all. Costs become token counts and
   the algorithm is unchanged.

Keep the units consistent across a profile: if you sometimes pass `actualCost` in USD and
sometimes leave `tokenOnlyPricing()`, the learned `compactionCostEma` mixes units. Pick one.

## 8. Cache TTL

```ts
cachePolicy: { ttlMs: 300_000 }        // provider documents a fixed TTL
cachePolicy: { halfLifeMs: 60_000 }    // no documented TTL: model decay instead
cachePolicy: { disabled: true }        // no prompt cache at all
// or, per observation:
observeRequest(profile, { ..., cacheExpiresAt: providerReportedExpiry });
```

An exact `cacheExpiresAt` (from the observation, the input, or the stored state) always wins
over the TTL estimate. If you know neither, omit the policy: FoldPoint will use the learned
cache-hit ratio without decay, which is the conservative choice for a cache that never
expires.

## 9. Handling the three actions

```ts
switch (decision.action) {
  case "KEEP":
    // Optionally honour the hint to avoid asking again on every token:
    // schedule the next check at decision.nextCheckAtTokens
    break;

  case "COMPACT":
    if (canPauseNow) {
      const result = await hostAgent.compact();
      foldPoint.recordCompaction(profile, { ...toObservation(result), success: true });
    }
    break;

  case "FORCE":
    // The window is at risk: compact at the nearest safe boundary, even if the host has
    // disabled economic compaction. Record the result exactly like a COMPACT.
    await hostAgent.compactAtNextSafeBoundary();
    break;
}
```

Log `decision.reasons` and `decision.metrics` verbatim; they are designed to answer "why did
it say that?" months later, including `breakEvenCalls`, `effectiveHorizonCalls` and
`callsUntilRefill`.

## 10. Failure handling

- A failed compaction must be recorded with `success: false`. FoldPoint will not learn a
  retention ratio from it, and it will not reset the cooldown, so you cannot get into a
  retry storm. Window safety (`FORCE`) keeps working regardless.
- Illegal input throws a `RangeError` (negative tokens, `cachedTokens > contextTokens`,
  timestamps that are not finite, prices below zero, `emaAlpha` outside `(0, 1]`, ...).
  FoldPoint never silently repairs obviously wrong data.
- Malformed *state* never throws: it degrades to defaults, so a corrupted snapshot cannot
  break the agent loop.
- `decide` is synchronous and allocation-bounded. Do not call it in a per-token hot loop if
  you can use `nextCheckAtTokens` instead; O(1) is not free at 10,000 calls per second.

## 11. Checklist

- [ ] `observeRequest` after every model call, including the cache read count.
- [ ] `decide` at step boundaries, with an honest `safeBoundary`.
- [ ] `recordCompaction` after every compaction attempt, success or failure.
- [ ] `endSession` at the end of a session (this is what teaches the horizon).
- [ ] One `compactorId` per compactor implementation and version.
- [ ] Prices (or `tokenOnlyPricing`) with consistent units.
- [ ] `cachePolicy` if the provider documents a TTL.
- [ ] State persisted somewhere durable.
- [ ] Reasons and metrics logged.
