# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pi 0.87 cache warming compatibility and safer paired trials

- Trace v2 records successful, paid `cache_warm` usage separately from agent requests; the
  analyzer includes refresh cost and excludes cache-survival comparisons crossed by warming.
  Existing v1 traces remain readable but cannot reconstruct unrecorded warming costs.
- The Pi adapter uses persisted `cache_warm` usage entries to refresh its TTL clock, without
  treating a proposed warm as successful or subscribing to provider request payloads.
- Paired runs use fresh seed workspaces and per-run Pi settings. They no longer recursively
  clear `PI_SCRATCH` or edit the base agent settings. Warming is fixed across arms (off by
  default, optionally streaming/idle), and percentage deltas use matched successful reps.

### Pi runbook

`docs/pi-runbook.md`: how to collect the first real traces, checked against a local Pi checkout.

- the adapter's assumptions are listed with the file each one comes from
  (`ContextEvent`, `MessageEndEvent` + `Message.usage`, `Usage`, `getContextUsage`,
  `CompactionPreparation.tokensBefore`, `CompactionEntry`, `Model.cost`, `Model.promptCache`,
  and the `before_provider_request` payload the adapter never subscribes to)
- a **smoke test that costs nothing**: load the adapter through Pi's own loader (jiti) with a
  stub `ExtensionAPI`, drive one session, and check that the trace pairs — run before spending a
  token, and again after changing the adapter or upgrading Pi
- how to run it without publishing: `pi --extension <repo>/adapters/pi/foldpoint-observe.ts`,
  and the one import line to change if the file is copied into `~/.pi/agent/extensions/`
- **cheap testing**: declaring a smaller `contextWindow` through
  `~/.pi/agent/models.json` → `providers.<id>.modelOverrides.<modelId>` makes Pi compact at
  ~16k instead of ~184k tokens, because Pi and FoldPoint read the same window. `modelOverrides`
  merges field by field on top of the built-in provider, so costs and auth are untouched
- what shrinking the window changes (when Pi compacts, how many compactions a session has, the
  absolute cost) and what it does not (cache physics, the cost and retention predictions, the
  decision mix, the class rules) — with the rule not to mix window sizes inside one analysis
  batch unless segmenting on the recorded `contextWindowTokens`
- the alternative lever (`reserveTokens` in settings) and when it is the wrong one: Pi compacts
  cheaply while FoldPoint sees low utilization and mostly answers `KEEP`
- what a first batch should contain, and the rules that keep it honest: the observer never acts,
  no per-trace tuning, and a trace still does not prove savings

### Trace statistics review fixes, and the Pi observer

Five review findings on the v0.2 trace layer, plus the first real-host adapter.

**Fixed (analysis)**

- A session without a `session_end` event is now treated as **right-censored**: it is excluded
  from the horizon error and from the near-end class, because its last recorded call is not known
  to be the last call. A long session exported halfway through used to make the horizon look
  over-predicted. The analysis reports `censoredSessions` and says so in the report.
- An unreported `cachedInputTokens` is now **unknown, not a miss**: such a request is excluded
  from the cache calibration, from the cost error (which needs the whole prompt breakdown) and
  from the session's cache-hit rate, and is counted in `unknownCacheUsage`. Treating unknown as
  zero used to pollute both the calibration and the classification.
- The next-call cache comparison now requires the two calls to be **the same path**: it is
  skipped, and counted by reason (`compaction`, `profileChange`, `unknownNextDecision`), when a
  compaction or a model/compactor change happened in between.
- A trace with unreadable lines is no longer reported on: the command **exits non-zero and
  writes nothing** by default. `--allow-errors` writes a report that carries
  `usableForCalibration: false` and says so in its first lines.
- Runtime validation of the whitelisted label fields (`sessionId`, `callId`, `producer`,
  `reason`, `errorCode`): the recorder and the reader reject anything outside
  `A-Za-z0-9._@:/+#-` (max 64/128 characters) instead of writing it, so a free-form field cannot
  become a sentence or a credential.

**Added**

- `adapters/pi/foldpoint-observe.ts`: an **observe-only** Pi extension. It runs FoldPoint before
  every model call, records what FoldPoint would have decided and the usage Pi reports after the
  call, and records Pi's compactions. It never compacts, never cancels, never modifies context,
  and never subscribes to `before_provider_request` — the request payload is not read, so it
  cannot be written. Session keys are runtime-scoped counters rather than Pi's session id or
  session file path.
- Pairing diagnostics: a call without a decision before it, or a decision without a call, is
  counted and logged at session end, so an unusable trace is visible instead of averaged.
- The adapter does not guess the cache state (`cachedTokens` omitted) or the horizon
  (`expectedFutureCalls` omitted), because guessing would make the calibration circular.
- `docs/traces.md` gains a **Privacy** section: the format has no content fields, but session
  identifiers, timestamps and free-form labels can still identify a person or reveal work
  patterns; use irreversible session identifiers and keep the trace with your logs.
- `tsconfig.json` now includes `tools` and `adapters` explicitly.

**Tests**

- 15 new: right-censored sessions (excluded from the horizon and the near-end class, included
  again once `session_end` exists), unknown cache usage (excluded from calibration and cost,
  does not turn a served session cold), path continuity (skipped after a compaction or a model
  change, still compared when unchanged), the CLI refusing to report on unreadable lines and
  marking a `--allow-errors` report as unusable, label validation, and the Pi observer
  (subscribed events, decision/request pairing, unpaired calls, deferred compaction size,
  skipped decisions, two sessions in one trace).

### Real-trajectory validation (v0.2, step 1)

The synthetic benchmark is reproducible but synthetic. This adds the host-agnostic layer for
validating the model against real agent sessions, without touching the decision path.

**Added**

- `TraceRecorder` and the versioned JSONL trace format (`TRACE_FORMAT_VERSION = 1`,
  `src/trace.ts`). Events: `header` (format version, library version, the resolved defaults),
  `decision` (the profile, the input, the action with reason codes and the full prediction
  block), `request` (what the provider reported after the call), `compaction` (before/after
  tokens, usage, cost, success) and `session_end`.
- The format keeps the two things apart on purpose: the *estimate* made before a call and the
  *actual* cache read/write tokens the provider reports after it. A host cannot know the latter
  at decision time, and a trace that conflates them cannot calibrate anything.
- Metadata only: there is no field for prompt text, tool output, chat content or credentials.
  The decision input FoldPoint already receives is metadata by construction.
- `validateTraceEvent`, `parseTraceJsonl` and `isTraceEvent` for reading traces back without
  silently repairing them; malformed lines are reported with their line number.
- `FOLDPOINT_VERSION`, recorded in every trace header and kept in sync with `package.json` by a
  test.
- `examples/trace-capture.ts` and `npm run trace:capture`: the wiring example — four hook calls
  around a stand-in provider, with a three-line JSONL writer.
- `tools/trace-analyze.ts` and `npm run trace:analyze`: offline analysis that pairs decisions
  with requests by `callId` and reports prediction error for call cost (prompt side; the
  post-compaction replay is compared against `estimatedFirstPostCompactReplayCost`), cache
  aliveness for this call and for the next one, retention and the remaining-call horizon, by
  scenario class (cold cache, one-off expiry, near end, steady) and split into a deterministic
  development/holdout set. It writes a markdown report and the raw numbers as JSON, and states
  in the report itself what a trace cannot prove.
- `docs/traces.md`: the format, the host wiring contract, the analysis, and the limits — a
  replayed trace with a different compaction time is not a counterfactual, and task quality is
  not measured.
- `estimatedFirstPostCompactReplayCost` is now a metric, so a post-compaction call can be
  compared against the prediction that applies to it instead of against the current-call cost.
- `expectedFutureCalls` is documented as counting the call being decided, which is what the
  break-even formula assumes; a host that counts only the later calls understates the horizon by
  one.

`traces/` is gitignored: real trajectories are the operator's data, not repository content.

### Cache-forecast review fixes

Two bugs in the previous revision, found in review. Both are fixed with exact regression
tests; the report was regenerated.

**Fixed**

- The later-call forecast reused this call's served-token count as the reusable prefix. A host
  that follows `docs/integration.md` and reports `cachedTokens: 0` for a lapsed prefix therefore
  had *every* later call priced as a full cache write, even though
  `laterAliveProbability` said the prefix survives. `estimateCacheModel` now reports
  `laterCandidateTokens` as its own quantity, resolved as the largest prefix the evidence
  supports: what this call was served, else the learned coverage, else the whole prompt the
  provider was just sent. Reporting `0` and reporting the lapsed prefix size now reach the same
  decision, and the estimate is monotone in `cachedTokens` (the existing invariant test caught
  the first version of this fix, which was not).
- `computeBreakEvenCalls` returned `null` as soon as `C_later - L <= 0`, and the economic gate
  treats `null` as "never compact". That reported "no recurring saving" as "not worth doing"
  even when the compaction was already cheaper than the current call alone
  (`C_now = 8, C_later = 1, K = 1, F = 1, L = 2` → keep 8 against compact 2). The immediate
  repayment check (`K + F <= C_now` → `0`) now runs first; `null` is reserved for a compaction
  that is neither immediately repaid nor has a per-call saving, and the horizon net saving
  decides the rest.

**Changed**

- `estimatedCacheLaterCandidateTokens` is a new metric, so the prefix the forecast uses is
  auditable from a decision log.
- The later post-compaction replay uses the same reuse fraction as the kept context
  (`laterCandidateTokens / T`) instead of the raw coverage EMA, so one quantity drives both.
- The benchmark's static break-even inputs now use the hit rate the *host* has observed,
  mirroring the learner's coverage EMA, instead of passing zero coverage samples.
- The report changed with the corrected economics: FoldPoint 136.00 → 136.37, 125 → 121
  attempts, 80 judged, 7 unneeded (5 in `F`, 2 in `I`), 0 overflows. In `B`, `C`, `G`, `H` and
  `K` no economic compaction is repaid any more, so every compaction there is a window-safety
  `FORCE`; `I` now runs three economic compactions where it ran one. The 136.00 / 6-of-82 row
  is withdrawn with the bugs.

**Tests**

- `17.3e`: the doc-conformant host (`cachedTokens: 0`, lapsed TTL) reaches exactly the same
  keep cost, later-call cost, break-even and decision as the host that reports the lapsed
  prefix.
- `17.3f`: with no cache history at all the reusable prefix is the prompt just sent.
- `17.4c`: `C_now = 8, C_later = 1, K = 1, F = 1, L = 2` returns `0` (immediately repaid), with
  the keep/compact totals for 1 and 3 calls spelled out, while a compaction that is not
  immediately repaid and has no per-call saving still returns `null`.

### Cache-billing semantics revision

One rule now prices every model call, in the engine and in the benchmark alike, and the
current call is priced separately from the later calls.

**Breaking changes**

- `computeBreakEvenCalls` takes five inputs instead of four:
  `{ currentCallReplayCost, laterCallReplayCost, compactCallCost, firstPostCompactReplayCost,
  laterPostCompactReplayCost }`. The solution is
  `1 + (K + F - C_now) / (C_later - L)`, which reduces to the previous
  `(K + F - L) / (C - L)` whenever `C_now == C_later`. The old shape could not express a call
  that has to write a prefix while the later calls do not.
- `estimateCacheModel` returns `laterAliveProbability` and `cachingInPlay` in addition to the
  existing fields; `costOfCall` and the two new cache helpers are exported.

**Added**

- `costOfCall(prices, promptTokens, { prefixTokens, aliveProbability, cachingInPlay },
  outputTokens)`: the single call-billing rule. A live prefix is read at the cache-read price
  with the appended tail at the input price; a prefix that is not alive — or that does not
  exist yet while caching is in play — makes the whole prompt a cache write; without a cache
  discount the prompt is plain input and no write premium is invented.
- `resolveLaterAliveProbability`: the forecast for the calls *after* the one being decided. It
  keeps the smooth form of a half-life policy and otherwise assumes the prefix written by the
  current call survives, because one lapsed gap is evidence about that gap, not about every
  future one.
- `isCachingInPlay`: true when a cache discount exists, caching is not disabled, and either a
  prefix was observed or the policy describes one.
- Metrics `estimatedCurrentCallReplayCost`, `estimatedLaterCallReplayCost` and
  `estimatedCacheLaterAliveProbability`, so the split is visible to hosts.

**Changed**

- The keep cost is `C_now + (R - 1) * C_later` instead of `R * C`. Multiplying one replay cost
  by the whole horizon charged every future call as if it too would find the cache gone.
- A call whose cache prefix has lapsed is billed at the cache-write price. Previously the
  engine billed it at the plain input price while the benchmark billed it at the write price;
  the two now agree, and with no `cacheWritePerMillion` nothing changes.
- The benchmark's static break-even inputs are the core's rule evaluated on the simulation's
  cache state, with `C_now` and `C_later` recorded separately.
- Behaviour note: a host that reports a served prefix while its own TTL says the prefix lapsed
  is contradicting itself, and the forecast will price the future optimistically. A host whose
  gaps reliably exceed its TTL should describe that regime with a half-life policy, or report
  no served prefix (which the model reads as "this prompt has to be written").

**Fixed**

- `costOfCall` output tokens are charged whatever the cache does; an intermediate revision of
  this change dropped them from the cache-alive branch.

**Tests**

- An exact test for a write premium (`cacheWritePerMillion > inputPerMillion`) with a lapsed
  TTL: the current call is billed at the write price, the later calls are not, the keep total
  charges the write once, and `breakEvenCalls` is `3.419354838709677` from the recorded inputs.
- Tests for the later-call forecast and `cachingInPlay`, for output tokens under every cache
  state, for the "no write premium without a cache discount" case, for the generalized
  break-even (`C_now = 8, C_later = 5, K = 9, F = 5, L = 2 → 3`, and `→ 4` with
  `C_now = 5`), and for the benchmark's `C` when the cache has lapsed.

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
