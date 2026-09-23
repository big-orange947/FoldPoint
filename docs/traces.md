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
token counts, prices, cache usage, the decision and the model's estimates. There is no field
for prompt text, tool output, chat content or credentials, and none may be added — the decision
input FoldPoint already receives is metadata by construction, so recording it cannot leak a
conversation.

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

Decisions are grouped into scenario classes, because an average over everything hides exactly
the cases worth looking at:

- `cold-cache` — the provider served almost nothing (long-running cold prefix);
- `one-off-expiry` — the cache lapsed at least once after the first call and recovered;
- `near-end` — the last few calls of a session (the horizon estimate is most wrong there);
- `steady` — cache reads throughout.

A decision can be in more than one class. Sessions are also split into a **development set**
and a **holdout set** by a deterministic hash of the session id (`holdoutModulo`, default 5),
so a change that only helps the sessions it was tuned on is visible as a gap between the two.

## 4. What a trace cannot prove

- **It does not prove savings.** Replaying a trace with a different compaction time is not a
  counterfactual: once the compaction time changes, the context *and* the cache after that point
  change too. Only a paired experiment on real tasks — same tasks, same model, same compactor,
  FoldPoint against a guarded fixed threshold — can compare total cost.
- **It does not measure task quality.** Check that the task completed, that tool results are
  correct, that nothing overflowed, and how many extra calls the compactions cost. A cheaper
  session that dropped something important is not a win.
- **It is a sample, not a distribution.** The calibration says how the model behaved on the
  sessions you recorded, not how it will behave on someone else's workload.

## 5. Where this is going

1. **Format and capture** (this document): done.
2. **Calibrate against the traces**: look at the error tables, and change only the general model
   or its defaults — never a special case for one trace. The dev/holdout split exists so that
   step can be honest.
3. **Paired experiments on real tasks**: about ten tasks first to check that the recording is
   complete, then a spread that covers short tasks, long tool-calling sessions, frequently
   expiring caches and a poor compactor.

An adapter for a specific agent (Pi, dsh, ...) comes after those three steps, not before: the
first one should be chosen because the data says FoldPoint helps there.
