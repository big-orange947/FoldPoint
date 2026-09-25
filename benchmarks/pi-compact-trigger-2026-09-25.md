# Can an extension trigger a compaction without interrupting the turn?

Date: 2026-09-25 · zero-paid loopback run · Pi built from `D:\pi` (`packages/coding-agent/dist/bundle/cli.js`),
Node v22.17.0, `--mode rpc`, isolated agent directory, fake OpenAI-compatible provider on 127.0.0.1.
No real provider, no API key, no cost (`paidApiCalls: 0`).

Runner: [`tools/pi-compact-trigger-smoke.ts`](../tools/pi-compact-trigger-smoke.ts)

```powershell
$env:PI_CLI = 'D:\pi\packages\coding-agent\dist\bundle\cli.js'
npx tsx tools/pi-compact-trigger-smoke.ts
```

## 1. The question

The known failure mode is calling `ctx.compact()` **synchronously from inside an event handler**: Pi waits
for the handler to return, the manual compaction first runs `await this.abort()` and waits for the agent to
go idle, and the agent is waiting for the handler — deadlock. (Not re-tested here; taken as given.)

The hypothesis tested here: trigger from **outside** the handler — a detached task that polls
`ctx.isIdle()` until it is true and only then calls `ctx.compact({ onComplete, onError })`. Does that
deadlock, interrupt the turn, or get ignored?

## 2. Result

**The hypothesis holds, with one qualifier that matters for the design** (§5).

| arm | trigger | compaction completed | turn aborted | verdict |
| --- | --- | --- | --- | --- |
| `message_end_poll` | detached poller started in `message_end` of the 2nd assistant message | yes (1 521 ms) | no | holds |
| `agent_settled_direct` | `compact()` called directly in the `agent_settled` handler | yes (1 518 ms) | no | holds |
| `message_end_poll_during_compaction` | as arm 1, but the next prompt is sent while the summarization call runs | yes (1 521 ms) | no | compaction survives; **the next prompt is refused** |

All three arms produced the same mechanism evidence:

- `isIdleBeforeCall: true` and `agentRunsInFlight: 0` at the moment `ctx.compact()` was called.
- `ctx.compact()` returned synchronously (`compact_call_returned`, `returnedSynchronously: true`) — the
  caller is not blocked.
- `session_compact` reached the extension with `reason: "manual"`, `fromExtension: false`,
  `tokensBefore: 2100`. Pi generated the summary; the extension only chose the moment.
- `compaction_end` on the session event stream with `reason: "manual"`, `aborted: false`,
  `willRetry: false` and a real result (summary + `firstKeptEntryId` + usage).
- No assistant message ended with `stopReason: "aborted"` — neither in the event stream nor in the
  persisted session file (all `"stop"`), and the fake provider saw **no client-aborted stream**.
- Every prompt that was expected to run did run, settled, and echoed its own marker
  (`echoedOwnId: true`), i.e. the turns after the compaction were served normally.

Auto-compaction was disabled in the experiment settings (`compaction.enabled: false`), so **every
compaction observed here was started by the extension** and nothing else. That setting does not gate the
manual path (`AgentSession.compact()` does not consult `enabled`).

### Failure shapes that did *not* appear

- No deadlock (no timeout in any arm; all waits resolved on the first observed event).
- No interruption: no aborted turn, no aborted provider stream, no `willRetry`.
- Not ignored: `onComplete` fired, `session_compact` fired, and a `compaction` entry was persisted
  (`persistedCompactionEntries: 1`).

## 3. Raw evidence (arm 1, `message_end_poll`)

Extension log (generated test extension, `%TEMP%\foldpoint-pi-compact-message_end_poll-*\trigger.jsonl` — the
runner leaves its temp directories in place so the raw logs stay inspectable), abbreviated to the
interesting window. Offsets are milliseconds from `poller_start`:

```
 -0  {"kind":"poller_start","where":"message_end","isIdleAtStart":false}            <- handler returned here
 +0  {"kind":"turn_end","turnIndex":0,"stopReason":"stop","agentRunsInFlight":1}
 +0  {"kind":"agent_end","agentRunsInFlight":0}
 +1  {"kind":"agent_settled","isIdle":true,"agentRunsInFlight":0,"ready":true}
 +7  {"kind":"idle_observed","where":"message_end","polls":2,"waitedForIdleMs":8,"agentRunsInFlight":0}
 +7  {"kind":"compact_called","where":"message_end","polls":2,"waitedForIdleMs":8,"isIdleBeforeCall":true,"agentRunsInFlight":0,"lastTurnIndex":0}
 +8  {"kind":"compact_call_returned","where":"message_end","returnedSynchronously":true,"isIdleRightAfterCall":true,"agentRunsInFlight":0}
+1528 {"kind":"session_compact","reason":"manual","fromExtension":false,"willRetry":false,"tokensBefore":2100}
+1528 {"kind":"on_complete","where":"message_end","durationMs":1521,"tokensBefore":2100,"estimatedTokensAfter":2794,"summaryChars":367}
+1530 {"kind":"agent_start","agentRunsInFlight":1}                                  <- the next turn, after the compaction
+1538 {"kind":"turn_end","turnIndex":0,"stopReason":"stop","agentRunsInFlight":1}
+1539 {"kind":"agent_settled","isIdle":true,"agentRunsInFlight":0,"ready":true}
```

The poller needed 2 polls (8 ms) to see idle, because it was armed on the assistant `message_end` and Pi
went idle immediately after. The 1 521 ms compaction duration is the fake provider's deliberate 1 500 ms
delay on summarization requests; the real duration is one summarization call.

Pi's own RPC event stream for the same run, in order (types only, plus the two compaction lines):

```
response id=p1 success=true
agent_start, turn_start, message_end(system/user/assistant stop), turn_end, agent_end, agent_settled
response id=p2 success=true
message_end(user), message_end(assistant stop)
compaction_start {"type":"compaction_start","reason":"manual"}
compaction_end   {"type":"compaction_end","reason":"manual","result":{"summary":"## Goal\n- (loopback summary) ...",
                  "firstKeptEntryId":"a87c1038","tokensBefore":2100,"estimatedTokensAfter":2794,
                  "usage":{...}},"aborted":false,"willRetry":false}
response id=p3 success=true
message_end(user), message_end(assistant stop)
```

Note the ordering: `agent_settled` reaches the client **before** `compaction_start`, so at trigger time the
run had already settled from the client's point of view. The session file confirms the outcome: at the
moment of the compaction it held 5 message entries (system, user, assistant, user, assistant) plus the
`{"type":"compaction", ...}` entry, and every persisted assistant message has `"stopReason":"stop"`.

The summary is the ordinary history summary (Pi's `SUMMARIZATION_PROMPT` answer, 367 chars). An earlier
iteration of the fixture with `keepRecentTokens: 1200` instead made Pi take its split-turn path
(`"No prior history." + **Turn Context (split turn):**`); the trigger mechanics were identical, and the
fixture was reshaped (long user prompt, shorter assistant reply, `keepRecentTokens: 500`) so the ordinary
path is the one exercised here.

## 4. Arm 2: a trigger point that is idle by construction

`agent_settled` is documented as firing "after an agent run has fully settled and no automatic retry,
compaction, or queued continuation will run", and `AgentSession._emitAgentSettled()` sets
`_isAgentRunActive = false` **before** it emits the event (`agent-session.ts:872`). So inside an
`agent_settled` handler `ctx.isIdle()` is already `true` and no polling is needed:

```
{"kind":"agent_settled","isIdle":true,"agentRunsInFlight":0,"ready":true}
{"kind":"compact_called","where":"agent_settled","isIdleBeforeCall":true,"agentRunsInFlight":0}
```

This arm completed a compaction with the same evidence and no poller at all. Two caveats, both worth
knowing before adopting it:

- The emit is still awaited by the run's `finally` block, and `_resolveIdleWaitIfIdle()` runs *after* the
  emit, so `waitForIdle()` (command context only) resolves slightly later than `isIdle()` flips. Calling
  `compact()` here is therefore "idle for the purposes of `isIdle()`", which is the same condition the
  poller used — but it is not the same moment as `waitForIdle()` returning.
- It is a single well-defined point per run, so it cannot be used to compact in the middle of a long
  agent run; the poller can.

## 5. The qualifier: no interruption, but the next turn is blocked

Arm 3 sends the next prompt as soon as `compaction_start` appears. Pi refuses it — from
`agent-session.ts:1627` (`prompt()` preflight, *before* the `isStreaming` steer/follow-up queue branch at
:1654, so it is not an RPC-mode artifact and the prompt cannot be queued either):

```
Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.
```

and a prompt sent after the compaction runs normally. So the honest statement is:

> An extension can start a compaction from outside a handler without deadlocking and without interrupting
> the turn in flight — but the compaction is not free: while it runs, `isCompacting` is true and the
> **next** user prompt is rejected (`Cannot submit a prompt while compaction is in progress`) rather than
> queued. The window equals one summarization call.

Consequences for the "compact before the next request" idea in `docs/pi-runbook.md` §5: an extension
*cannot* promise "compacted before the next request" from this trigger, because the next request cannot be
submitted during the compaction. It can promise "compacted while the session was idle", which is what the
idle-window poller delivers. The check precedes the queue branch, so a prompt typed during the compaction
is refused in every mode; what the interactive TUI *shows* for that refusal (an error line, or a restored
editor buffer like `restoreQueuedMessagesToEditor` does for aborts) was **not** verified — see §7.

## 6. What the harness could have lied about

Two harness bugs produced misleading output before the runs above, recorded here so the same shapes are not
mistaken for Pi behaviour:

1. **Waiting for the compaction before the trigger point.** The first version waited for `compaction_start`
   *before* sending the turns that make the extension's trigger arm. The waits timed out (45 s each), the
   turns then ran back to back, and the compaction only started in the final idle window — after which the
   harness shut the session down and aborted the summarization in flight. That produced
   `on_error: "Turn prefix summarization failed: This operation was aborted"` with
   `session_shutdown reason=quit` 4 ms earlier: **the abort was the harness's own teardown, not Pi**.
   Fixed by driving the turns first and only then waiting for the compaction, and by never ending stdin
   while a compaction is in flight.
2. **Correlating turns by request order.** The fake provider used to number its replies, so one
   mis-detected summarization request shifted every later turn. Replies are now keyed on a `[#id]` marker
   in the last user message, and summarization requests are detected by Pi's summarization system prompt.

The remaining measurement caveats are in §7.

## 7. What this does not establish

- **Mode.** Everything was measured in RPC mode. The interactive TUI calls the same `prompt()` (so the
  refusal in §5 applies), but how the TUI presents that refusal, and what it does with text already typed,
  was not observed.
- **Auto-compaction interaction.** Auto-compaction was disabled to isolate the trigger. With it enabled, a
  manual compaction and a threshold/overflow check can interleave; not tested.
- **Long runs.** The idle window here is between two turns of a fast loopback provider, so the poller saw
  idle after 8–19 ms. Whether a poller armed early in a long tool-calling run survives to the idle window
  (the test extension gives up after 20 s) was not tested.
- **Stale contexts.** The trigger used a live `ctx`. Calling `compact()` from a context captured before
  `newSession`/`fork`/`switchSession`/`reload` hits `runner.assertActive()`; not tested.
- **The deadlock case.** Not re-tested (given as established).
- **Token numbers are fixture artifacts.** `tokensBefore: 2100` is the usage the fake provider declares;
  `estimatedTokensAfter: 2794` is Pi's text estimate over the projected messages *including* Pi's system
  prompt. They come from different message sets and must not be read as a shrink ratio. No real model,
  price or cache behaviour is measured here.
- **Not a saving.** This proves the trigger mechanism only. It says nothing about whether compacting at a
  given moment is worth it.
