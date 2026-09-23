# Real-trajectory validation (v0.2)

FoldPoint v0.1 ships a reproducible *synthetic* benchmark. This document describes the
*real*-trajectory layer that sits next to it: a versioned JSONL format, a pure recorder, a
capture example and an offline analysis command.

The goal is narrow: find out whether a real agent's cache hits, session lengths and compaction
results behave the way the model predicts, and let the next round of changes be driven by
measured error instead of another synthetic scenario. It is **not** a way to claim savings yet
— see [What a trace cannot prove](#what-a-trace-cannot-prove).

```bash
npm run trace:capture                      # writes traces/example.jsonl (a wiring example)
npm run trace:analyze -- traces/example.jsonl
```

## 1. What a trace contains

One JSON object per line, in observation order. Every event is **metadata only**: timestamps,
token counts, prices, cache usage, the decision and the model's estimates. There is no field for
prompt text, tool output, chat content or credentials, and none may be added.

That is a statement about the *format*, not a guarantee about the *data*. A trace is still a
record of when someone worked and on which model, and the strings it does carry — `sessionId`,
`callId`, `producer`, `reason`, `errorCode` — are written by the host. Read
[Privacy](#6-privacy) before recording anything you would not hand to a colleague.

The distinction the format exists for:

| | recorded in | known when |
| --- | --- | --- |
| cache state and cost **estimates** | `decision` event | before the call |
| cache read/write tokens the provider **actually reported** | `request` event | after the call returns |

A host cannot know the actual cache usage at decision time. A trace that conflates the two
cannot calibrate anything, so they are separate events with separate fields.

### Events

`header` — the first line. Pins the format version, the library version and the **resolved
defaults** in force, so a trace can be tied back to the model that produced its predictions.

```json
{"v":1,"type":"header","seq":0,"timestamp":1700000000000,
 "library":{"name":"foldpoint","version":"0.1.0"},
 "defaults":{"retentionRatio":0.4,"...":"..."},"producer":"my-agent@1.2.3"}
```

`decision` — one per `decide()` call, written **before** the request. Carries the session id, a
`callId` that pairs it with the request, the profile (model, window, compactor, prices, cache
policy), the decision input, the action with its reason codes, and the full prediction block.

```json
{"v":1,"type":"decision","seq":1,"timestamp":1700000010000,"sessionId":"s-1","callId":"s-1#1",
 "profile":{"model":"claude-...","contextWindowTokens":200000,"compactorId":"summary-v2",
            "pricing":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0.3,
                       "cacheWritePerMillion":3.75},"cachePolicy":{"ttlMs":300000}},
 "input":{"contextTokens":142000,"cachedTokens":138000,"idleMs":9000,"expectedFutureCalls":12},
 "decision":{"action":"KEEP","reasons":["CACHE_STILL_VALUABLE"],"confidence":0.71},
 "prediction":{"estimatedCurrentCallReplayCost":0.0489,"estimatedLaterCallReplayCost":0.0489,
               "estimatedPostCompactTokens":56800,"estimatedCacheAliveProbability":1,
               "estimatedCacheLaterAliveProbability":1,"...":"..."}}
```

`request` — one per real model call, written **after** it returns. This is where the provider's
actual `promptTokens`, `cachedInputTokens`, `cacheWriteTokens`, `outputTokens` and (when
reported) `actualCost` go, plus latency and an outcome.

`compaction` — one per compaction attempt: `beforeTokens`, `afterTokens`, `success`, the
compaction call's own usage and cost, its duration, and an optional short `errorCode`.

`session_end` — closes a session. The horizon is still measurable without it, but it is what
tells the analysis that a session is complete.

## 2. Wiring a host

Three hooks, in the order they happen:

```ts
import { FoldPoint, TraceRecorder } from "foldpoint";
import { appendFileSync } from "node:fs";

const foldPoint = new FoldPoint();
const trace = new TraceRecorder({ producer: "my-agent@1.2.3" });
const write = (event: unknown) => appendFileSync(path, `${JSON.stringify(event)}\n`);

write(trace.header());

// 1. before the request: decide, then record the estimates
const input = { sessionId, profile, timestamp, contextTokens, cachedTokens, idleMs, ... };
const decision = foldPoint.decide(input);
const event = trace.decision(input, decision);   // keep event.callId
write(event);

if (decision.action !== "KEEP") {
  const observation = await runCompactor(...);   // your compactor
  foldPoint.recordCompaction(sessionId, profile, observation);
  write(trace.compaction(sessionId, observation, { action: decision.action, callId: event.callId }));
}

// 2. after the request: record what the provider reported
const usage = await callModel(...);              // { timestamp, promptTokens, cachedInputTokens, ... }
foldPoint.observeRequest(sessionId, profile, usage);
write(trace.request(sessionId, event.callId, usage, { latencyMs }));

// 3. when the session ends
foldPoint.endSession(sessionId, profile, { timestamp });
write(trace.sessionEnd(sessionId, { timestamp }, { reason: "completed" }));
```

`examples/trace-capture.ts` is exactly this, with a stand-in provider so it runs offline.
Replace the stand-in with your client and keep the four `write(...)` calls.

Notes that matter for the data being usable:

- **Report what the provider served, not what you hoped.** When the prefix has lapsed, report
  `cachedTokens: 0` (or omit it) on the decision input, and report the real
  `cachedInputTokens`/`cacheWriteTokens` on the request event. FoldPoint prices the current call
  from the first and the analysis measures it against the second.
- **`expectedFutureCalls` counts the call being decided**, not only the calls after it; the
  break-even compares `C_now + (N - 1) * C_later` against the compaction.
- **Keep `callId` unique per call.** It is the only thing that pairs an estimate with its
  outcome; the recorder generates one from the session id and sequence number if you do not.
- The recorder does no I/O and no network work. Appending a line is the host's job, so a
  failure to write a trace can never change a decision.

## 3. Analysing a trace

```bash
npm run trace:analyze -- traces/session-*.jsonl --out traces/report
```

The command writes `<out>.md` (readable) and `<out>.json` (machine-readable). It pairs each
`decision` with the `request` that shares its `callId` and reports:

| metric | predicted | actual |
| --- | --- | --- |
| call cost | `estimatedCurrentCallReplayCost`, or `estimatedFirstPostCompactReplayCost` when that decision compacted | the prompt side of the reported usage, priced with the trace's own snapshot |
| cache alive (this call) | `estimatedCacheAliveProbability` | whether the provider served anything from cache |
| cache alive (next call) | `estimatedCacheLaterAliveProbability` | whether the *next* request in the session was served from cache |
| retention | `estimatedPostCompactTokens` | `afterTokens` of the compaction |
| horizon | `expectedFutureCalls` | the calls that really remained |

Output tokens are excluded from the cost comparison on both sides, because the model does not
predict them. A positive signed error means the model **under**-predicted.

Four rules keep the numbers honest, and each one is visible in the report:

- **A session without a `session_end` event is right-censored.** Its last recorded call is not
  known to be the last call of the session, so it is excluded from the horizon error and from
  the near-end class — a long session exported halfway through would otherwise make the horizon
  look over-predicted. The other metrics still use the calls that were recorded.
- **An unreported cache usage is unknown, not a miss.** A request without `cachedInputTokens`
  is excluded from the cache calibration and from the cost error (which needs the whole prompt
  breakdown), and it does not count towards the session's cache-hit rate. Unknowns are counted
  so the report says how many samples were dropped.
- **The next-call comparison only runs when the two calls are the same path.** A compaction or
  a model/compactor change in between means the second call is not the continuation of the
  first, so it is skipped and counted (by reason).
- **A trace with unreadable lines is not evidence.** The command exits non-zero and writes no
  report. `--allow-errors` produces a report that says **not usable for calibration** in its
  first lines and in `usableForCalibration`.

Decisions are grouped into scenario classes, because an average over everything hides exactly
the cases worth looking at:

- `cold-cache` — the provider served almost nothing (long-running cold prefix);
- `one-off-expiry` — the cache lapsed at least once after the first call and recovered;
- `near-end` — the last few calls of a session (the horizon estimate is most wrong there);
- `steady` — cache reads throughout.

A decision can be in more than one class. Sessions are also split into a **development set**
and a **holdout set** by a deterministic hash of the session id (`holdoutModulo`, default 5),
so a change that only helps the sessions it was tuned on is visible as a gap between the two.

## 5. The Pi adapter

[`adapters/pi/foldpoint-observe.ts`](../adapters/pi/foldpoint-observe.ts) is an **observe-only**
Pi extension: copy it to `~/.pi/agent/extensions/`, point `FOLDPOINT_TRACE` at a file, and run
Pi. It runs FoldPoint before every model call, records what FoldPoint *would* have decided,
records the usage Pi reports after the call, and records the compactions Pi performs. It never
compacts, never cancels, never modifies context.

It is deliberately not wired into Pi's compaction yet. Acting on the decisions would change the
data being measured, and the first job is to find out whether the predictions match a real Pi
session at all.

What it binds, and what it refuses to bind:

| Pi event | what the adapter does |
| --- | --- |
| `session_start` / `session_shutdown` | opens and closes a trace session |
| `context` (before each LLM call) | decides and writes the `decision` event; also completes a compaction record whose post-compaction size only becomes known here |
| `message_end` (assistant messages) | writes the `request` event from `message.usage` and teaches FoldPoint the real usage |
| `session_before_compact` / `session_compact` / `session_compact_failed` | records the attempt; a failure is recorded with `afterTokens == beforeTokens`, because nothing changed |
| `before_provider_request`, `context_with_system`, tool events | **never subscribed**: the request payload is not read, so it cannot be written |

The session key is a runtime-scoped counter (`pi-<runtime-start>-<n>`), not Pi's session id or
session file path. That keeps the trace usable for calibration and useless for joining back to a
conversation.

Pairing is checked call by call: a model call that finishes without a decision before it, or a
decision that never gets a call, is counted and logged at session end, so a trace that cannot be
paired is visible instead of silently averaged.

Two things the adapter deliberately does **not** do: it does not guess the cache state before a
call (`cachedTokens` is omitted, so the model relies on what it has learned — otherwise the
comparison would be circular), and it does not invent a horizon (`expectedFutureCalls` is
omitted; Pi does not know how many calls remain).

How to run it, and how to produce compaction events without paying for a full 200k context, is
in [pi-runbook.md](pi-runbook.md).

## 6. Privacy

The format has no field for conversation content. The data is still not anonymous:

- **Session identifiers.** Use something irreversible. The Pi adapter uses a runtime counter
  rather than Pi's session id. If you write your own host, do not put a raw UUID that also
  appears in logs or exports next to the trace.
- **Timestamps** show when and for how long someone worked, and how many calls a task took.
- **Free-form labels** (`producer`, `reason`, `errorCode`) are the easiest place for content to
  leak by accident. The recorder therefore validates every one of them at runtime against a
  conservative charset (`A-Za-z0-9._@:/+#-`, at most 64 or 128 characters) and throws instead of
  writing anything else — a label can be an identifier, never a sentence.
- **The trace file itself** is plain text. Store it where you store logs, not where you store
  secrets, and treat it as data about a person's work.

## 7. What a trace cannot prove

- **It does not prove savings.** Replaying a trace with a different compaction time is not a
  counterfactual: once the compaction time changes, the context *and* the cache after that point
  change too. Only a paired experiment on real tasks — same tasks, same model, same compactor,
  FoldPoint against a guarded fixed threshold — can compare total cost.
- **It does not measure task quality.** Check that the task completed, that tool results are
  correct, that nothing overflowed, and how many extra calls the compactions cost. A cheaper
  session that dropped something important is not a win.
- **It is a sample, not a distribution.** The calibration says how the model behaved on the
  sessions you recorded, not how it will behave on someone else's workload.
- **The three stand-in sessions in `examples/trace-capture.ts` prove the pipeline runs.** They
  are not evidence about a real agent, and nothing in them says FoldPoint saves money or keeps
  task quality.

## 8. Where this is going

1. **Format, capture and the Pi observer** (this document): done.
2. **Collect a batch of complete real Pi sessions**, then look at the error tables. Change only
   the general model or its defaults — never a special case for one trace. The dev/holdout split
   exists so that step can be honest.
3. **Paired experiments on real tasks**: about ten tasks first to check that the recording is
   complete, then a spread that covers short tasks, long tool-calling sessions, frequently
   expiring caches and a poor compactor — comparing total cost *and* task completion, tool
   correctness, overflows, compaction count and extra latency.

An acting adapter for Pi (one that compacts when FoldPoint says so) comes after those three
steps, not before: it should be built because the data says FoldPoint helps, and it reuses the
same recorder interface. dsh and the other plugins can follow the same shape.
