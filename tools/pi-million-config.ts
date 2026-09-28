/** Isolated Pi settings for the 1M-window, three-arm compaction trial. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The historical source-code trial used a smaller *declared* window. The newer controlled
 * project-ledger trial can explicitly opt into the full 1M declared window; reports must record
 * which setting was used, and a provider over-limit response is a trial failure, not a result
 * to silently discard.
 *
 * DeepSeek's real request ceiling is 1,048,576 tokens, and the first paid attempt died on an
 * HTTP 400 at 1,114,489 - a stage can overshoot between Pi's post-response threshold checks. Pi's
 * own estimate runs ~13% below the provider's count, so the declared window has to carry both that
 * shortfall and one stage: at 900k the worst case lands ~1,028,000, only 1.9% under the ceiling,
 * which is not a margin.
 *
 * The historical 800k declared window is a safety margin against input overflow, not a remedy for summary
 * failure. Exact replays of the failed Pi sessions on 2026-09-28 proved that the 4096-token
 * summary cap failed at ~847k estimated context, while 13107 and even 32768 failed at ~795k.
 * Those replays hit the *output* cap, independently of the input ceiling. The old report stays
 * "1M model, 800k run budget"; only an explicit 1M run may say "1M declared window".
 */
export const MILLION_MODEL_WINDOW_TOKENS = 1_000_000;
export const MILLION_RUN_WINDOW_TOKENS = 800_000;
/** DeepSeek's hard request ceiling, as observed and to be confirmed against the docs. */
export const DEEPSEEK_REQUEST_CEILING_TOKENS = 1_048_576;
/** The fixed arm compacts at 60% of the *run budget*, which is the window Pi can actually use. */
export const MILLION_FIXED_RATIO = 0.6;
/**
 * The one output cap that all three arms share, and the reason it is exactly this number.
 *
 * Pi budgets the compaction/overflow summary as
 * `min(floor(0.8 * reserveTokens), model.maxTokens)` (`D:\pi/packages/coding-agent/src/core/
 * compaction/compaction.ts:734-737`). `reserveTokens` is per arm - 16,384 for `default`/`dynamic`
 * and 320,000 for `fixed60` - so left alone the fixed arm would get `0.8 * 320,000 = 256,000`
 * output tokens for its summary while the other two got `0.8 * 16,384 = 13,107`. The arm with the
 * largest reserve would then be summarized by a structurally more generous model, and the arms
 * would stop being comparable. The shared `model.maxTokens` is the only lever that equalizes them
 * without touching Pi (it is assigned into the arm's `models.json`, see below), and for the
 * equalization to hold the value must be one the default arm reaches *on its own*:
 *
 *   default/dynamic:  min(floor(0.8 * 16,384), 13,107) = 13,107
 *   fixed60:          min(floor(0.8 * 320,000), 13,107) = 13,107
 *
 * 13,107 = floor(0.8 * 16,384) is the *largest* such value. Any cap above it stops being the
 * binding constraint: the default arm's own reserve would bind first and fixed60 would climb back
 * above 13,107, so the three summary budgets would diverge again. Bigger is not an option here.
 *
 * This is only the largest *equal* cap possible with the original 16,384-token default reserve;
 * it is NOT known to be sufficient. Exact paid replays of the failed sessions gave Pi's own
 * `Summarization failed: generation hit the token cap and the summary is incomplete` at 4096,
 * 13107, and 32768 output tokens. Synthetic summaries of similarly sized but repetitive text
 * succeeded in 334-381 tokens, demonstrating that input size alone cannot certify a summary cap.
 * Do not spend on another 128-stage run of the same source corpus expecting this constant to fix it.
 */
export const MILLION_SUMMARY_MAX_TOKENS = 13_107;
export const MILLION_KEEP_RECENT_TOKENS = 20_000;

export type MillionArmId = "default" | "fixed60" | "dynamic";

/**
 * A cache namespace per arm: DeepSeek isolates KV cache by `user_id`, so without this the arms
 * could read each other's cached prefixes and stop being independent. Identical within an arm -
 * that is what makes its own cache behaviour measurable - and distinct between arms.
 */
export function millionUserId(arm: MillionArmId): string {
  return `foldpoint-1m-${arm}`;
}

/**
 * The second, arm-level line of defence against cross-arm cache reuse. DeepSeek documents
 * `user_id` as a KV-cache isolation key but never defines how that key is composed, and cache
 * hits are best-effort, so `user_id` alone cannot be trusted to keep the arms apart.
 *
 * Pi renders the system prompt as ordered sections with `preamble` first
 * (`packages/coding-agent/src/core/system-prompt.ts:121-179`), and only a custom
 * system prompt replaces that preamble (`system-prompt.ts:143-144`). An agent-directory
 * `SYSTEM.md` is the clean, per-arm way to supply one: it is discovered from
 * `PI_CODING_AGENT_DIR` (`core/resource-loader.ts:1027-1039`) and the trial already gives every
 * arm its own agent directory, so the trial does not have to touch Pi.
 *
 * All three arms get the same structure and the same shared sentences; only the arm identifier
 * differs, and it *leads* the prompt, so the wire prefix diverges inside the prompt's first
 * characters - not deep inside the conversation where a shared cache prefix would already have
 * been reused. (`default` and `dynamic` share their first letter, so the honest statement is
 * "diverges within the first couple of characters", which the tests assert.) Cost of this line
 * of defence: a custom system prompt also suppresses Pi's generated `tools`/`rules`/`docs`
 * sections, so the fixed prefix is not merely longer - it replaces Pi's stock preamble for all
 * three arms equally. That is a deliberate, arm-symmetric change to the prompt (never to the
 * material or the questions) and it is reported as such.
 */
export function millionSystemPromptMarker(arm: MillionArmId): string {
  // The first character must differ between arms. DeepSeek only reports a cache hit when the
  // request matches a persisted prefix unit from token 0, so a shared opening character could
  // share the opening token - and a shared token 0 is exactly what the isolation is meant to
  // prevent. `user_id` is the documented mechanism; this is the one that holds regardless of
  // how DeepSeek splits its keys. Spelling them out beats deriving them: "default" and
  // "dynamic" share their first letter, which is how the first attempt at this failed.
  return `${MARKER_INITIAL[arm]} / ${arm} / foldpoint-1m cache namespace.`;
}

const MARKER_INITIAL: Readonly<Record<MillionArmId, string>> = {
  default: "A",
  fixed60: "B",
  dynamic: "C",
};

/**
 * Shared body of the injected preamble. Byte-identical in all three arms, so the arms stay
 * comparable; only `millionSystemPromptMarker` differs.
 */
const MILLION_SYSTEM_PROMPT_BODY =
  "Answer only from the material in this conversation: no tools, no file reads, no commands.";

export function millionSystemPrompt(arm: MillionArmId): string {
  return `${millionSystemPromptMarker(arm)}\n${MILLION_SYSTEM_PROMPT_BODY}`;
}

const FIXED_RESERVE_TOKENS = Math.round(MILLION_RUN_WINDOW_TOKENS * (1 - MILLION_FIXED_RATIO));

export const MILLION_ARMS: Readonly<
  Record<
    MillionArmId,
    {
      reserveTokens: number;
      foldPointMode: "observe" | "act";
      foldPointCompaction: "off" | "auto";
    }
  >
> = {
  default: { reserveTokens: 16_384, foldPointMode: "observe", foldPointCompaction: "off" },
  fixed60: {
    reserveTokens: FIXED_RESERVE_TOKENS,
    foldPointMode: "observe",
    foldPointCompaction: "off",
  },
  dynamic: { reserveTokens: 16_384, foldPointMode: "act", foldPointCompaction: "auto" },
};

/** Create a fresh agent directory; never patch the caller's Pi configuration in place. */
export function prepareMillionAgentDir(
  base: string,
  arm: MillionArmId,
  runWindowTokens = MILLION_RUN_WINDOW_TOKENS,
): {
  agentDir: string;
  systemPrompt: string;
  env: {
    FOLDPOINT_MODE: "observe" | "act";
    FOLDPOINT_COMPACTION: "off" | "auto";
    FOLDPOINT_PRICE_SCENARIO: undefined;
  };
} {
  const armConfig = MILLION_ARMS[arm];
  if (armConfig === undefined) throw new Error(`Unknown 1M trial arm: ${arm}`);
  if (
    runWindowTokens !== MILLION_RUN_WINDOW_TOKENS &&
    runWindowTokens !== MILLION_MODEL_WINDOW_TOKENS
  ) {
    throw new Error(
      "The run window must be either the historical 800k budget or the full 1M window",
    );
  }
  const baseModelsPath = join(base, "models.json");
  if (!existsSync(baseModelsPath)) {
    throw new Error(`The 1M trial requires an experiment models.json: ${baseModelsPath}`);
  }
  const models = JSON.parse(readFileSync(baseModelsPath, "utf8")) as {
    providers?: {
      deepseek?: { modelOverrides?: { "deepseek-flash"?: Record<string, unknown> } };
    };
  };
  const model = models.providers?.deepseek?.modelOverrides?.["deepseek-flash"];
  if (model === undefined) {
    throw new Error("The 1M trial requires deepseek/deepseek-flash modelOverrides");
  }
  if (model.cost !== undefined) {
    throw new Error(
      "The 1M trial requires native DeepSeek prices; remove the experiment cost override",
    );
  }
  // Pi uses reserveTokens for both its threshold and its summary budget. The cap below is not a
  // quality knob: it is what pins all three arms' summary budget to the same value, because Pi
  // takes `min(floor(0.8 * reserveTokens), model.maxTokens)` and `reserveTokens` differs per arm.
  // 13,107 = floor(0.8 * 16,384) is the largest cap the default arm can reach on its own; a larger
  // one would let fixed60's 320,000 reserve rise above the other arms again. See
  // `MILLION_SUMMARY_MAX_TOKENS` for why the old 4,096 cap truncated the summary and failed the run.
  model.contextWindow = runWindowTokens;
  model.maxTokens = MILLION_SUMMARY_MAX_TOKENS;
  // Pi's OpenAI provider assigns `samplingParams` straight into the request body
  // (`openai-completions.ts:997`), so this is how the arm's cache namespace reaches DeepSeek.
  model.samplingParams = { temperature: 0, user_id: millionUserId(arm) };

  const settingsPath = join(base, "settings.json");
  const settings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Invalid Pi settings object: ${settingsPath}`);
  }
  settings.compaction = {
    enabled: true,
    reserveTokens:
      arm === "fixed60"
        ? Math.round(runWindowTokens * (1 - MILLION_FIXED_RATIO))
        : armConfig.reserveTokens,
    keepRecentTokens: MILLION_KEEP_RECENT_TOKENS,
    modelOverrides: {},
  };
  settings.cacheWarming = "off";
  // Source-reading trial: answer only from staged material, not by reading the local Pi checkout.
  settings.defaultTools = [];

  const agentDir = mkdtempSync(join(base, "foldpoint-1m-"));
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(sessionDir);
  settings.sessionDir = sessionDir;
  const systemPrompt = millionSystemPrompt(arm);
  // Pi reads an agent-directory SYSTEM.md without any project-trust requirement and uses it as
  // the preamble of the system prompt, i.e. the first tokens of every request (`millionSystemPrompt`).
  writeFileSync(join(agentDir, "SYSTEM.md"), `${systemPrompt}\n`, "utf8");
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return {
    agentDir,
    systemPrompt,
    env: {
      FOLDPOINT_MODE: armConfig.foldPointMode,
      FOLDPOINT_COMPACTION: armConfig.foldPointCompaction,
      FOLDPOINT_PRICE_SCENARIO: undefined,
    },
  };
}
