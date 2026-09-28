/** Persistent, staged Pi RPC runner for the three-arm 1M trial. No prompt text in reports. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceJsonl, type TraceEvent } from "../src/index";
import {
  MILLION_MODEL_WINDOW_TOKENS,
  MILLION_RUN_WINDOW_TOKENS,
  type MillionArmId,
  prepareMillionAgentDir,
} from "./pi-million-config";
import { gradeStageResponse, type StageExpectation } from "./pi-million-oracle";
import { analyzeTraceEvents } from "./trace-analyze";

interface Stage extends StageExpectation {
  file: string;
}

interface TrialManifest {
  id: string;
  stages: Stage[];
}

interface StageResult {
  stage: number;
  passed: boolean;
  promptTokensSoFar: number;
  compactionsSoFar: number;
  /** Estimated cost incurred so far, on the same basis as the arm's `totalCost`. */
  costUsdSoFar: number | null;
}

/**
 * Why an arm stopped early on one of its two stop lines, and what the line saw. Both lines are
 * checked *after* a stage completes, so a single stage can overshoot them: neither is a
 * pre-request hard lock (`budgetStopBasis` in the report says the same thing).
 */
interface BudgetStop {
  kind: "prompt-tokens" | "cost-usd";
  limit: number;
  observed: number;
  /** The trace's cost currency. Pi's price snapshots are USD; a cost line assumes as much. */
  currency: string | null;
}

/**
 * Which class of model call failed. A `material` call carries the staged material the trial
 * measures; a `summary` call is the host's own compaction request. Separating the two is most of
 * the diagnosis: the paid pilot's last failure was a *summary* call, and neither the report nor
 * the trace said so.
 */
type FailedCallKind = "material" | "summary";

/**
 * Why the runner stopped waiting on its Pi RPC session. The paid pilot's report could not say:
 * its one transport failure read `Pi RPC event timeout or exit (exit=running)`, which named two
 * opposite states - the runner gave up while Pi was still working, or Pi really died - in a single
 * string, so a 30-second deadline expiring on a live summarization was indistinguishable from a
 * crashed host. Every kind below is one of those states, and each one is read from the runner's own
 * evidence: the child's `exitCode`, the spawn error, and which deadline expired.
 *
 * - `event-timeout`: the child was alive and the runner's own deadline expired waiting for an RPC
 *   event. The prompt response qualifies because Pi emits it only after prompt preflight, and
 *   preflight can run a threshold compaction (`agent-session.ts:1697` before `:1759`).
 * - `settle-timeout`: the child was alive and had not stopped compacting/streaming at the settle
 *   deadline (`settleTurn`). The summary is still running; nothing is broken except our patience.
 * - `process-exit`: the child ended. Its exit code is in the message; the session is over.
 * - `spawn-error`: the child never started (`error` before any event).
 * - `runner-error`: the runner threw something else while a stage was in flight (a rejected
 *   command, a malformed event); neither a wait nor an exit, and it keeps that name.
 *
 * A `timeout` in any of the first two forms means the *runner* stopped waiting; `process-exit` and
 * `spawn-error` mean the *host* stopped existing. Those are the two things a paid report has to be
 * able to tell apart before anyone spends money on a longer wait.
 */
export type RpcLossKind =
  | "event-timeout"
  | "settle-timeout"
  | "process-exit"
  | "spawn-error"
  | "runner-error";

/** Thrown by every wait the runner gives up on, carrying which state it gave up in. */
export class PiRpcLossError extends Error {
  readonly kind: RpcLossKind;

  constructor(kind: RpcLossKind, message: string) {
    super(message);
    this.name = "PiRpcLossError";
    this.kind = kind;
  }
}

/**
 * Fixed categories, and the only thing a failed call keeps about its error. Each name states a
 * *cause* so two runs can be compared, and none of them carries provider text.
 * `unknown-no-status` is a statement about the evidence, not a cause: nothing structured was
 * exposed and no fixed phrase matched. It replaces the old `error-without-status`, which was the
 * category both paid pilots reported - the state this enum exists to get out of.
 */
export type CallFailureCategory =
  | "rate-limit"
  | "insufficient-balance"
  | "summary-output-cap"
  | "context-length"
  | "invalid-request"
  | "server-error"
  | "http-other"
  | "rpc-lost"
  | "unknown-no-status";

/**
 * Machine-readable diagnosis of one failed model call. Holds a fixed category, the HTTP status
 * when one could be read, and the host's own labels - never a prompt, a response or an error
 * message body.
 */
interface CallFailure {
  /** 1-based staged task the failure fell in; null before the first prompt was sent. */
  stage: number | null;
  call: FailedCallKind;
  /** HTTP status code, digits only, or null when nothing exposed one. */
  status: number | null;
  category: CallFailureCategory;
  /** For a summary call, the host's stated trigger: `threshold` / `manual` / `overflow`. */
  compactionReason: string | null;
  /**
   * Set exactly on an `rpc-lost` failure, and null on every other one: which state the lost RPC
   * session was in. This is the field that tells "we stopped waiting" (`event-timeout` /
   * `settle-timeout`) from "Pi is gone" (`process-exit` / `spawn-error`).
   */
  rpcLoss: RpcLossKind | null;
}

interface FailureScan {
  failures: CallFailure[];
  failuresTruncated: boolean;
  failuresByCall: Record<FailedCallKind, number>;
  /** Assistant stop reasons seen on staged material calls (`stop`, `length`, `error`, ...). */
  assistantStopReasons: Record<string, number>;
  /** Pi's own retry attempts: `auto_retry_start` plus `summarization_retry_scheduled`. */
  hostRetryAttempts: number;
}

/** Most failures a report keeps. Counts in `failuresByCall` stay complete past the cap. */
const MAX_RECORDED_FAILURES = 32;
/** Error text is only ever read for a structured field or a fixed phrase; nothing is stored. */
const MAX_SCANNED_ERROR_CHARS = 2_000;

/**
 * Read an HTTP status out of the display text Pi composed, and keep nothing else.
 *
 * This is the *last* place a status is looked for, not the first. `openai-completions` sets
 * `errorMessage` from the SDK error (`pi-ai/dist/api/openai-completions.js:502`) via
 * `formatProviderError`, which yields `"<status>: <json body>"` when the SDK exposed the body and
 * the bare message otherwise (`pi-ai/dist/utils/error-body.js`); the host then wraps its own label
 * around that (`"Context overflow recovery failed: Summarization failed: <that>"`,
 * `coding-agent/src/core/agent-session.ts:2880`). So the status is read from the start of the text
 * and from the start of every slice after a `failed:` label, innermost label first. Anywhere else a
 * bare number is a token count, not a status. Both paid pilots came out of this function as "no
 * status", which is why `classifyFailure` consults the structured sources first.
 */
function statusFromErrorText(text: string): number | null {
  if (text.length === 0 || text.length > MAX_SCANNED_ERROR_CHARS) return null;
  const starts = [0];
  for (const label of text.matchAll(/failed:\s*/gi)) starts.push(label.index + label[0].length);
  const patterns = [
    /^(\d{3})(?!\d)/, // "429: body", "500 Rate limit exceeded", "400 status code (no body)"
    /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(\d{3})(?!\d)/i,
    /\((\d{3})\)/, // "<provider> (429): body"
  ];
  for (const start of starts.reverse()) {
    const head = text.slice(start).trim();
    for (const pattern of patterns) {
      const match = pattern.exec(head);
      const status = match?.[1] === undefined ? Number.NaN : Number(match[1]);
      if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    }
  }
  return null;
}

/**
 * A numeric diagnostic code is a status only when it is one; `"invalid_request_error"` is not.
 * This is the one genuinely structured place a status can appear: `message_end` carries the
 * assistant message's `diagnostics`, typed `AssistantMessageDiagnostic[]` with
 * `error.code?: string | number` (`pi-ai/dist/utils/diagnostics.d.ts`). Pi's RPC protocol never
 * forwards an HTTP response header or a numeric `error.status` field, so this is as structured as
 * the wire gets - which is why the body below has to be parsed back out of the display text.
 */
function statusFromDiagnostics(event: RpcEvent): number | null {
  for (const diagnostic of event.message?.diagnostics ?? []) {
    const code = diagnostic?.error?.code;
    const status =
      typeof code === "number" ? code : typeof code === "string" ? Number(code) : Number.NaN;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the provider's JSON error body out of the display text.
 *
 * Pi never hands the body over as a field: `normalizeProviderError` stringifies the SDK's parsed
 * body (`error.error` for the `openai` SDK) into `errorMessage`, so what actually arrives looks
 * like `400: {"error":{"type":"invalid_request_error","code":"context_length_exceeded"}}`. Parsing
 * it back out is the only way to reach `error.type` / `error.code` without scraping words.
 * OpenRouter-shaped responses append a raw metadata line after the body, so a failed parse steps
 * back one closing brace at a time instead of giving up.
 */
function parseProviderBody(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const body = text.slice(start, start + MAX_SCANNED_ERROR_CHARS);
  let end = body.length;
  for (let attempt = 0; attempt < 4 && end > 0; attempt += 1) {
    end = body.lastIndexOf("}", end - 1);
    if (end < 0) return null;
    try {
      const parsed: unknown = JSON.parse(body.slice(0, end + 1));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Trailing text after the body is normal; step back to the previous `}` and retry.
    }
  }
  return null;
}

/** The provider's own `error.type` / `error.code`, unwrapped from the body's `error` envelope. */
function bodyErrorSignals(body: Record<string, unknown> | null): string[] {
  if (body === null) return [];
  const error = isRecord(body.error) ? body.error : body;
  const signals: string[] = [];
  for (const key of ["type", "code"]) {
    const value = error[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 64) signals.push(value);
    else if (typeof value === "number" && Number.isFinite(value)) signals.push(String(value));
  }
  return signals;
}

/**
 * Fixed vocabulary, most specific first. The order is the point, not a detail: OpenAI-shaped APIs
 * cap many 4xx with the generic `invalid_request_error` code, and DeepSeek's own 402 body carries
 * it (`"Insufficient Balance"` with `code: "invalid_request_error"`), so a cause that names itself
 * is tested before the generic token - otherwise a drained balance would be filed as a malformed
 * request. These phrases are matched against the provider body's fields and the display text only,
 * and are never stored.
 */
const FAILURE_VOCABULARY: ReadonlyArray<readonly [CallFailureCategory, RegExp]> = [
  [
    "insufficient-balance",
    /insufficient[\s_-]?(?:balance|quota|funds)|out of budget|quota exceeded|exceeded your current quota|billing/i,
  ],
  ["summary-output-cap", /generation hit the token cap and the summary is incomplete/i],
  [
    "context-length",
    /context[\s_-]?length|maximum context|too many tokens|exceeds? the (?:maximum )?(?:context|length)|(?:prompt|request)[\s_-]?(?:is[\s_-]?)?too[\s_-]?long/i,
  ],
  ["rate-limit", /rate[\s_-]?limit|too many requests|resource[\s_-]?exhausted|throttl/i],
  [
    "server-error",
    /server[\s_-]?error|internal[\s_-]?error|overloaded|high demand|service[\s_-]?unavailable|bad gateway|gateway[\s_-]?time-?out/i,
  ],
  ["invalid-request", /invalid[\s_-]?request|invalid[\s_-]?parameter|bad request|malformed/i],
];

/** The first fixed phrase that matches any haystack, or null when none does. */
function classifyByVocabulary(haystacks: readonly string[]): CallFailureCategory | null {
  for (const [category, pattern] of FAILURE_VOCABULARY) {
    if (haystacks.some((text) => pattern.test(text))) return category;
  }
  return null;
}

/**
 * Turn one failed call into a status and a fixed category. Sources, in order of authority:
 *
 * 1. a numeric HTTP status - a structured `diagnostics[].error.code` first, the leading digits of
 *    the display text only when that is empty;
 * 2. the provider body's own `error.type` / `error.code`, parsed out of that same text as JSON;
 * 3. the fixed vocabulary above, over the body's fields and then over the whole text.
 *
 * A name beats a class when both are present: `error.code: "context_length_exceeded"` on an HTTP
 * 400 says more than the 400 does. Neither the text nor the body leaves this function - only the
 * status and the category are returned. Exported, and the only place a failure is classified, so
 * the vocabulary and its ordering can be pinned by unit tests without a provider in the loop.
 */
export function classifyFailure(
  structuredStatus: number | null,
  text: string,
): { status: number | null; category: CallFailureCategory } {
  // Bound the work: an OpenRouter-style body can be a few thousand characters, and everything
  // that matters (`status`, `type`, `code`, `message`) sits at its front.
  const scanned = text.slice(0, MAX_SCANNED_ERROR_CHARS);
  const body = parseProviderBody(scanned);
  const status = structuredStatus ?? statusFromErrorText(scanned);
  const named = classifyByVocabulary([...bodyErrorSignals(body), scanned]);
  if (named !== null) return { status, category: named };
  if (status === null) return { status, category: "unknown-no-status" };
  if (status === 402) return { status, category: "insufficient-balance" };
  if (status === 408 || status === 409 || status === 429) return { status, category: "rate-limit" };
  if (status >= 500) return { status, category: "server-error" };
  if (status >= 400) return { status, category: "invalid-request" };
  return { status, category: "http-other" };
}

/** Keep the host's own enum and nothing else; an unknown trigger is reported as unknown. */
function normalizeCompactionReason(reason: string | undefined): string | null {
  return reason === "manual" || reason === "threshold" || reason === "overflow" ? reason : null;
}

interface ArmResult {
  arm: MillionArmId;
  completed: boolean;
  stages: StageResult[];
  qualityPassed: number;
  qualityFailed: number;
  reason: string | null;
  /** Non-null exactly when `reason` is `budget-truncated`; a truncated arm is never a win. */
  budgetStop: BudgetStop | null;
  /** Completed stage count, stated separately so a truncated arm cannot look like a full one. */
  stagesCompleted: number;
  /** Cumulative prompt tokens the arm actually sent, as of its last completed stage. */
  promptTokensTotal: number;
  /** SHA-256 prefix of the arm's own system-prompt preamble: the second cache defence line. */
  systemPromptPrefixHash: string;
  /** Fixed tokens the injected preamble costs, on the loopback's chars/4 basis. */
  systemPromptPrefixTokens: number;
  trace: string;
  calls: number;
  compactions: number;
  unpricedCompactions: number;
  callCost: number | null;
  compactionCost: number | null;
  cacheWarmCost: number | null;
  totalCost: number | null;
  currency: string | null;
  pricingFingerprint: string | null;
  pricingConsistent: boolean;
  maxObservedContextTokens: number;
  compactionSizes: Array<{ before: number; after: number | null }>;
  /** Successful compactions by who started them, so a policy-driven arm cannot look native. */
  compactionsByInitiator: Record<string, number>;
  /** Successful compactions by the host's stated reason (`threshold` / `manual` / `overflow`). */
  compactionsByReason: Record<string, number>;
  /**
   * Diagnosed failed model calls, from Pi's RPC events only. This is what the paid pilot's report
   * lacked: an arm could stop with `stage-68-no-successful-response` and say nothing about why.
   */
  failures: CallFailure[];
  /** True when more failures happened than `failures` keeps; `failuresByCall` stays complete. */
  failuresTruncated: boolean;
  lastFailure: CallFailure | null;
  failuresByCall: Record<FailedCallKind, number>;
  /** Stop reasons of staged material responses, so a `length` stop is not an invisible failure. */
  assistantStopReasons: Record<string, number>;
  /** Pi's own retry attempts (`auto_retry_start` / `summarization_retry_scheduled`). */
  hostRetryAttempts: number;
}

interface RpcEvent {
  type?: string;
  id?: string;
  success?: boolean;
  error?: string;
  /** `compaction_start` / `compaction_end`: the host's stated trigger. */
  reason?: string;
  aborted?: boolean;
  willRetry?: boolean;
  /** `compaction_end`: the summary, or absent when the compaction produced none. */
  result?: unknown;
  /** Read for a status code, then discarded: never written to a report. */
  errorMessage?: string;
  data?: { isCompacting?: boolean; isStreaming?: boolean };
  message?: {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    content?: Array<{ type?: string; text?: string }>;
    diagnostics?: Array<{ type?: string; error?: { code?: string | number } }>;
  };
}

const ARM_IDS: readonly MillionArmId[] = ["default", "fixed60", "dynamic"];
const EXTENSION = fileURLToPath(new URL("../adapters/pi/foldpoint-observe.ts", import.meta.url));

/**
 * How long the runner waits on anything that a *summarization* call can sit inside: the prompt
 * response, `agent_settled`, and the settle loop. The earlier 30-second command wait interrupted
 * a real compaction in `pi-million-paid-pilot-03`. An exact replay of that session's summary input
 * took 45 seconds to hit the 13,107-token output cap; with 32,768 it took 94 seconds and still
 * hit the cap. A longer wait prevents a false runner timeout but does not make this corpus
 * compressible.
 *
 * Waiting costs nothing when the event arrives early - every loop here returns on the event, not on
 * the deadline - so the only price of this number is how long a genuinely hung child is tolerated.
 * Deadlines that are *not* about summarization stay short: `get_state` is answered by Pi's command
 * loop immediately and even during a compaction, the settle poll interval stays 250 ms, the
 * pre-settle grace stays 600 ms, and the close grace stays 10 s.
 */
const COMPACTION_WAIT_TIMEOUT_MS = 900_000;

function readManifest(path: string): { manifest: TrialManifest; prompts: string[]; hash: string } {
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as TrialManifest;
  if (
    typeof manifest.id !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(manifest.id) ||
    !Array.isArray(manifest.stages) ||
    manifest.stages.length < 2
  ) {
    throw new Error("Manifest needs a short id and at least two stages");
  }
  const root = dirname(path);
  const hash = createHash("sha256").update(raw);
  const prompts = manifest.stages.map((stage, index) => {
    if (
      typeof stage.file !== "string" ||
      stage.file.length === 0 ||
      isAbsolute(stage.file) ||
      stage.file.split(/[\\/]/).includes("..") ||
      (stage.expectedContains !== undefined &&
        (typeof stage.expectedContains !== "string" || stage.expectedContains.length > 128)) ||
      (stage.expectedAnswers !== undefined &&
        (stage.expectedAnswers === null ||
          typeof stage.expectedAnswers !== "object" ||
          Array.isArray(stage.expectedAnswers) ||
          Object.keys(stage.expectedAnswers).length === 0 ||
          Object.entries(stage.expectedAnswers).some(
            ([key, answer]) =>
              !/^[A-Za-z0-9_-]{1,32}$/.test(key) ||
              typeof answer !== "string" ||
              answer.length === 0 ||
              answer.length > 256,
          ))) ||
      (stage.expectedContains !== undefined && stage.expectedAnswers !== undefined)
    ) {
      throw new Error(`Invalid manifest stage ${index + 1}`);
    }
    const prompt = readFileSync(join(root, stage.file), "utf8");
    if (prompt.length === 0) throw new Error(`Empty manifest stage ${index + 1}`);
    hash.update(stage.file).update("\0").update(prompt);
    return prompt;
  });
  return { manifest, prompts, hash: hash.digest("hex") };
}

/**
 * One long-lived Pi RPC child process. Exported so the two states the paid pilots could not tell
 * apart - a deadline expiring on a live child and a child that really ended - can be pinned by
 * tests with a local stub process, without a provider and without any prompt.
 */
export class RpcSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: RpcEvent[] = [];
  #waiters = new Set<() => void>();
  #nextId = 0;
  #stdoutBuffer = "";
  #stderrBytes = 0;
  #badLines = 0;
  #spawnError = false;

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.#stdoutBuffer += chunk.toString("utf8");
      for (;;) {
        const newline = this.#stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#stdoutBuffer.slice(0, newline).trim();
        this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          this.events.push(JSON.parse(line) as RpcEvent);
          for (const waiter of this.#waiters) waiter();
        } catch {
          // RPC stdout may contain content; do not echo an unreadable line into a report.
          this.#badLines += 1;
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Provider or extension diagnostics can contain sensitive content. Count, never store.
      this.#stderrBytes += chunk.length;
    });
    this.child.on("error", () => {
      this.#spawnError = true;
      for (const waiter of this.#waiters) waiter();
    });
    // A real exit ends the conversation; wake the waiters so the reason is read at once instead of
    // after the deadline, which keeps "the child died" out of the timeout path entirely.
    this.child.on("exit", () => {
      for (const waiter of this.#waiters) waiter();
    });
  }

  get diagnostics(): { badLines: number; stderrBytes: number } {
    return { badLines: this.#badLines, stderrBytes: this.#stderrBytes };
  }

  async waitFor(
    predicate: (event: RpcEvent) => boolean,
    from: number,
    timeoutMs: number,
  ): Promise<{ event: RpcEvent; index: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let index = from; index < this.events.length; index += 1) {
        const event = this.events[index];
        if (event !== undefined && predicate(event)) return { event, index };
      }
      const remaining = deadline - Date.now();
      // Three distinct states, checked in this order so none can hide behind another. A live child
      // whose deadline expired is a *timeout*; a child that ended is an *exit*, whatever the clock
      // says; a child that never started is neither.
      if (this.#spawnError)
        throw new PiRpcLossError("spawn-error", "Pi RPC session failed to start");
      if (this.child.exitCode !== null)
        throw new PiRpcLossError(
          "process-exit",
          `Pi RPC session exited (exit=${this.child.exitCode}) while the runner was waiting`,
        );
      if (remaining <= 0)
        throw new PiRpcLossError(
          "event-timeout",
          `Pi RPC event timeout after ${timeoutMs}ms; the child is still running (exit=running)`,
        );
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          this.#waiters.delete(wake);
          done();
        }, remaining);
        const wake = (): void => {
          clearTimeout(timer);
          this.#waiters.delete(wake);
          done();
        };
        this.#waiters.add(wake);
      });
    }
  }

  /**
   * Send one command and wait for its own `response` event. The default deadline is for control
   * commands Pi answers on its loop immediately - `get_state` is built from session fields and is
   * answered even while a compaction is running - and is deliberately *not* the deadline for
   * anything that can enclose a summarization call: a caller that can sit inside a summary must
   * pass `COMPACTION_WAIT_TIMEOUT_MS` itself (`prompt` does).
   */
  async command(
    type: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<RpcEvent> {
    const id = `fp-${++this.#nextId}`;
    const from = this.events.length;
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const { event } = await this.waitFor(
      (candidate) => candidate.type === "response" && candidate.id === id,
      from,
      timeoutMs,
    );
    if (event.success !== true) throw new Error(`Pi rejected ${type}`);
    return event;
  }

  async settleTurn(from: number, timeoutMs: number): Promise<void> {
    // Pi can emit agent_settled before an overflow compaction resumes the interrupted turn.
    // Wait for both compaction and the resumed agent run, not just compaction alone.
    await new Promise<void>((done) => setTimeout(done, 600));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const starts = this.events
        .slice(from)
        .filter((event) => event.type === "compaction_start").length;
      const ends = this.events
        .slice(from)
        .filter((event) => event.type === "compaction_end").length;
      const state = await this.command("get_state");
      // `ends >= starts`, not equality: after a failed overflow attempt the host reports a
      // compaction_end for an attempt it declined to start. Equality would wait out the whole
      // timeout on a session that is already idle - a quarter of an hour of a paid run on nothing.
      if (state.data?.isCompacting !== true && state.data?.isStreaming !== true && ends >= starts)
        return;
      // Still compacting or streaming when the deadline hits is *our* wait expiring, not a lost
      // host: the summary is still being written and the child is visibly alive.
      if (Date.now() >= deadline)
        throw new PiRpcLossError(
          "settle-timeout",
          `Pi compaction did not settle before the next turn within ${timeoutMs}ms; the child is still running (exit=running)`,
        );
      await new Promise<void>((done) => setTimeout(done, 250));
    }
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.#spawnError) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise<void>((done) => this.child.once("exit", () => done())),
      new Promise<void>((done) => setTimeout(done, 10_000)),
    ]);
    if (this.child.exitCode === null) this.child.kill();
  }
}

/**
 * Diagnose failed calls from Pi's RPC session events. Two structured signals are read - a
 * `message_end` for an assistant message that stopped with an error, and a `compaction_end` for an
 * attempt the host actually started that produced no summary - and nothing else: no prompts, no
 * responses, and no error text is kept.
 *
 * An aborted call is the host standing down (a policy veto, a shutdown), not a provider failure, so
 * it is not counted; neither is a `compaction_end` with no matching `compaction_start`, which is
 * the host declining to retry an attempt it already failed. `lostStage` is the stage the runner was
 * in when its RPC session was lost; that failure has no status code, which the category says out
 * loud, and `lostKind` says *how* it was lost - the runner's deadline on a live child or the child's
 * own exit - because those two need opposite responses.
 *
 * Where the category comes from, since this is the field the paid pilots lacked: the status from a
 * structured diagnostic code, then the provider's own `error.type` / `error.code` parsed out of the
 * display text, then a fixed vocabulary. A summary call is the hard case - the summarization
 * request never reaches `message_end`, so its only trace is the label the host composed around it,
 * and that label has no HTTP status when the summary stopped on its own output cap. That is now
 * `summary-output-cap` instead of an unclassifiable "no status" or an input-context overflow.
 *
 * Exported alongside `classifyFailure` for the same reason: it is pure, it is where a lost session
 * gets its kind, and a test can pin the two states apart with a handful of literal events.
 */
export function scanFailures(
  events: readonly RpcEvent[],
  stageStarts: readonly number[],
  lostStage: number | null,
  lostKind: RpcLossKind | null,
): FailureScan {
  const failures: CallFailure[] = [];
  const failuresByCall: Record<FailedCallKind, number> = { material: 0, summary: 0 };
  const assistantStopReasons: Record<string, number> = {};
  /** Open compactions, innermost last: a stack because a summary can trigger another compaction. */
  const openCompactions: Array<string | null> = [];
  let failuresTruncated = false;
  let hostRetryAttempts = 0;
  const record = (failure: CallFailure): void => {
    failuresByCall[failure.call] += 1;
    if (failures.length >= MAX_RECORDED_FAILURES) {
      failuresTruncated = true;
      return;
    }
    failures.push(failure);
  };
  /** Which staged task an event index belongs to; null until the first prompt was sent. */
  const stageOf = (index: number): number | null => {
    let stage: number | null = null;
    for (let i = 0; i < stageStarts.length; i += 1)
      if ((stageStarts[i] ?? 0) <= index) stage = i + 1;
    return stage;
  };
  events.forEach((event, index) => {
    if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
      hostRetryAttempts += 1;
      return;
    }
    if (event.type === "compaction_start") {
      openCompactions.push(normalizeCompactionReason(event.reason));
      return;
    }
    if (event.type === "compaction_end") {
      const open = openCompactions.pop();
      // A compaction that produced no summary and was not aborted is a failed summary call: this
      // is the record whose absence made the paid pilot undiagnosable. A `compaction_end` with no
      // matching start is the host declining to try again after an earlier failure - that earlier
      // attempt is already recorded, so this one is not a second failed call.
      if (open !== undefined && event.result === undefined && event.aborted !== true) {
        const signal = classifyFailure(statusFromDiagnostics(event), event.errorMessage ?? "");
        record({
          stage: stageOf(index),
          call: "summary",
          status: signal.status,
          category: signal.category,
          compactionReason: open ?? normalizeCompactionReason(event.reason),
          rpcLoss: null,
        });
      }
      return;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const stopReason = event.message.stopReason ?? "unknown";
    assistantStopReasons[stopReason] = (assistantStopReasons[stopReason] ?? 0) + 1;
    if (stopReason !== "error") return;
    // A summarization request is answered outside the agent loop and never reaches `message_end`,
    // so an assistant error here is a staged material call - unless a compaction is still open.
    const call: FailedCallKind = openCompactions.length > 0 ? "summary" : "material";
    const signal = classifyFailure(statusFromDiagnostics(event), event.message.errorMessage ?? "");
    record({
      stage: stageOf(index),
      call,
      status: signal.status,
      category: signal.category,
      compactionReason: openCompactions.at(-1) ?? null,
      rpcLoss: null,
    });
  });
  if (lostStage !== null) {
    record({
      stage: lostStage,
      call: openCompactions.length > 0 ? "summary" : "material",
      status: null,
      category: "rpc-lost",
      compactionReason: openCompactions.at(-1) ?? null,
      rpcLoss: lostKind ?? "runner-error",
    });
  }
  return {
    failures,
    failuresTruncated,
    failuresByCall,
    assistantStopReasons,
    hostRetryAttempts,
  };
}

/** Tally events by a string label, dropping nothing: every compaction must land in a bucket. */
function countBy<T>(items: readonly T[], label: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = label(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Read the trace mid-run: cumulative prompt tokens, successful compactions, and - when the cost
 * stop line asks for it - the cost incurred so far. The cost figure reuses the shared analysis so
 * the stop line and the arm's final `totalCost` can never disagree about the number.
 */
function traceTotals(
  path: string,
  withCost = false,
): { promptTokens: number; compactions: number; costUsd: number | null; currency: string | null } {
  if (!existsSync(path)) return { promptTokens: 0, compactions: 0, costUsd: null, currency: null };
  const parsed = parseTraceJsonl(readFileSync(path, "utf8"));
  if (parsed.errors.length > 0) throw new Error("Incomplete or invalid FoldPoint trace");
  const cost = withCost
    ? analyzeTraceEvents(parsed.events as TraceEvent[]).sessionCosts[0]
    : undefined;
  return {
    promptTokens: parsed.events
      .filter((event) => event.type === "request")
      .reduce((sum, event) => sum + event.usage.promptTokens, 0),
    compactions: parsed.events.filter((event) => event.type === "compaction" && event.success)
      .length,
    costUsd: cost?.totalCost ?? null,
    currency: cost?.currency ?? null,
  };
}

async function runArm(
  arm: MillionArmId,
  base: string,
  piCli: string,
  piNode: string,
  out: string,
  manifest: TrialManifest,
  prompts: readonly string[],
  maxPromptTokens: number,
  maxCostUsd: number | null,
  runWindowTokens: number,
): Promise<ArmResult> {
  const {
    agentDir,
    systemPrompt,
    env: armEnv,
  } = prepareMillionAgentDir(base, arm, runWindowTokens);
  const tracePath = `${out}-${arm}.jsonl`;
  if (existsSync(tracePath)) throw new Error(`Refusing to overwrite trace: ${tracePath}`);
  const rpc = new RpcSession(
    piNode,
    [
      piCli,
      "--mode",
      "rpc",
      "--model",
      "deepseek-flash",
      "--thinking",
      "off",
      "--no-approve",
      "--extension",
      EXTENSION,
    ],
    agentDir,
    {
      ...process.env,
      ...armEnv,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      FOLDPOINT_TRACE: tracePath,
      PI_SKIP_VERSION_CHECK: "1",
    },
  );
  const stages: StageResult[] = [];
  let reason: string | null = null;
  let budgetStop: BudgetStop | null = null;
  /** Event index where each stage's own traffic starts; maps a failure back to its stage. */
  const stageStarts: number[] = [];
  /**
   * Why the RPC session was lost while this stage was in flight, or null when it was not. Separate
   * from the stop `reason` string: the reason says the run ended, this says whether the runner
   * stopped waiting on a live Pi or Pi actually died.
   */
  let rpcLoss: RpcLossKind | null = null;
  try {
    await rpc.command("get_state");
    for (let index = 0; index < prompts.length; index += 1) {
      const from = rpc.events.length;
      stageStarts.push(from);
      // The prompt response is emitted only *after* preflight, and preflight can run a threshold
      // compaction of its own (`agent-session.ts:1697` before `:1759`), so this wait sits inside a
      // summarization call whenever Pi decides the context needs one before the next prompt.
      await rpc.command("prompt", { message: prompts[index] }, COMPACTION_WAIT_TIMEOUT_MS);
      await rpc.waitFor(
        (event) => event.type === "agent_settled",
        from,
        COMPACTION_WAIT_TIMEOUT_MS,
      );
      await rpc.settleTurn(from, COMPACTION_WAIT_TIMEOUT_MS);
      const replies = rpc.events
        .slice(from)
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant");
      const last = replies.at(-1)?.message;
      const answer = (last?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      const passed = gradeStageResponse(answer, last?.stopReason, manifest.stages[index] ?? {});
      // Both stop lines are evaluated here, after a completed stage, never before a request.
      const totals = traceTotals(tracePath, maxCostUsd !== null);
      stages.push({
        stage: index + 1,
        passed,
        promptTokensSoFar: totals.promptTokens,
        compactionsSoFar: totals.compactions,
        costUsdSoFar: totals.costUsd,
      });
      if (last?.stopReason !== "stop") {
        reason = `stage-${index + 1}-no-successful-response`;
        break;
      }
      // Continue the frozen sequence even when an answer is wrong. Otherwise a weaker arm
      // gets fewer paid calls and appears cheaper only because it failed earlier.
      if (totals.promptTokens > maxPromptTokens) {
        budgetStop = {
          kind: "prompt-tokens",
          limit: maxPromptTokens,
          observed: totals.promptTokens,
          currency: totals.currency,
        };
        reason = "budget-truncated";
        break;
      }
      if (maxCostUsd !== null && totals.costUsd !== null && totals.costUsd >= maxCostUsd) {
        budgetStop = {
          kind: "cost-usd",
          limit: maxCostUsd,
          observed: totals.costUsd,
          currency: totals.currency,
        };
        reason = "budget-truncated";
        break;
      }
    }
  } catch (error) {
    reason = error instanceof Error ? error.message.slice(0, 120) : "unknown Pi RPC failure";
    // A stage that started and produced no result is the lost one. Its kind comes from the error
    // the wait threw: a `PiRpcLossError` names the exact state, anything else is the runner's own
    // failure while the session was in flight.
    if (stageStarts.length > stages.length)
      rpcLoss = error instanceof PiRpcLossError ? error.kind : "runner-error";
  } finally {
    await rpc.close();
  }
  // Read the diagnosis off the session that just ended. The RPC child has exited by now, so the
  // event list is complete: a compaction still open at the end really was cut short.
  const scan = scanFailures(
    rpc.events,
    stageStarts,
    rpcLoss === null ? null : stageStarts.length,
    rpcLoss,
  );
  const parsed = existsSync(tracePath) ? parseTraceJsonl(readFileSync(tracePath, "utf8")) : null;
  const analysis =
    parsed !== null && parsed.errors.length === 0
      ? analyzeTraceEvents(parsed.events as TraceEvent[])
      : null;
  const cost = analysis?.sessionCosts[0];
  const prices = (parsed?.events ?? [])
    .filter(
      (event): event is Extract<TraceEvent, { type: "decision" }> => event.type === "decision",
    )
    .map((event) => JSON.stringify(event.profile.pricing ?? null));
  const pricingConsistent = prices.length > 0 && prices.every((price) => price === prices[0]);
  const successfulCompactions = (parsed?.events ?? []).filter(
    (event): event is Extract<TraceEvent, { type: "compaction" }> =>
      event.type === "compaction" && event.success,
  );
  const successfulRequestsWithUnknownCache = (parsed?.events ?? []).filter(
    (event) =>
      event.type === "request" &&
      (event.outcome !== "error" ||
        event.usage.promptTokens > 0 ||
        (event.usage.outputTokens ?? 0) > 0) &&
      event.usage.cachedInputTokens === undefined,
  ).length;
  if (rpc.diagnostics.badLines > 0) reason ??= "non-JSON Pi RPC output";
  if (
    analysis === null ||
    !analysis.usableForCalibration ||
    analysis.completeSessions !== 1 ||
    analysis.censoredSessions !== 0 ||
    analysis.sessionCosts.length !== 1 ||
    analysis.unpairedDecisions > 0 ||
    analysis.unpriceable > 0 ||
    successfulRequestsWithUnknownCache > 0 ||
    !pricingConsistent ||
    (cost?.unpricedCompactions ?? 0) > 0
  ) {
    reason ??= "incomplete-or-unpriced-trace";
  }
  return {
    arm,
    completed: reason === null && stages.length === prompts.length,
    stages,
    qualityPassed: stages.filter((stage) => stage.passed).length,
    qualityFailed: stages.filter((stage) => !stage.passed).length,
    reason,
    budgetStop,
    stagesCompleted: stages.length,
    promptTokensTotal: stages.at(-1)?.promptTokensSoFar ?? 0,
    systemPromptPrefixHash: createHash("sha256")
      .update(systemPrompt.split("\n")[0] ?? systemPrompt)
      .digest("hex")
      .slice(0, 16),
    systemPromptPrefixTokens: Math.ceil(systemPrompt.length / 4),
    trace: tracePath,
    calls: cost?.calls ?? 0,
    compactions: cost?.compactions ?? 0,
    unpricedCompactions: cost?.unpricedCompactions ?? 0,
    callCost: cost?.callCost ?? null,
    compactionCost: cost?.compactionCost ?? null,
    cacheWarmCost: cost?.cacheWarmCost ?? null,
    totalCost: cost?.totalCost ?? null,
    currency: cost?.currency ?? null,
    pricingFingerprint:
      prices[0] === undefined ? null : createHash("sha256").update(prices[0]).digest("hex"),
    pricingConsistent,
    maxObservedContextTokens: Math.max(
      0,
      ...(parsed?.events ?? [])
        .filter((event) => event.type === "decision")
        .map((event) => event.input.contextTokens),
    ),
    compactionSizes: (parsed?.events ?? [])
      .filter(
        (event): event is Extract<TraceEvent, { type: "compaction" }> =>
          event.type === "compaction" && event.success,
      )
      .map((event) => ({ before: event.beforeTokens, after: event.afterTokens })),
    compactionsByInitiator: countBy(
      successfulCompactions,
      (event) => event.initiatedBy ?? "unknown",
    ),
    compactionsByReason: countBy(successfulCompactions, (event) => event.reason ?? "unstated"),
    failures: scan.failures,
    failuresTruncated: scan.failuresTruncated,
    lastFailure: scan.failures.at(-1) ?? null,
    failuresByCall: scan.failuresByCall,
    assistantStopReasons: scan.assistantStopReasons,
    hostRetryAttempts: scan.hostRetryAttempts,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const manifestPath = value("--manifest");
  const base = value("--agent-base");
  const out = value("--out");
  const piCli = process.env.PI_CLI;
  if (!manifestPath || !base || !out || !piCli) {
    throw new Error(
      "Usage: PI_CLI=... tsx tools/pi-million-rpc.ts --manifest <json> --agent-base <dir> --out <prefix> [--max-prompt-tokens N] [--max-cost-usd N]",
    );
  }
  const maxPromptTokens = Number(value("--max-prompt-tokens") ?? 40_000_000);
  if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens <= 0)
    throw new Error("Invalid prompt-token budget");
  const maxCostUsdRaw = value("--max-cost-usd");
  const maxCostUsd = maxCostUsdRaw === undefined ? null : Number(maxCostUsdRaw);
  if (maxCostUsd !== null && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0))
    throw new Error("Invalid cost budget");
  const runWindowTokens = Number(value("--run-window-tokens") ?? MILLION_RUN_WINDOW_TOKENS);
  if (
    runWindowTokens !== MILLION_RUN_WINDOW_TOKENS &&
    runWindowTokens !== MILLION_MODEL_WINDOW_TOKENS
  )
    throw new Error("Invalid run window: use 800000 or 1000000");
  const selectedArm = value("--arm");
  if (selectedArm !== undefined && !ARM_IDS.includes(selectedArm as MillionArmId))
    throw new Error("Invalid arm: use default, fixed60, or dynamic");
  const selectedArms = selectedArm === undefined ? ARM_IDS : [selectedArm as MillionArmId];
  const minCompactions = Number(value("--min-compactions") ?? 2);
  if (!Number.isSafeInteger(minCompactions) || minCompactions < 0)
    throw new Error("Invalid minimum compaction count");
  const output = resolve(out);
  const manifestData = readManifest(resolve(manifestPath));
  const maxStages = Number(value("--max-stages") ?? manifestData.prompts.length);
  if (!Number.isSafeInteger(maxStages) || maxStages < 1 || maxStages > manifestData.prompts.length)
    throw new Error("Invalid maximum stage count");
  const fullCorpus = maxStages === manifestData.prompts.length;
  const prompts = manifestData.prompts.slice(0, maxStages);
  const reportPath = `${output}-report.json`;
  if (existsSync(reportPath) || selectedArms.some((arm) => existsSync(`${output}-${arm}.jsonl`))) {
    throw new Error("Refusing to overwrite an existing 1M trial result");
  }
  mkdirSync(dirname(output), { recursive: true });
  const results: ArmResult[] = [];
  for (const arm of selectedArms) {
    const result = await runArm(
      arm,
      resolve(base),
      piCli,
      process.env.PI_NODE ?? process.execPath,
      output,
      manifestData.manifest,
      prompts,
      maxPromptTokens,
      maxCostUsd,
      runWindowTokens,
    );
    results.push(result);
    const last = result.lastFailure;
    process.stdout.write(
      `${arm}: ${result.completed ? "complete" : result.reason}, calls=${result.calls}, compactions=${result.compactions}, stages=${result.stagesCompleted}, promptTokens=${result.promptTokensTotal}, cost=${result.totalCost === null ? "n/a" : result.totalCost.toFixed(6)}${result.budgetStop === null ? "" : `, stop=${result.budgetStop.kind}@${result.budgetStop.observed}`}${last === null ? "" : `, lastFailure=${last.call}/${last.category}/${last.status === null ? "no-status" : last.status}${last.compactionReason === null ? "" : `@${last.compactionReason}`}${last.rpcLoss === null ? "" : `/${last.rpcLoss}`}`}\n`,
    );
    if (!result.completed) break;
  }
  const defaultArm = results.find((result) => result.arm === "default");
  const fixedArm = results.find((result) => result.arm === "fixed60");
  const dynamicArm = results.find((result) => result.arm === "dynamic");
  const regressions = (baseline: ArmResult | undefined): number | null =>
    baseline === undefined || dynamicArm === undefined
      ? null
      : baseline.stages.filter(
          (stage, index) => stage.passed && dynamicArm.stages[index]?.passed === false,
        ).length;
  const qualityRegressionsAgainstDefault = regressions(defaultArm);
  const qualityRegressionsAgainstFixed60 = regressions(fixedArm);
  const budgetTruncatedArms = results
    .filter((result) => result.budgetStop !== null)
    .map((result) => result.arm);
  const systemPromptPrefixes = new Set(results.map((result) => result.systemPromptPrefixHash));
  const comparable =
    fullCorpus &&
    selectedArms.length === 3 &&
    results.length === 3 &&
    results.every(
      (result) =>
        result.completed && result.budgetStop === null && result.compactions >= minCompactions,
    ) &&
    results.every((result) => result.pricingFingerprint === results[0]?.pricingFingerprint) &&
    systemPromptPrefixes.size === results.length;
  const report = {
    runner: "foldpoint.pi-million-rpc.v1",
    runMode: fullCorpus ? "full" : "preflight",
    stagesRun: maxStages,
    fullCorpus,
    qualityGate:
      "exact marker or hidden JSON field answers per stage; external task oracle not included",
    manifestId: manifestData.manifest.id,
    manifestHash: manifestData.hash,
    declaredRunWindowTokens: runWindowTokens,
    selectedArms,
    minCompactions,
    maxPromptTokens,
    maxCostUsd,
    /** Arms stopped by a stop line. A truncated arm is never comparable and never a win. */
    budgetTruncatedArms,
    budgetTruncated: budgetTruncatedArms.length > 0,
    budgetStopBasis:
      "both stop lines are checked after each completed stage, not before each request: a stage can overshoot either line before Pi's next check, and the cost figure is an estimate from Pi's price snapshot applied to provider usage, not the provider bill",
    /** Distinct system-prompt preambles: the second, arm-level line against shared KV cache. */
    systemPromptPrefixesDistinct: systemPromptPrefixes.size === results.length,
    cacheIsolationBasis:
      "a per-arm DeepSeek user_id plus an arm-specific leading system-prompt preamble; user_id isolation is documented but its key composition is undefined and cache hits are best-effort",
    /** Failed calls across the arms that ran, already reduced to categories and status codes. */
    failedArms: results.filter((result) => result.failures.length > 0).map((result) => result.arm),
    failureEvidenceBasis:
      "Failure categories come from Pi RPC message_end/compaction_end events: numeric status, provider error code/type, then a bounded fixed vocabulary. A summary-output-cap is distinct from an input context-length rejection. Prompts, answers, keys and raw error text are not persisted; rpcLoss distinguishes a live timeout from process exit.",
    arms: results,
    comparable,
    preflightPassed:
      !fullCorpus &&
      results.length === selectedArms.length &&
      results.every(
        (result) =>
          result.completed && result.qualityFailed === 0 && result.compactions >= minCompactions,
      ),
    qualityRegressionsAgainstDefault,
    qualityRegressionsAgainstFixed60,
    pilotCostAndQualitySignal:
      comparable &&
      qualityRegressionsAgainstDefault === 0 &&
      qualityRegressionsAgainstFixed60 === 0 &&
      dynamicArm !== undefined &&
      defaultArm !== undefined &&
      fixedArm !== undefined &&
      dynamicArm.totalCost !== null &&
      defaultArm.totalCost !== null &&
      fixedArm.totalCost !== null &&
      dynamicArm.totalCost < Math.min(defaultArm.totalCost, fixedArm.totalCost),
    costBasis: "Pi model pricing snapshot applied to provider usage; not the final provider bill",
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`report: ${reportPath}\n`);
  if (!report.comparable && !report.preflightPassed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
