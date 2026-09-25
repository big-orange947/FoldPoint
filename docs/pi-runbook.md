# Pi runbook: collecting the first real traces

Everything here was checked against a local Pi checkout (`packages/coding-agent`,
`packages/ai`, Pi 0.87) and, where marked, against a running Pi process. Re-check the two type
files if your Pi version differs — the adapter only uses the fields listed below.

```bash
pi --extension D:\project\FoldPoint\adapters\pi\foldpoint-observe.ts
```

### 0. Building Pi from source

A fresh checkout has no `dist/`, so Pi cannot run yet. On Node 22.17 the build fails at the
first step (`packages/ai` runs `node scripts/generate-models.ts`, and Node only strips
TypeScript types by default from 22.18 on):

```
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
  for packages/ai/scripts/generate-models.ts
```

Two ways around it, both verified:

```bash
# Node 22.17: allow type stripping and skip the network-bound model-catalog step
NODE_OPTIONS=--experimental-strip-types npm run build:offline
```

or use Node ≥ 22.18 and plain `npm run build`. The result is
`packages/coding-agent/dist/bundle/cli.js` (56 files, ~8 MiB).

## 1. What was verified against the source

| The adapter uses | Where it comes from | Checked |
| --- | --- | --- |
| `pi.on("context", …)` before every LLM call | `core/extensions/types.ts` → `ContextEvent` | ✅ |
| `pi.on("message_end", …)`, assistant messages carry `usage` | `MessageEndEvent` + `Message.usage?: Usage` | ✅ |
| `Usage = { input, output, cacheRead, cacheWrite, … }` | `packages/ai/src/types.ts` → `Usage` | ✅ |
| `ctx.getContextUsage()` → `{ tokens, contextWindow, percent }` | `ExtensionContext` | ✅ |
| `session_before_compact.preparation.tokensBefore` | `CompactionPreparation.tokensBefore` | ✅ |
| `session_compact.compactionEntry.tokensBefore` / `.usage` | `CompactionEntry` | ✅ |
| `Model.cost.{input,output,cacheRead,cacheWrite}` (USD per million) | `packages/ai/src/types.ts` → `ModelCost` | ✅ |
| `Model.promptCache.short` (seconds) → `cachePolicy.ttlMs` | `Model.promptCache` | ✅ (absent for DeepSeek, see §2.3) |
| `before_provider_request` carries the payload — **never subscribed** | `BeforeProviderRequestEvent.payload` | ✅ |

The adapter imports FoldPoint through a relative path (`../../src/index`), so running Pi with
`--extension <repo>/adapters/pi/foldpoint-observe.ts` works without publishing anything. If you
copy the file into `~/.pi/agent/extensions/` instead, change that one import to the installed
package (or to an absolute path) — nothing else.

### 1.1 Smoke test without a model call

Two levels, cheapest first.

**Inside a real Pi process.** Pi loads extensions during boot, before any model call, so this
proves the loader path without spending anything:

```bash
FOLDPOINT_TRACE=/tmp/foldpoint-pi-live.jsonl \
  node <pi>/packages/coding-agent/dist/bundle/cli.js --list-models \
    --extension <repo>/adapters/pi/foldpoint-observe.ts
```

Verified: the extension's header line appears in the trace file, written by the extension
factory while Pi boots. If the file is missing, the extension did not load.

**Without Pi at all.** Before spending a token, check that Pi's loader resolves the adapter and
that the event flow produces a valid trace. Run this from the Pi checkout (so `jiti` resolves)
with any Node:

```js
// .foldpoint-smoke.mjs — delete it afterwards
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const mod = await jiti.import("D:/project/FoldPoint/adapters/pi/foldpoint-observe.ts");

const handlers = new Map();
mod.default({
  on(event, handler) {
    handlers.set(event, handler);
    return () => {};
  },
});
console.log("registered:", [...handlers.keys()].join(","));

const model = {
  id: "claude-sonnet-4-5",
  provider: "anthropic",
  contextWindow: 32_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  promptCache: { short: 300 },
};
let tokens = 20_000;
const ctx = {
  model,
  cwd: "D:/tmp/scratch",
  getContextUsage: () => ({ tokens, contextWindow: 32_000, percent: tokens / 320 }),
};
const emit = (event, payload) => handlers.get(event)(payload, ctx);

emit("session_start", { type: "session_start", reason: "startup" });
emit("context", { type: "context" });
emit("message_end", {
  type: "message_end",
  message: { role: "assistant", usage: { input: 20_000, output: 300, cacheRead: 0, cacheWrite: 20_000 } },
});
emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
```

```bash
FOLDPOINT_TRACE=/tmp/foldpoint-smoke.jsonl node .foldpoint-smoke.mjs
```

Expected: `registered: session_start,context,message_end,session_before_compact,session_compact,
session_compact_failed,session_shutdown`, then a trace with one `decision` and one `request`
sharing a `callId`. `npm run trace:analyze -- /tmp/foldpoint-smoke.jsonl` must report
`unpaired decisions: 0`.

The numbers in that trace are the stub's, not a finding — the test only proves the wiring.

## 2. Cheap ways to test

Three costs to separate: **plumbing** (do events pair up at all), **per-call data** (is the cost
and cache prediction right), and **compaction data** (is the retention prediction right). Only
the third needs a context that actually fills up.

### 2.1 Plumbing: no real provider needed

Point Pi at any local OpenAI-compatible server through `~/.pi/agent/models.json`, or use the
cheapest hosted model you have. The goal is a session with a few calls, then:

```bash
npm run trace:analyze -- ~/.foldpoint/traces/pi-<stamp>.jsonl
```

`unpaired decisions` and `unpaired requests` must both be 0. If they are not, stop here — the
numbers behind them would be meaningless.

### 2.2 Make compaction cheap: shrink the *declared* window

Compaction only happens when the context approaches the window, and a full context costs real
money to build. Declare a smaller window for the model instead — Pi and FoldPoint both read it
from the same place, so everything stays consistent:

`~/.pi/agent/models.json`

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-sonnet-4-5": {
          "contextWindow": 32000,
          "promptCache": { "short": 300 }
        }
      }
    }
  }
}
```

Pi compacts at `contextWindow - reserveTokens` (`compaction.ts`), so with the defaults this
triggers at ~16k tokens. **Verified in a real Pi process** (Pi 0.87, `--list-models`):

```
without the override:  anthropic  claude-sonnet-4-5   1M    64K
with the override:     anthropic  claude-sonnet-4-5   32K   64K
```

Note the default window for that model is **1M**, not 200k — so shrinking it to 32k makes a
context-filling session roughly 30× cheaper, and the same code path produces the compaction
events.

`modelOverrides` is applied on top of the built-in provider (`provider-composer.ts`,
`applyModelOverride` merges field by field), so the provider, auth, prices and everything else
stay as they are — only the listed fields change.

If a 32k window with the default `reserveTokens` (16384) leaves too little room for a useful
session, lower `reserveTokens` as well (`settings.json`): `8192` compacts at ~24k instead of
~16k.

### 2.2.1 DeepSeek: what is different

DeepSeek is the cheapest provider Pi knows (verified with `--list-models`, Pi 0.87):

| model | window (default) | input | output | cache read | cache write |
| --- | --- | --- | --- | --- | --- |
| `deepseek-flash` | 1M | 0.30 | 1.20 | 0.006 | 0 |
| `deepseek-v4-pro` | 1M | 1.32 | 3.96 | 0.044 | 0 |

USD per million tokens, from Pi's generated catalog (`packages/ai/src/providers/data/deepseek.json`).
Auth comes from `DEEPSEEK_API_KEY` (`packages/ai/src/env-api-keys.ts`), so no `auth.json` entry
is needed.

The same window override works:

```json
{
  "providers": {
    "deepseek": {
      "modelOverrides": {
        "deepseek-flash": { "contextWindow": 32000 }
      }
    }
  }
}
```

```
without the override:  deepseek  deepseek-flash  1M    384K
with the override:     deepseek  deepseek-flash  32K   384K
```

Three properties differ from Anthropic, and each one changes what FoldPoint can predict:

- **Caching is automatic.** There is no cache-control marker to send, so nothing in the request
  decides what gets cached. Pi reads DeepSeek's `prompt_cache_hit_tokens` into `Usage.cacheRead`
  (`api/openai-completions.ts`), and `cacheWrite` stays 0: writes are free, reads are discounted.
  FoldPoint omits `cacheWritePerMillion` when the rate is 0, so the pricing snapshot stays
  truthful rather than carrying a zero price for a real operation.
- **No published TTL.** Pi's DeepSeek catalog has no `promptCache` field, so
  `profileFromModel` sets no `cachePolicy` and FoldPoint falls into its `assumed-alive` branch:
  the cache counts as alive whenever a candidate prefix exists (`src/cache.ts:247`). DeepSeek
  does evict idle caches, but it does not publish a TTL, so writing one into the override would
  be inventing the number being validated. Leave it out for collection; the `cache alive for the
  next call` table is exactly the measurement that would justify a TTL later.
- **A warm prefix can exist before the session starts.** A first call can already report cache
  hits from an identical prefix sent earlier on the same account, which a cold-start model
  cannot know. That is a real observation, not a bug — but it means the first call of a session
  is a poor calibration point for cache coverage.

**Verified in a real Pi process** (one `--print` call, `deepseek-flash`, 32k override):
`promptTokens 1211, cachedInputTokens 384, cacheWriteTokens 0, outputTokens 2`, cost predicted
`4.137e-4` against `2.504e-4` actual (over-prediction, because the cold-start model expected no
cache coverage).

**What a real session then showed** (16 calls, 7 compactions, 32k override, one `--print` run
over a 370 KB scratch file, $0.029 total). DeepSeek's cache is not a TTL cache: coverage per
call was 0.16–0.99, and the calls that follow a compaction are the interesting ones — the first
one replays the new prefix with `cachedInputTokens 1536` of `11764`, the next one already
`12032` of `12184`. Two consequences for collection:

- **Chunk the work, do not dump it.** Pi keeps whole entries when it compacts, so a single
  250-line read (~11k tokens) survives compaction in one piece. With `keepRecentTokens: 4000`
  the post-compaction context was still ~12k, which re-triggered compaction every two calls:
  7 compactions for 8 decided calls. Read in 60–80 line chunks instead, or accept the thrash as
  data.
- **The first call after a compaction cannot be decided.** Pi reports
  `getContextUsage().tokens = null` until an assistant message *after* the compaction reports
  usage (`agent-session.ts`), and the adapter will not invent a context size. Those calls are
  recorded as `#unpaired-N` requests with their real usage, and the analyzer counts them, but
  they carry no prediction. On this run that was 7 of 16 calls.

Pi's auto-compaction reported no `usage` on `CompactionEntry` either, so the cost of the
summarisation call itself is not in the trace: `C_compact` has no ground truth here, only the
decision's own call does.

### 2.3 Keep the test config out of your real one

`PI_CODING_AGENT_DIR` points Pi at a different agent directory, so the experiment can have its
own `models.json` and `settings.json` without touching `~/.pi/agent/`:

```bash
PI_CODING_AGENT_DIR=/tmp/foldpoint-agent pi --list-models sonnet
```

Use this for the cheap-testing configuration above: the real config stays untouched, and the
run is reproducible from a directory you can delete afterwards.

A complete DeepSeek run (this is the one that produced the numbers in §2.2.1):

```powershell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\foldpoint-agent"   # holds the 32k models.json above
$env:FOLDPOINT_TRACE      = "$env:USERPROFILE\.foldpoint\traces\pi-deepseek.jsonl"
node <pi>/packages/coding-agent/dist/bundle/cli.js --print "<task>" `
  --model deepseek-flash --no-approve `
  --extension <repo>/adapters/pi/foldpoint-observe.ts
```

The extension prints one line to stderr when it starts observing, so `--print` output and the
trace line do not mix: `[foldpoint] observing session <key> -> <path>`.

Note that a trace says which adapter wrote it (`producer`, e.g. `pi-observer@0.2.0`). Version
0.1.0 recorded Pi's uncached input as the whole prompt, so its cost numbers are wrong by the
cache hits of each call — delete or ignore 0.1.0 traces rather than mixing them into a batch.

### 2.3 What shrinking the window changes, and what it does not

| Changes | Does not change |
| --- | --- |
| when Pi compacts (earlier, in absolute tokens) | the per-call cache physics: TTL, gaps, cache read/write prices |
| how many compactions a session contains | the cost prediction being measured (`C_now`, `C_later`, tail pricing) |
| which FoldPoint decisions appear (utilization is a ratio, so the *mix* of KEEP/COMPACT/FORCE stays realistic) | the retention prediction: `afterTokens / beforeTokens` is a ratio |
| the absolute cost of a session | the dev/holdout split, the class rules, the error definitions |

Two rules follow:

- **Do not mix window sizes inside one analysis batch** unless you segment on
  `contextWindowTokens`, which every `decision` event records. Absolute costs and compaction
  counts are not comparable across window sizes.
- **A shrunk window is not a smaller model.** The window is a budget declaration; the model
  still sees the same prompts. Cache behaviour, latency and summary quality are unaffected, so
  the *shape* of the errors transfers — their magnitude in tokens does not.

### 2.4 Alternative lever, and when to use it

Raising `reserveTokens` in `~/.pi/agent/settings.json` (default 16384) makes Pi compact early
while the window stays realistic:

```json
{ "reserveTokens": 180000, "keepRecentTokens": 8000 }
```

Use this when you want **Pi's compaction** to happen cheaply but a realistic window: Pi compacts
at ~20k, while FoldPoint sees 20k/200k = 10% utilization and therefore mostly answers `KEEP`.
That is a legitimate observation — "FoldPoint would not have compacted here" is data — but it
does not exercise FoldPoint's own compaction decisions. For those, shrink the declared window
(§2.2) instead.

`keepRecentTokens` (default 20000) is worth lowering either way: it decides how much survives a
compaction, so a smaller value means cheaper calls afterwards *and* it exercises the retention
prediction.

### 2.5 Keeping a session short

- Use a small scratch repository for the test tasks; context growth is mostly tool output.
- Prefer `--print`/non-interactive runs with a scripted prompt over long interactive sessions.
- One session = one task. Long sessions are worth collecting, but collect a few short ones first
  and check that they analyse cleanly.
- Watch `~/.foldpoint/traces/pi-<stamp>.jsonl` grow; the file is plain JSONL and safe to inspect.

## 3. What to collect

A first batch worth analysing:

| Kind of session | Why |
| --- | --- |
| short task, no compaction | the baseline: predictions should be nearly exact |
| long tool-calling session with a stable prefix | cache reads at scale |
| session whose gaps exceed the TTL | the `laterAliveProbability` forecast, which is the model's weakest claim |
| session with a poor compactor (a summary that barely shrinks) | the retention prediction and the `F`/`L` costs |
| at least 5 sessions with a real `session_end` | the horizon error needs complete sessions |

Then:

```bash
npm run trace:analyze -- ~/.foldpoint/traces/*.jsonl --out ~/.foldpoint/report
```

Read `usableForCalibration` first, then the error tables. Sessions without `session_end` are
right-censored and excluded from the horizon metric — export complete sessions when you can.

## 4. Rules that keep the data honest

- **The observer never acts.** It does not compact, cancel or modify context, and it never reads
  the request payload. Acting on the decisions during collection would change the behaviour being
  measured.
- **Do not tune per trace.** After the first batch, change only the general model or its
  defaults, and check the holdout split.
- **A trace does not prove savings.** Only a paired experiment on the same tasks (FoldPoint
  against a guarded fixed threshold, same model and compactor) can compare total cost — and it
  must check task completion and tool correctness too, not only tokens.

## 5. The acting adapter decides *when*, never *how*

Worth stating precisely, because it is easy to mis-describe: FoldPoint's whole vocabulary is
`KEEP | COMPACT | FORCE` — a decision about the moment. It never writes a summary, never picks
what survives a compaction and never sees the compaction prompt. The profile carries
`compactorId` and the host reports the outcome back through `recordCompaction`, because the
compactor belongs to the host.

Verified against the Pi source (`core/extensions/types.ts`, `core/agent-session.ts`), the
timing is genuinely available to an extension:

| Pi mechanism | Effect | FoldPoint will |
| --- | --- | --- |
| `session_before_compact` returning `{ cancel: true }` | Pi throws `Compaction cancelled` internally, emits `session_compact_failed` with `aborted: true` and continues the session (`_runAutoCompaction` returns false) | **does**: `FOLDPOINT_MODE=act` vetoes a threshold compaction FoldPoint does not want |
| `session_before_compact` returning `{ compaction }` | the extension supplies the summary, `fromExtension: true` | **never** — that would be taking over the strategy |
| `ctx.compact(options?)` | triggers a compaction, `reason: "manual"` | **only in `FOLDPOINT_COMPACTION=auto`**, and only from an idle boundary: awaiting it inside a handler deadlocks (Pi waits for the handler, the manual compaction calls `abort()` and waits for the agent to go idle, and the agent is waiting for the handler), so the call is detached and fired once `ctx.isIdle()` is true. It still cannot promise "compacted before the next request" — see §5.1.1 |
| `settings.compaction.enabled = false` | Pi stops compacting on the threshold | not reachable: the extension context exposes no settings (13 capabilities, no `setAutoCompactionEnabled`) |

### 5.1 High-frequency control of Pi's threshold, and what it is not

`FOLDPOINT_MODE=act` answers Pi's `session_before_compact`:

- `reason: "overflow"` — never vetoed. That is Pi's last defence against a request that no
  longer fits, and FoldPoint's own `FORCE` is the same kind of net on its side.
- `reason: "manual"` — never vetoed. The user asked for it.
- `reason: "threshold"` — FoldPoint decides at that moment, with `preparation.tokensBefore`
  known, and vetoes only when it says `KEEP`.

A veto does not make Pi back off: the next check that still meets
`contextTokens > contextWindow - reserveTokens` asks again. That is what makes the mode useful
— **by moving Pi's threshold earlier, FoldPoint gets to answer at many more call boundaries**,
and its yes/no becomes the timing. Call it *high-frequency control of Pi's automatic threshold
compaction*, not unconditional control:

- it is not free. Pi prepares the compaction and resolves the summarisation request's auth
  *before* it asks the extension, so every check costs something.
- it is not asked at every boundary. When there is no compactable history yet,
  `prepareCompaction` returns nothing and the hook never fires.
- the threshold cannot be lowered without limit, because `keepRecentTokens` decides what
  survives: a threshold below what a compaction must keep would ask for compactions that free
  nothing.

A session that never reaches the threshold cannot be steered by this at all — which is why the
trial keeps a task that does and one that does not.

### 5.1.1 Advising, or acting: two mutually exclusive delivery paths

Vetoing is *delaying* a compaction Pi already wanted. The opposite question — compact **earlier**
than Pi's threshold — cannot be answered by a veto, and it is the question that matters at large
windows: with a 1M-token window Pi's own threshold is `1000000 - 16384`, so nothing is compacted
until the context is 98% full, while the cost of carrying a context and the quality of the answers
drawn from it both argue for compacting far sooner. `FOLDPOINT_COMPACTION` picks how that advice
is delivered:

| mode | what happens | risk |
| --- | --- | --- |
| `suggest` (default) | FoldPoint's "compact now" answer is put on Pi's status line, and the user is notified once per episode (again only after the context grows 20%) | none: the session is untouched |
| `auto` | the adapter asks Pi to compact via `ctx.compact()`, as soon as the agent is idle | the compaction aborts the current turn if a new one starts first; see below |
| `off` | neither | none |

**The two are mutually exclusive by construction**, and `/foldpoint auto|suggest|off` switches
between them at runtime (`/foldpoint status` prints the current state, the floor and the counters).
A reminder for something the adapter is already doing is noise, so `auto` drops the advice instead
of adding to it. Neither path runs below `FOLDPOINT_MIN_COMPACT_TOKENS` (default 8192): below one
reserve's worth of context there is nothing to reclaim, and the floor is a policy choice rather
than a measurement — the same reason the library's own window guard is a policy guard.

Why `auto` waits for idle: `ctx.compact()` starts with `await abort()`, and `abort()` waits for the
agent to go idle. Called from inside a handler the agent is blocked on, that wait never ends — the
agent is waiting for the handler to return. This is the deadlock that makes the naive version of
this unusable. Detaching the call and firing only once `ctx.isIdle()` is true avoids the cycle.

**Verified against a running Pi**, not just reasoned about: `tools/pi-compact-trigger-smoke.ts`
drives three arms through a loopback provider (zero paid calls) and reports the raw event stream.
Detaching the call, polling `isIdle()`, and compacting at an idle boundary completes the
compaction with no deadlock and no interrupted turn, consistently across runs; `onComplete` fires,
`session_compact` arrives with `reason: "manual"`, and every assistant message in the session file
keeps `stopReason: "stop"`. With `compaction.enabled: false` in that fixture, the compaction can
only have come from the extension — and Pi still wrote the summary (`fromExtension: false`), which
is the "when, never how" boundary holding in practice.

Two things that verification changed, both worth knowing before turning `auto` on:

- **`auto` acts at run boundaries, not mid-run.** `isIdle()` is false for as long as the agent run
  is active, so the wait ends when the turn settles — not in the middle of a long tool call. If the
  wait expires first, the advice simply fires again at the next model-call boundary; it is a retry,
  not a lost compaction.
- **A compaction is not invisible to the user.** While one is in progress Pi rejects a submitted
  prompt outright — `Cannot submit a prompt while compaction is in progress. Wait for compaction to
  finish and retry.` (`agent-session.ts:1627`) — and that check sits *before* the steer/follow-up
  queueing branches, so the message is refused rather than queued. The adapter therefore cannot
  promise "compacted before the next request", only "compacted while the session was idle".
  `suggest` has no such window because it never starts anything.

`agent_settled` (an extension event, `extensions/types.ts:824`) is the cleaner trigger: Pi clears
`_isAgentRunActive` *before* emitting it, so `isIdle()` is already true in the handler and no
polling is needed. It fires once per run, so it cannot compact mid-run either — the same boundary
this adapter reaches by waiting, without the wait.

### 5.2 Policy checks are not decisions

A vetoed threshold check is recorded as the *compaction attempt* Pi was about to make, marked
`errorCode: "vetoed"`, with the policy's reasons and how long the check took. It is **not** a
decision event: a session where Pi asks forty times must not look like a session with forty
decisions. The checks between two model calls are counted on the decision that follows them
(`compactionChecks`), and the report sums them separately under `## Compaction policy checks`.

### 5.3 The four arms a fair trial needs

Moving the threshold is part of the mechanism, not a side condition, so comparing "Pi as
configured" against "low threshold plus veto" compares two things at once. The clean design is
four arms, all with the same tasks, model and compactor:

| arm | threshold | mode | isolates |
| --- | --- | --- | --- |
| `default` | Pi's own | observe | the baseline |
| `ask` | low | observe | what asking more often alone does |
| `veto` | low | act | what FoldPoint's answers add on top |
| `late` | fixed late | observe | whether a simple delayed threshold matches the dynamic policy |

`tools/pi-paired-run.ts` runs all four arms. The `late` arm uses a 6K reserve, intended for
the controlled 26K-window trial (threshold at 20K), not as a universal Pi default. It compares
each arm with the default and FoldPoint with the fixed-late arm. Costs are paired by task and
repetition only when both runs exit successfully and pass the artifact check; unmatched
successful runs are reported but never used in the percentage delta.

The first real-provider, artificially capped 26K-window result is documented in
[`benchmarks/pi-real-paired-2026-09-24.md`](../benchmarks/pi-real-paired-2026-09-24.md).
It is provisional: the normal 1M DeepSeek window did not compact on the short connectivity
task, and a tuned fixed late threshold has not yet been compared.

### Pi 0.87 cache warming and experimental control

Pi's `cacheWarming` (default `streaming`) may replay a cached request with a one-token output
cap before the provider TTL expires. It is a separate, paid intervention: Pi persists a
`usage` entry with `kind: "cache_warm"`, but it does **not** emit a normal model-call
`context`/`message_end` pair. The FoldPoint adapter reads only those usage entries (no message
payload), records `cache_warm` trace events, adds their actual priced cost to the session, and
uses the most recent successful refresh when estimating idle time against the TTL. A mere
`cache_warming_decision` does not prove a refresh occurred and is not treated as one. Pi's
warmer can stop after a compaction or model switch, so an attempted warm must never be
assumed to survive those transitions. The adapter follows `PI_CACHE_RETENTION=long` when
selecting Pi's declared TTL; a per-request retention override is not exposed by its current
hook and remains a prediction limitation.

The four-arm paired **compaction-timing** trial defaults to `cacheWarming: "off"` in each
fresh experiment agent directory. This isolates the timing policy; it does not claim FoldPoint
is better with Pi warming enabled. Run the same four arms with
`--cache-warming streaming` (or `idle`) as a separate factorial stratum, comparing total
call + compaction + warm cost, quality and task completion. Never mix `off` and `streaming`
results in one percentage comparison.
Production use does not disable Pi's warming. On a model without a declared `promptCache`
lifetime, Pi cannot schedule this warmer; DeepSeek's current Pi model entry is in that class.

For a controlled DeepSeek task under **hypothetical price ratios**, see
[`benchmarks/pi-price-ratio-plan.md`](../benchmarks/pi-price-ratio-plan.md). The runner uses
Pi's per-model cost override in a fresh agent directory and verifies the same price snapshot
in every decision trace. This is a pricing-policy sensitivity test, not a provider billing
experiment; cache warming must be off because its usage record carries an actual-price cost.

For a zero-paid integration check against a local Pi checkout, point the smoke runner at
Pi's built CLI bundle. It starts a loopback OpenAI-compatible fake provider, runs the same
two-call task with warming `off` and `streaming`, and keeps each Pi agent/session/trace in
its own temporary directory. If the shell's Node is older than Pi requires, set `PI_NODE`
to a suitable Node executable:

```powershell
$env:PI_CLI = 'D:\pi\packages\coding-agent\dist\bundle\cli.js'
$env:PI_NODE = 'C:\path\to\node.exe' # Node >= 22.19; omit if your PATH Node qualifies
npx tsx tools/pi-cache-warming-smoke.ts
```

The assertions require a cold second call with warming off, a cache-hit second call with
warming on, separate `cache_warm` usage/cost, and no next-call cache-survival calibration
across a warm. The exact count of one-token refreshes depends on timing. The fake provider
chooses its own token counts, prices and TTL, so a pass proves the Pi/FoldPoint integration
and accounting path, **not** a cost or quality improvement for DeepSeek or another provider.

### 5.2 What Pi would have to expose for the rest

The extension API cannot do everything FoldPoint needs. Two gaps, both of them "Pi already
knows this and does not say it", which is the shape of change worth proposing upstream:

1. **`session_compact` carries no `estimatedTokensAfter`.** Pi computes it
   (`agent-session.ts`, `estimateMessagesTokens(...)`) and passes it to `CompactionResult` for
   its own caller, but the extension event carries only `compactionEntry`, `fromExtension`,
   `reason` and `willRetry`. An observer therefore cannot decide the first call after a
   compaction — 7 of 16 calls in the first real session — and has to wait for the next
   `context` event to learn the size at all.
2. **No awaitable compaction trigger.** `compact()` returns `void`; only `onComplete`/
   `onError` callbacks report the outcome. Awaiting a callback inside a `context` handler
   would block the request path for the duration of a summarisation call *and* race the
   request being built, so an extension can delay a compaction but cannot bring one forward.

Successful compaction cost is visible when `CompactionEntry.usage` is populated on the
automatic path: the extension records it as the compaction event's `usage` (`promptTokens`,
`outputTokens`, …). Measured across those collected sessions, compactions were 16–35% of
observed session cost. **Failed compactions are different:** Pi's `session_compact_failed`
event has no usage, and the summarized request may already have reached the provider. The
analyzer therefore reports a lower bound and paired cost comparisons exclude these runs.

Until those two exist, the plugin is the only place this can live — and it is a reasonable
place for it: the policy needs calibration that is still moving, and Pi's core should not
inherit a third-party cost model's release cadence.

## 6. The paired trial

Everything above measures *predictions*. Whether FoldPoint's timing is better than Pi's own is
a separate question, and the only honest way to answer it is to run the same tasks twice.

```bash
PI_CLI=<pi>/packages/coding-agent/dist/bundle/cli.js \
PI_CODING_AGENT_DIR=/tmp/foldpoint-agent \
PI_SCRATCH=/tmp/foldpoint-scratch \
npx tsx tools/pi-paired-run.ts --reps 3
```

The protocol is fixed before the first run, because a task chosen after seeing the numbers is
not evidence:

- **Controlled arms**: `default` uses Pi's standard threshold; `ask` moves only the threshold;
  `veto` adds FoldPoint's answer on top of `ask`. Model, compactor, prompts and
  `cacheWarming: "off"` are fixed across arms.
- **Machine-checkable artifacts**. `tools/pi-paired-run.ts` ships five tasks: two append the
  first line number of each 60-line chunk to `notes.md` (8 exact values), one writes the sum of
  1..1000 to `out-sum.md` (500500), `ledger` repairs code against an independent oracle, and
  `pricing-regression` repairs an injected bug in a frozen copy of this repository. The last
  task requires a local `npm ci` in the FoldPoint checkout before running; the runner copies
  those dependencies into each arm without modifying the checkout or fetching packages.
  A run that is cheaper and wrong is not a win, so the check is printed next to the cost and a
  missing or incorrect artifact is visible in the table.
- **Cost from the traces**, not from an estimate: `analyzeTraceEvents().sessionCosts` prices
  reported ordinary calls, output included, plus compaction attempts with usage and observed
  cache refreshes. Pi does not report failed compactions' usage; a run containing them has only
  an observed-cost lower bound. `trace:analyze` prints the cost table under `## Session cost`.
- **Both directions matter**. A task that never reaches the threshold cannot show a timing
  difference (`sum` and the first `ledger` probe were such controls). Paired cost deltas only
  include matched, quality-passing runs in which at least one arm actually compacted. The
  report counts and excludes zero-compaction pairs instead of presenting their cost noise as
  a policy effect. It also excludes pairs with failed/aborted compactions whose provider usage
  Pi did not report: their observed cost is only a lower bound. A compaction in one arm is
  necessary, not sufficient, to attribute a saving to timing; inspect call paths and repeat
  the experiment.

`PI_SCRATCH` must be an existing seed directory; `steps` and `resume` require `big.txt` there,
while `ledger` and `pricing-regression` seed their own fixtures. `PI_CODING_AGENT_DIR` must be
an existing experiment configuration directory. The runner copies the seed into a new per-run
workspace and copies `settings.json`/`models.json` into a new per-run agent directory; it never
clears the seed, edits the base settings, or copies `auth.json`. Supply provider credentials
through the environment. Existing trace paths are
refused rather than overwritten, so use a fresh `--out` prefix when repeating a trial.

What the trial still cannot do: a handful of runs on one model is a signal, not a result. The
model is not deterministic, so per-run cost varies with how much new text each call carried, and
the cost model's remaining error (see `limitations.md` §4) feeds straight into the decisions
being compared. Read the table as "does this direction look plausible", not as a saving.
