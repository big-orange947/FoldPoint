# Integrating FoldPoint

FoldPoint is a library, not a service. It has no I/O, no async API and no configuration files:
you call it from the code that already owns the agent loop.

**Two rules carry most of the integration:** every call needs a `sessionId`, and every session
needs an `endSession` call.

- [1. The four call sites](#1-the-four-call-sites)
- [2. sessionId](#2-sessionid)
- [3. What to pass as contextTokens](#3-what-to-pass-as-contexttokens)
- [4. Boundaries and permissions](#4-boundaries-and-permissions)
- [5. The horizon](#5-the-horizon)
- [6. What is shared and what is isolated](#6-what-is-shared-and-what-is-isolated)
- [7. Persisting state (version 2)](#7-persisting-state-version-2)
- [8. Profiles for models and compactors](#8-profiles-for-models-and-compactors)
- [9. Prices](#9-prices)
- [10. Cache TTL](#10-cache-ttl)
- [11. Handling the three actions](#11-handling-the-three-actions)
- [12. Failure handling](#12-failure-handling)
- [13. Checklist](#13-checklist)

## 1. The four call sites

```ts
import { FoldPoint, type FoldPointProfile } from "foldpoint";

const foldPoint = new FoldPoint();
const sessionId = crypto.randomUUID(); // stable, non-sensitive, unique per session

const profile: FoldPointProfile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "native-summary-v1",
  pricing: { currency: "USD", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
  cachePolicy: { ttlMs: 300_000 },
};

// (1) after every model call
foldPoint.observeRequest(sessionId, profile, {
  timestamp: Date.now(),
  promptTokens: usage.inputTokens,
  cachedInputTokens: usage.cacheReadTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
  outputTokens: usage.outputTokens,
});

// (2) at every step boundary where the agent could pause
const decision = foldPoint.decide({
  sessionId,
  profile,
  timestamp: Date.now(),
  contextTokens: estimatedNextPromptTokens,
  cachedTokens: usage.cacheReadTokens,
  safeBoundary: true,
  compactionAllowed: true,
});

// (3) after every compaction attempt, successful or not
foldPoint.recordCompaction(sessionId, profile, {
  timestamp: Date.now(),
  beforeTokens: before,
  afterTokens: after,
  promptTokens: compactionUsage.inputTokens,
  cachedInputTokens: compactionUsage.cacheReadTokens,
  outputTokens: compactionUsage.outputTokens,
  actualCost: compactionUsage.cost,
  success: true,
});

// (4) when the session ends
foldPoint.endSession(sessionId, profile, { timestamp: Date.now() });
```

## 2. sessionId

A session id must be:

- **stable** for the whole session (the same id in every call of that session),
- **unique** per session (a UUID),
- **non-sensitive** — it is stored in the exported state and used in state keys, so never put
  message text, user names or anything private in it.

Sessions of the same profile are isolated from each other: request counts, call counters,
cooldowns and the exact cache expiry belong to one session and never leak into another. Two
sessions that share an id share that runtime state, which is why a fresh conversation needs a
fresh id.

`endSession` learns the reuse horizon into the profile (only when the session compacted
successfully at least once) and deletes the session runtime state. If you want to discard a
session without learning anything, call `resetSession(sessionId, profile)` instead.

## 3. What to pass as contextTokens

`contextTokens` is "the token count the next model call would carry if you did nothing". It
does not have to be exact — the decision compares costs, and a few percent of error changes
nothing. Do not pass the remaining window, and do not pass the size of the last output.

`cachedTokens` is the number of tokens in that prompt the provider will serve from its cache.
Report `0` when you know the prefix has lapsed: the model then bills this call as a cache
write, which is what it costs. Omit it if unknown: FoldPoint then falls back to the learned
coverage ratio, and with no history at all it treats the prompt as fully uncached, which is the
conservative direction.

## 4. Boundaries and permissions

- `safeBoundary: true` means "the agent may pause here and run the compactor". FoldPoint never
  compacts on its own; this flag is your veto over *economic* compaction.
- `compactionAllowed: false` means "do not compact for cost reasons right now" — for example
  while the agent is mid-tool-call or inside a user-visible operation.
- Neither flag can suppress `FORCE`: window safety always wins. When `FORCE` fires while the
  host is not at a safe boundary, the decision says so in `reasons`, and it is still your job
  to compact at the next safe point.

## 5. The horizon

`expectedFutureCalls` is the one input where being wrong is expensive:

- **too high** → every compaction looks more valuable than it is, and FoldPoint compacts more
  often than it should;
- **too low** → FoldPoint defers compaction until the window forces it.

Report it honestly and let it shrink: a host that knows "20 calls remain" at step 1 of a
200-step session should not still be reporting 20 at step 100. If you cannot estimate it,
omit it — FoldPoint will use its learned `reuseHorizonEma` (after `endSession`) or the
cold-start default of 3.

## 6. What is shared and what is isolated

| State | Scope | Contents |
| --- | --- | --- |
| Profile learning | shared by every session of the same `provider + model + window + compactorId` | retention, compaction usage ratios, actual-cost scale, cache coverage, reuse horizon |
| Session runtime | one `sessionId` of one profile | request count, attempt counts, `callsSinceLastAttempt`, `callsSinceLastSuccessfulCompaction`, timestamps, exact cache expiry |

So a second session immediately benefits from what the first one learned about the compactor
and the cache, but starts with its own cooldown, its own request timing and no inherited cache
expiry.

## 7. Persisting state (version 2)

```ts
await store.set("foldpoint", foldPoint.exportState());     // { version: 2, profiles, sessions }
const restored = new FoldPoint({ state: await store.get("foldpoint") });
```

- Profile learning is worth persisting; session runtime state is not, unless you want to
  resume an interrupted session with its cooldown and cache timing intact.
- Snapshots are plain JSON: numbers, strings and optional fields. No content, no secrets, no
  currency amounts.
- Unknown fields are ignored and missing fields fall back to defaults, so snapshots survive
  upgrades within version 2.
- A pre-release **version 1** snapshot is rejected with an explicit error. It stored an
  absolute compaction cost and merged profile and session state, which cannot be
  reinterpreted safely: reset it (`new FoldPoint()`) and start a fresh profile.
- `importState` replaces everything. Use one store key per workspace if profiles would
  otherwise collide.

## 8. Profiles for models and compactors

The learning key is the JSON tuple `[provider, model, contextWindowTokens, compactorId]`. Use
a distinct `compactorId` for every compactor implementation *and version*: a new summary
prompt is a new compactor, and its compression behaviour has to be learned separately.

```ts
const profiles = {
  cheap: { provider: "openai", model: "gpt-4.1-mini", contextWindowTokens: 128_000, compactorId: "summary-v2" },
  strong: { provider: "anthropic", model: "claude-sonnet-4", contextWindowTokens: 200_000, compactorId: "summary-v2" },
};
```

Do not derive a profile from message content, and do not reuse one profile across compactors.

## 9. Prices

Three options, in order of preference:

1. **Real prices** from your provider adapter. Cache prices matter: they are what makes a warm
   cache cheap to keep.
2. **Partial prices** — omit `cacheReadPerMillion` if the provider has no cache discount.
   FoldPoint will not invent savings from a cache it cannot price.
3. **`tokenOnlyPricing()`** — when you have no prices at all. Costs become token counts and the
   algorithm is unchanged.

Prices may change while a profile is in use: retention and usage learning are stored as
scale-free ratios, so the next decision simply reprices the compaction call with the new
snapshot. Nothing needs to be reset.

`actualCost` is optional and only used in currency mode: FoldPoint learns the dimensionless
ratio between your reported cost and its modeled cost (clamped to `[0.1, 10]`). In normalized
token-cost mode it is ignored, so a token count can never be mistaken for money.

## 10. Cache TTL

```ts
cachePolicy: { ttlMs: 300_000 }        // provider documents a fixed TTL
cachePolicy: { halfLifeMs: 60_000 }    // no documented TTL: model decay instead
cachePolicy: { disabled: true }        // no prompt cache at all
// or, per observation:
observeRequest(sessionId, profile, { ..., cacheExpiresAt: providerReportedExpiry });
```

An exact `cacheExpiresAt` on the input wins over everything else. Otherwise the session's
stored expiry is used — and it is **cleared** by any request observation that does not report
one, so an expiry reported for one prefix can never silently control a later one. With no
expiry information at all, FoldPoint falls back to the TTL, then to the half-life, and
otherwise assumes the candidate prefix is alive.

## 11. Handling the three actions

```ts
switch (decision.action) {
  case "KEEP":
    // Optionally honour the hint to avoid asking on every token:
    // schedule the next check at decision.nextCheckAtTokens
    break;

  case "COMPACT":
    if (canPauseNow) {
      const result = await hostAgent.compact();
      foldPoint.recordCompaction(sessionId, profile, { ...toObservation(result), success: true });
    }
    break;

  case "FORCE":
    // The window is at risk: compact at the nearest safe boundary, even if the host has
    // disabled economic compaction. Record the result exactly like a COMPACT.
    await hostAgent.compactAtNextSafeBoundary();
    break;
}
```

Log `decision.reasons` and `decision.metrics` verbatim; they are designed to answer "why did it
say that?" months later, including `breakEvenCalls`, `effectiveHorizonCalls`,
`estimatedCacheCoverageRatio` and `estimatedCacheAliveProbability`.

## 12. Failure handling

- Record a failed compaction attempt with `success: false`. It restarts the cooldown
  (`callsSinceLastAttempt`), so the next economic decision is `KEEP` with `COOLDOWN_ACTIVE`,
  and it teaches nothing about the compactor. Retry backoff beyond that is yours to implement:
  FoldPoint only prevents an immediate economic retry, and `FORCE` still fires when the window
  is at risk.
- Illegal input throws a `RangeError` (empty `sessionId`, negative tokens,
  `cachedTokens > contextTokens`, timestamps that are not finite, prices below zero,
  `emaAlpha` outside `(0, 1]`, ...). FoldPoint never silently repairs obviously wrong data.
- Malformed *state* never throws: it degrades to defaults, so a corrupted snapshot cannot
  break the agent loop. The one exception is the top-level version: version 1 is rejected
  explicitly.
- `decide` is synchronous and allocation-bounded. Do not call it in a per-token hot loop if
  you can use `nextCheckAtTokens` instead.

## 13. Checklist

- [ ] A stable, unique, non-sensitive `sessionId` per session.
- [ ] `observeRequest` after every model call, including the cache read count.
- [ ] `decide` at step boundaries, with an honest `safeBoundary`.
- [ ] `recordCompaction` after every attempt, with the real `success` flag.
- [ ] `endSession` at the end of the session (this is what teaches the horizon).
- [ ] One `compactorId` per compactor implementation and version.
- [ ] Prices (or `tokenOnlyPricing`) with consistent units.
- [ ] `cachePolicy` if the provider documents a TTL.
- [ ] Profile learning persisted; session runtime state either persisted deliberately or
      discarded.
- [ ] Reasons and metrics logged.
