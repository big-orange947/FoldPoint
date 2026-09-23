# Pi runbook: collecting the first real traces

Everything here was checked against a local Pi checkout (`packages/coding-agent`,
`packages/ai`). Re-check the two type files if your Pi version differs — the adapter only uses
the fields listed below.

```bash
pi --extension D:\project\FoldPoint\adapters\pi\foldpoint-observe.ts
```

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
| `Model.promptCache.short` (seconds) → `cachePolicy.ttlMs` | `Model.promptCache` | ✅ |
| `before_provider_request` carries the payload — **never subscribed** | `BeforeProviderRequestEvent.payload` | ✅ |

The adapter imports FoldPoint through a relative path (`../../src/index`), so running Pi with
`--extension <repo>/adapters/pi/foldpoint-observe.ts` works without publishing anything. If you
copy the file into `~/.pi/agent/extensions/` instead, change that one import to the installed
package (or to an absolute path) — nothing else.

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

Compaction only happens when the context approaches the window, and a 200k context costs real
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
triggers at ~16k tokens instead of ~184k: **about a 10× cheaper way to produce compaction
events**, with the same code path.

`modelOverrides` is applied on top of the built-in provider (`provider-composer.ts`), so the
provider, auth and everything else stay as they are — only the listed fields change.

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
