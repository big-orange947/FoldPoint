# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Benchmark credibility revision

No core behaviour changed; the scope is the benchmark, its tests and the documentation.

- **"Unnecessary compaction" is measured against an independent shadow branch** instead of
  approximating the counterfactual with the actual cache coverage. Each successful, non-forced
  compaction opens a branch with its own context, its own `lastPromptTokens` / `lastCallAt` /
  cache flags and its own cost total; it receives exactly the same growth and prices its own
  calls. The interval settles at the next successful compaction or at session end:
  `realizedSaving = shadowCost - actualIntervalCallCost - attemptCost`.
- **Shadow overflow rule**: if the counterfactual branch would have run past the window during
  the interval, the compaction is never counted as unnecessary, and the shadow's emergency
  recovery is recorded as a counterfactual cost. Documented in `benchmarks/README.md` and
  exposed per record as `shadowOverflowed`.
- **The benchmark calls the core `computeBreakEvenCalls`** instead of maintaining a second
  formula. The recorded inputs (`staticBreakEvenInputs`) are exposed so every value can be
  recomputed; model output tokens are excluded because they cancel on both sides.
- **Metrics renamed**: `meanBreakEvenCallsAtCompaction` →
  `meanStaticBreakEvenCallsAtCompaction` (a local static estimate, not a dynamic payback) and
  `meanEstimatedBreakEvenCallsAtCompaction` →
  `meanFoldPointEstimatedBreakEvenCallsAtCompaction`. Added `judgedCompactionCount`,
  `totalOfferedGrowthTokens` and `growthSequenceFingerprint`.
- **Calls that rebuild a lapsed cache prefix are billed at the cache-write price**, matching
  the engine's own model, instead of the plain input price.
- The growth schedule is materialized once from a single RNG advanced step by step
  (`buildGrowthSequence`); scenarios may vary the idle gap (`idleMsAfterStep`).
- Ten targeted benchmark tests were added: warm-cache shadow accounting, cold-cache billing,
  independent TTL expiry per branch, break-even equality with the core solver, the
  `K=9, F=5, L=2, C=5 → 4` fixture, a non-repaying compaction, the shadow-overflow rule,
  failed attempts opening no shadow, growth fairness across all nine strategies, and a check
  that the README aggregate table matches the committed report JSON exactly.
- The README's "5 unnecessary compactions / 4%" claim and the ground-truth framing of the
  static break-even are explicitly withdrawn and replaced.

## Core correctness revision

The pre-release v0.1 API and state format changed; state version 1 snapshots are rejected
rather than reinterpreted.

### Changed

- **State is split in two.** `FoldPointProfileLearningState` (shared by every session of a
  profile) now holds only scale-free ratios and counts; `FoldPointSessionState` (one
  `sessionId`) holds request counts, attempt counters, cooldowns, timestamps and the exact
  cache expiry. `endSession` learns the reuse horizon into the profile and deletes the
  session runtime state.
- **Every stateful call takes a `sessionId`**: `observeRequest(sessionId, profile, ...)`,
  `recordCompaction(sessionId, profile, ...)`, `endSession(sessionId, profile, ...)`, and
  `decide({ sessionId, profile, ... })`. `getSessionState` / `resetSession` were added.
- **State keys are JSON tuples**, so a `|` inside a field can no longer collide:
  `profileKey = [provider, model, window, compactorId]`, `sessionKey = [profileKey, sessionId]`.
- **Cache coverage and cache aliveness are separate quantities.** Coverage comes from the
  reported `cachedTokens` or the learned coverage EMA; aliveness comes from an exact expiry,
  a TTL, a half-life, or is assumed when a candidate exists and nothing is known. They meet
  exactly once in `estimatedEffectiveCachedTokens`, so coverage is never discounted twice.
- **The compaction call is priced from usage ratios** (`compactPromptRatio`,
  `compactOutputRatio`, `compactCachedInputRatio`, `compactCacheWriteRatio`) scaled to the
  current context and the current prices. The absolute `compactionCostEma` was removed.
- **Break-even is solved exactly**: `(K + F - L) / (C - L)`, exposed as the pure
  `computeBreakEvenCalls`.
- **Cooldown is restarted by any attempt**, successful or not
  (`callsSinceLastAttempt`, `compactionAttemptCount`).
- **Confidence** now weights retention 0.40, compaction usage 0.20, cache coverage 0.20 and
  horizon 0.20 (previously retention/cache/horizon only).
- `cacheValuableThreshold` was renamed to `cacheAliveThreshold`, because it compares the alive
  probability.

### Removed

- The context-regrowth heuristic (`growthPerCallEma`, `growthSamples`, `lastPromptTokens`,
  `callsUntilRefill`) and the absolute compaction cost fields
  (`compactionCostEma`, `compactionCostSamples`).
- `estimatedCacheSurvival`, replaced by `estimatedCacheCoverageRatio`,
  `estimatedCacheAliveProbability` and `estimatedEffectiveCachedTokens`.

### Fixed

- A stale exact cache expiry can no longer control a newer prefix: any request observation
  without `cacheExpiresAt` clears the stored one.
- A failed compaction attempt now actually starts the cooldown; previously the next economic
  decision could immediately retry.
- Coverage is no longer multiplied into the replay cost twice (0.8 coverage with 0.5 aliveness
  is an effective 0.4, not 0.32).
- Compaction cost scales with the context instead of reusing an amount learned at another
  size, and a token-only profile can no longer be repriced as if token units were currency.

### Added

- `docs/algorithm.md` documents the model in computation order, including the corrections and
  additions relative to the task book.
- Benchmark: independent growth and failure RNG streams, real `successRate` consumption,
  guarded fixed-threshold baselines, scenario `K` (flaky compactor), attempt/success/failure
  metrics, and cache-write billing shared with the engine through `costOfUsage`.

## [0.1.0] - 2026-09-22

### Added

- `FoldPoint` decision engine returning `KEEP` / `COMPACT` / `FORCE`.
- Cache-aware, price-aware break-even estimation.
- Window safety guard that overrides economics.
- Quality guards: safe boundary, host opt-out, cooldown, minimum reclaim.
- Online learning via EMA: retention, compaction usage ratios, cache coverage, reuse horizon.
- Cold-start defaults in a single file, all overridable.
- Per-profile learning isolation, JSON-serializable state export/import.
- Structured reason codes and a full metrics block on every decision.
- Unit, scenario, serialization, invariant and benchmark test suites.
- Deterministic simulation benchmark with fixed-threshold baselines.
- Documentation: algorithm, integration, limitations.
