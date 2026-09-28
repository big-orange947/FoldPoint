/**
 * One-off, opt-in probe for the one question the paid pilots left open, and the reason
 * `traces/pi-million-paid-pilot-03-report.json` could not initially be diagnosed further: **given
 * roughly 700k tokens of synthetic, repetitive context, can `deepseek-flash` produce a complete
 * summary inside the trial's 13,107-token summary budget, and how long does it take?**
 *
 * This probe cannot certify the real source-reading corpus. It succeeded at 738,687 and 804,077
 * provider input tokens with only 381 and 334 output tokens, respectively; exact replays of the
 * failed Pi source sessions hit the output cap at 4,096, 13,107 and even 32,768. The difference
 * is content compressibility, not input size alone. The trial's own gate cannot answer it - the
 * fake provider's summary is a fixed short string that
 * never reaches any cap - and a fourth paid pilot cannot answer it either, because a truncation and
 * a timeout look alike in the report. So this asks the provider exactly one summary question, with
 * `max_tokens` set the way Pi sets it, and reports only numbers.
 *
 * What it never does:
 * - it never sends a request unless `--confirm-paid-call` is on the command line;
 * - it never prints the prompt, the summary or any other response text, and it never prints the key;
 * - it never reads a private file, and never writes one: the context is synthesized here, byte for
 *   byte the same on every run;
 * - the key comes from `DEEPSEEK_API_KEY` only, and stays in the request header.
 *
 * The request shape is Pi's, copied from the host rather than guessed:
 * `coding-agent/src/core/compaction/compaction.ts:704-775` (system prompt + `<conversation>`-wrapped
 * user prompt + `maxTokens`), `compaction.ts:734-737` (`min(floor(0.8 * reserveTokens),
 * model.maxTokens)`), `core/compaction/utils.ts:156-158` (the summarization system prompt),
 * `pi-ai/src/api/openai-completions.ts:816-842,921-926,997-999` (body fields, `stream_options`,
 * DeepSeek's `thinking: {type: "disabled"}` with `--thinking off`, and the arm's `user_id`), and
 * `providers/data/deepseek.json` (model id, base URL, prices). Read-only: nothing under `D:\pi` is
 * touched, and nothing here is imported from it - the two prompt strings are copied verbatim so this
 * script keeps working when Pi is not on the machine.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEEPSEEK_REQUEST_CEILING_TOKENS,
  MILLION_ARMS,
  MILLION_SUMMARY_MAX_TOKENS,
} from "./pi-million-config";

/**
 * `core/compaction/utils.ts:156-158`, verbatim.
 */
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/**
 * `core/compaction/compaction.ts:529-560`, verbatim. The `UPDATE_SUMMARIZATION_PROMPT` variant is not
 * used: the pilot's failing calls are compaction summaries of an overflowing context, and the probe
 * measures the first, hardest shape.
 */
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** The loopback gate's own tokens-per-char basis (`ceil(bytes / 4)`), so the estimate is comparable. */
const CHARS_PER_TOKEN = 4;
/**
 * The largest single SSE line kept in memory. A whole line is one chunk object; anything past this
 * cap is not a shape we can read, and keeping it would let a provider make this process hold an
 * unbounded string.
 */
const MAX_LINE_CHARS = 1_000_000;

/** `MILLION_ARMS.default.reserveTokens`: the arm whose reserve the shared cap is derived from. */
export const SUMMARY_RESERVE_TOKENS = MILLION_ARMS.default.reserveTokens;
/**
 * `min(floor(0.8 * reserveTokens), model.maxTokens)`, Pi's own summary budget
 * (`compaction.ts:734-737`). Reproduced rather than guessed, so the probe asks for the same number
 * the trial's summary calls ask for, and the test that pins it can also state why `fixed60` cannot
 * ask for more.
 */
export function summaryOutputBudget(reserveTokens: number, modelMaxTokens: number): number {
  return Math.min(
    Math.floor(0.8 * reserveTokens),
    modelMaxTokens > 0 ? modelMaxTokens : Number.POSITIVE_INFINITY,
  );
}

/** 13,107: what the trial's three arms all ask for (`MILLION_SUMMARY_MAX_TOKENS`). */
export const SUMMARY_PROBE_MAX_TOKENS = summaryOutputBudget(
  SUMMARY_RESERVE_TOKENS,
  MILLION_SUMMARY_MAX_TOKENS,
);

export const DEFAULT_TARGET_INPUT_TOKENS = 700_000;
export const DEFAULT_TIMEOUT_SECONDS = 1_800;
export const DEFAULT_MODEL = "deepseek-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
/**
 * Its own cache namespace: the trial isolates KV cache per arm through `user_id`, and a probe that
 * reused an arm's id would write into that arm's cache. Override with `--user-id` to match an arm
 * exactly instead.
 */
export const DEFAULT_USER_ID = "foldpoint-1m-summary-probe";
/**
 * `deepseek-flash` prices in USD per million tokens, from Pi's own snapshot
 * (`providers/data/deepseek.json`). The estimate below assumes no cache hit, i.e. the worst case;
 * `cacheReadUsd` is printed only to show what a fully cached prompt would cost instead.
 */
export const DEEPSEEK_FLASH_PRICES_PER_MILLION_TOKENS = {
  inputUsd: 0.3,
  outputUsd: 1.2,
  cacheReadUsd: 0.006,
} as const;

/**
 * A deterministic synthetic transcript of roughly `targetTokens` tokens: no private data, no
 * randomness, no clock. Same argument, same bytes, every run - which is what makes two probe runs
 * comparable at all. It is shaped like the serialized conversation Pi summarizes
 * (`core/compaction/utils.ts:109-149`), as `[User]: ...` / `[Assistant]: ...` blocks. Whole turns
 * mean the result lands within ~2% of the target, and `approxInputTokens` reports the request's real
 * size rather than the target.
 */
export function buildProbeConversation(targetTokens: number): string {
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const parts: string[] = [];
  let chars = 0;
  for (let turn = 1; chars < targetChars; turn += 1) {
    const user = `[User]: Stage ${turn} of the frozen synthetic transcript. The delivery checklist, the responsible owner and the review date are recorded in this stage; answer only from this material.`;
    const assistant = `[Assistant]: Stage ${turn} recorded: delivery checklist, responsible owner and review date noted. No tools, no file reads, no commands.`;
    parts.push(user, assistant);
    // Two "\n\n" separators per turn, so the estimate tracks the string that is actually joined.
    chars += user.length + assistant.length + 4;
  }
  return parts.join("\n\n");
}

/** The trial's provider base URL has no `/v1`; the SDK appends this path to it. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** The exact body Pi's summarization call sends, as far as the trial's settings shape it. */
export function buildSummaryRequestBody(input: {
  conversationText: string;
  model: string;
  maxTokens: number;
  userId: string;
}): Record<string, unknown> {
  const promptText = `<conversation>\n${input.conversationText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`;
  return {
    model: input.model,
    messages: [
      { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: "user", content: promptText },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: input.maxTokens,
    temperature: 0,
    // `--thinking off` on a model whose `thinkingFormat` is `deepseek`.
    thinking: { type: "disabled" },
    // The arm's `samplingParams`; `cacheRetention: "none"` is Pi's summary choice, so no
    // `prompt_cache_key` is sent.
    user_id: input.userId,
  };
}

export interface SummaryProbeOptions {
  confirmPaidCall: boolean;
  help: boolean;
  targetInputTokens: number;
  timeoutSeconds: number;
  model: string;
  baseUrl: string;
  userId: string;
}

export interface SummaryProbePayload {
  endpoint: string;
  body: string;
  approxInputTokens: number;
}

/**
 * The request that would be sent, built but not sent. Pure and deterministic, so the no-call path
 * prints the real thing and a test can inspect it without a provider.
 */
export function buildSummaryProbePayload(options: SummaryProbeOptions): SummaryProbePayload {
  const conversationText = buildProbeConversation(options.targetInputTokens);
  const body = JSON.stringify(
    buildSummaryRequestBody({
      conversationText,
      model: options.model,
      maxTokens: SUMMARY_PROBE_MAX_TOKENS,
      userId: options.userId,
    }),
  );
  return {
    endpoint: chatCompletionsUrl(options.baseUrl),
    body,
    approxInputTokens: Math.ceil(body.length / CHARS_PER_TOKEN),
  };
}

export interface SummaryProbePlan {
  probe: string;
  willCall: boolean;
  endpoint: string;
  model: string;
  maxTokens: number;
  targetInputTokens: number;
  approxInputTokens: number;
  requestCeilingTokens: number;
  timeoutSeconds: number;
  userId: string;
  estimatedCostUsd: number;
  pricesPerMillionTokens: typeof DEEPSEEK_FLASH_PRICES_PER_MILLION_TOKENS;
  estimatedCostBasis: string;
  note: string;
}

/**
 * What the run would cost and whether it may be sent at all. The ceiling guard is the one thing that
 * can stop a probe before it wastes money: DeepSeek rejects a request whose prompt plus `max_tokens`
 * is over 1,048,576, and a probe aimed past that would only ever measure a 400.
 */
export function planSummaryProbe(options: SummaryProbeOptions): SummaryProbePlan {
  const payload = buildSummaryProbePayload(options);
  const requested = payload.approxInputTokens + SUMMARY_PROBE_MAX_TOKENS;
  if (requested > DEEPSEEK_REQUEST_CEILING_TOKENS) {
    throw new Error(
      `Refusing to probe: about ${payload.approxInputTokens} prompt tokens plus ${SUMMARY_PROBE_MAX_TOKENS} max_tokens exceeds DeepSeek's ${DEEPSEEK_REQUEST_CEILING_TOKENS}-token request ceiling; lower --target-input-tokens`,
    );
  }
  const prices = DEEPSEEK_FLASH_PRICES_PER_MILLION_TOKENS;
  const estimatedCostUsd =
    (payload.approxInputTokens * prices.inputUsd + SUMMARY_PROBE_MAX_TOKENS * prices.outputUsd) /
    1_000_000;
  return {
    probe: "foldpoint.pi-million-summary-probe.v1",
    willCall: options.confirmPaidCall,
    endpoint: payload.endpoint,
    model: options.model,
    maxTokens: SUMMARY_PROBE_MAX_TOKENS,
    targetInputTokens: options.targetInputTokens,
    approxInputTokens: payload.approxInputTokens,
    requestCeilingTokens: DEEPSEEK_REQUEST_CEILING_TOKENS,
    timeoutSeconds: options.timeoutSeconds,
    userId: options.userId,
    estimatedCostUsd,
    pricesPerMillionTokens: prices,
    estimatedCostBasis:
      "worst case: the whole prompt at the uncached input price plus a full 13,107-token output, from Pi's deepseek-flash price snapshot; not a quote and not the final bill",
    note: options.confirmPaidCall
      ? "paid call confirmed on the command line"
      : "no request was sent: pass --confirm-paid-call to make the paid call",
  };
}

/**
 * Everything one summary stream may be reduced to: numbers and enums. The response text is counted
 * and dropped as it arrives - it is never stored, returned or printed, and neither is the request.
 */
export interface SummaryStreamScan {
  /** `finish_reason` of the last chunk that carried one: `stop`, `length`, ... */
  finishReason: string | null;
  /** The provider's own `usage.completion_tokens`, or null when it sent none. */
  outputTokens: number | null;
  /**
   * The provider's own `usage.prompt_tokens`: what DeepSeek counted for this request, as opposed to
   * the chars/4 estimate `approxInputTokens` prints. The trial's margin against the 1,048,576-token
   * ceiling rests on that gap, so the probe reports both instead of assuming they agree.
   */
  promptTokens: number | null;
  /** Characters of generated text seen, counted and discarded: the estimate when usage is absent. */
  outputChars: number;
  chunks: number;
  unparsableLines: number;
  streamErrors: number;
  oversizedLines: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Incremental `text/event-stream` reader: keeps the fields that decide the verdict, nothing else. */
export class SummaryStreamScanner {
  #carry = "";
  #finishReason: string | null = null;
  #outputTokens: number | null = null;
  #promptTokens: number | null = null;
  #outputChars = 0;
  #chunks = 0;
  #unparsableLines = 0;
  #streamErrors = 0;
  #oversizedLines = 0;

  push(chunk: string): void {
    this.#carry += chunk;
    for (;;) {
      const newline = this.#carry.indexOf("\n");
      if (newline < 0) break;
      const line = this.#carry.slice(0, newline).trim();
      this.#carry = this.#carry.slice(newline + 1);
      this.#readLine(line);
    }
    if (this.#carry.length > MAX_LINE_CHARS) {
      this.#carry = "";
      this.#oversizedLines += 1;
    }
  }

  #readLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.#unparsableLines += 1;
      return;
    }
    if (!isRecord(parsed)) {
      this.#unparsableLines += 1;
      return;
    }
    // A mid-stream provider error. Its message is provider text and is never read.
    if (isRecord(parsed.error)) {
      this.#streamErrors += 1;
      return;
    }
    this.#chunks += 1;
    for (const choice of Array.isArray(parsed.choices) ? parsed.choices : []) {
      if (!isRecord(choice)) continue;
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0)
        this.#finishReason = choice.finish_reason;
      const delta = isRecord(choice.delta) ? choice.delta.content : undefined;
      if (typeof delta === "string") this.#outputChars += delta.length;
    }
    const usage = isRecord(parsed.usage) ? parsed.usage : null;
    const completionTokens = usage?.completion_tokens;
    if (typeof completionTokens === "number" && Number.isFinite(completionTokens))
      this.#outputTokens = completionTokens;
    const promptTokens = usage?.prompt_tokens;
    if (typeof promptTokens === "number" && Number.isFinite(promptTokens))
      this.#promptTokens = promptTokens;
  }

  get scan(): SummaryStreamScan {
    return {
      finishReason: this.#finishReason,
      outputTokens: this.#outputTokens,
      promptTokens: this.#promptTokens,
      outputChars: this.#outputChars,
      chunks: this.#chunks,
      unparsableLines: this.#unparsableLines,
      streamErrors: this.#streamErrors,
      oversizedLines: this.#oversizedLines,
    };
  }
}

export interface SummaryProbeOutcome extends SummaryStreamScan {
  httpStatus: number | null;
  elapsedMs: number;
  /** True when the probe's own deadline fired and aborted the request. */
  timedOut: boolean;
  /** The transport error's *name* only (`TypeError`, ...); never its message. */
  transportError: string | null;
}

export type SummaryProbeVerdict =
  | "budget-sufficient"
  | "budget-too-small"
  | "timed-out"
  | "http-error"
  | "transport-error"
  | "provider-error"
  | "stream-incomplete";

/**
 * The answer, in one word. A structured refusal outranks everything: an HTTP status that is not 2xx
 * is a fact about the request, and reporting it as a timeout would hide the reason. Otherwise the
 * probe's own deadline, then the transport, then what the stream said - `length` means the summary
 * did not fit in the budget, `stop` means it did, and nothing at all means the stream is not an
 * answer this probe can read.
 */
export function judgeSummaryProbe(outcome: SummaryProbeOutcome): {
  verdict: SummaryProbeVerdict;
  hitOutputCap: boolean;
} {
  const hitOutputCap = outcome.finishReason === "length";
  if (outcome.httpStatus !== null && (outcome.httpStatus < 200 || outcome.httpStatus >= 300))
    return { verdict: "http-error", hitOutputCap };
  if (outcome.timedOut) return { verdict: "timed-out", hitOutputCap };
  if (outcome.transportError !== null) return { verdict: "transport-error", hitOutputCap };
  if (outcome.httpStatus === null) return { verdict: "transport-error", hitOutputCap };
  if (outcome.finishReason === "length") return { verdict: "budget-too-small", hitOutputCap: true };
  if (outcome.finishReason === "stop") return { verdict: "budget-sufficient", hitOutputCap: false };
  if (outcome.streamErrors > 0) return { verdict: "provider-error", hitOutputCap };
  return { verdict: "stream-incomplete", hitOutputCap };
}

/**
 * Send the one request and reduce it to numbers. Nothing is written anywhere: the only output of
 * this process is the single JSON line `main` prints.
 */
export async function runSummaryProbe(
  options: SummaryProbeOptions,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SummaryProbeOutcome> {
  const payload = buildSummaryProbePayload(options);
  const scanner = new SummaryStreamScanner();
  const decoder = new TextDecoder();
  const controller = new AbortController();
  let timedOut = false;
  let httpStatus: number | null = null;
  let transportError: string | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutSeconds * 1_000);
  const started = Date.now();
  try {
    const response = await fetchImpl(payload.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body: payload.body,
      signal: controller.signal,
    });
    httpStatus = response.status;
    if (!response.ok) {
      // Read no body at all: a refusal repeats the request's shape, and this printout is a log.
      await response.body?.cancel().catch(() => undefined);
    } else if (response.body === null) {
      transportError = "no-response-body";
    } else {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) scanner.push(decoder.decode(value, { stream: true }));
      }
      scanner.push(decoder.decode());
    }
  } catch (error) {
    // Our own abort is not a transport failure; saying so twice would confuse the verdict.
    if (!timedOut) transportError = error instanceof Error ? error.name : "unknown-error";
  } finally {
    clearTimeout(timer);
  }
  return {
    httpStatus,
    elapsedMs: Date.now() - started,
    timedOut,
    transportError,
    ...scanner.scan,
  };
}

const USAGE = `Usage: npx tsx tools/pi-million-summary-probe.ts [options]

Answers one question: given ~700k tokens of context, can deepseek-flash produce a complete summary
inside the trial's 13,107-token budget, and how long does it take. No request is sent unless
--confirm-paid-call is given; the summary text itself is never printed.

  --confirm-paid-call        actually send the request (otherwise only print the plan and the cost)
  --target-input-tokens N    synthetic context size in tokens (default ${DEFAULT_TARGET_INPUT_TOKENS})
  --timeout-seconds N        the probe's own deadline (default ${DEFAULT_TIMEOUT_SECONDS})
  --model M                  provider model id (default ${DEFAULT_MODEL})
  --base-url U               provider base URL (default ${DEFAULT_BASE_URL})
  --user-id U                KV-cache namespace for the request (default ${DEFAULT_USER_ID})
  --help                     print this

The key is read from DEEPSEEK_API_KEY and is never printed, logged or written to a file.
`;

/** Strict flag parsing: an unknown flag is a typo, and a typo here costs money. */
export function parseProbeArgs(argv: readonly string[]): SummaryProbeOptions {
  const options: SummaryProbeOptions = {
    confirmPaidCall: false,
    help: false,
    targetInputTokens: DEFAULT_TARGET_INPUT_TOKENS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    userId: DEFAULT_USER_ID,
  };
  const number = (flag: string, raw: string | undefined): number => {
    const value = Number(raw);
    if (raw === undefined || !Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${flag} needs a positive whole number, got: ${raw ?? "(nothing)"}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    const take = (): string => {
      if (next === undefined || next.startsWith("--"))
        throw new Error(`${flag} needs a value, got: ${next ?? "(nothing)"}`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--confirm-paid-call":
        options.confirmPaidCall = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--target-input-tokens":
        options.targetInputTokens = number("--target-input-tokens", take());
        break;
      case "--timeout-seconds":
        options.timeoutSeconds = number("--timeout-seconds", take());
        break;
      case "--model":
        options.model = take();
        break;
      case "--base-url":
        options.baseUrl = take();
        break;
      case "--user-id":
        options.userId = take();
        break;
      default:
        throw new Error(`Unknown flag: ${flag ?? "(empty)"}`);
    }
  }
  // The payload-specific request-ceiling check in planSummaryProbe is the actual guard. The
  // synthetic transcript has now been measured at 738,687 provider tokens for a 911,802-token
  // chars/4 estimate; keep a separate size ceiling so a typo cannot allocate an enormous body.
  if (options.targetInputTokens > 1_000_000)
    throw new Error("--target-input-tokens above 1,000,000 is outside this probe's size ceiling");
  return options;
}

async function main(): Promise<void> {
  const options = parseProbeArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const plan = planSummaryProbe(options);
  if (!options.confirmPaidCall) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.length === 0)
    throw new Error(
      "--confirm-paid-call needs DEEPSEEK_API_KEY in the environment; nothing was sent",
    );
  const outcome = await runSummaryProbe(options, apiKey);
  const judged = judgeSummaryProbe(outcome);
  process.stdout.write(
    `${JSON.stringify({
      probe: plan.probe,
      willCall: true,
      endpoint: plan.endpoint,
      model: plan.model,
      maxTokens: plan.maxTokens,
      targetInputTokens: plan.targetInputTokens,
      approxInputTokens: plan.approxInputTokens,
      timeoutSeconds: plan.timeoutSeconds,
      userId: plan.userId,
      httpStatus: outcome.httpStatus,
      finishReason: outcome.finishReason,
      outputTokens: outcome.outputTokens,
      promptTokens: outcome.promptTokens,
      outputChars: outcome.outputChars,
      elapsedSeconds: Number((outcome.elapsedMs / 1_000).toFixed(2)),
      hitOutputCap: judged.hitOutputCap,
      verdict: judged.verdict,
      timedOut: outcome.timedOut,
      transportError: outcome.transportError,
      chunks: outcome.chunks,
      streamErrors: outcome.streamErrors,
      unparsableLines: outcome.unparsableLines,
      oversizedLines: outcome.oversizedLines,
      estimatedCostUsd: plan.estimatedCostUsd,
      estimatedCostBasis: plan.estimatedCostBasis,
    })}\n`,
  );
  // Anything but a complete summary inside the budget is a result the caller has to look at.
  if (judged.verdict !== "budget-sufficient") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
