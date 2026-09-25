/**
 * Paired real-task trial: Pi's own compaction timing against FoldPoint's.
 *
 * The same tasks, model, compactor (Pi's), adapter and cache-warming mode across four arms:
 * Pi default threshold, low threshold alone, low threshold plus FoldPoint veto, and a fixed
 * late threshold. All costs, including compactions, come from traces. Every task has a
 * machine-checkable artifact: a cheaper run that got the answer wrong is not a win.
 *
 *   npx tsx tools/pi-paired-run.ts [--reps 3] [--tasks a,b] [--conditions default,veto,late]
 *     [--price-scenario native|cache-read-60|cache-write-200] [--cache-warming off] [--out <prefix>]
 *
 * Environment: `PI_CLI` (path to Pi's cli.js), optional `PI_NODE` (Node >=22.19),
 * `PI_CODING_AGENT_DIR`, `PI_MODEL` (default
 * `deepseek-flash`), `PI_EXTENSION` (default `adapters/pi/foldpoint-observe.ts`).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceJsonl, type TraceEvent } from "../src/index";
import { analyzeTraceEvents, type SessionCost } from "./trace-analyze";

export interface Task {
  id: string;
  prompt: string;
  /** File the task must produce, relative to the scratch directory. */
  artifact: string;
  /** The artifact is only accepted when this returns true. */
  check: (contents: string, scratch: string) => boolean;
  /** What the check means, for the report. */
  expectation: string;
  requiredInputs?: readonly string[];
  seed?: (scratch: string) => void;
}

export interface RunResult {
  task: string;
  condition: ConditionId;
  priceScenario: PriceScenarioId;
  cacheWarming: CacheWarmingMode;
  rep: number;
  exitCode: number;
  ok: boolean;
  artifactOk: boolean;
  cost: SessionCost | null;
  trace: string;
}

export type ConditionId = "default" | "ask" | "veto" | "late";
export type CacheWarmingMode = "off" | "streaming" | "idle";
export type PriceScenarioId =
  | "native"
  | "cache-read-60"
  | "cache-write-200"
  | "claude-like"
  | "write-free"
  | "write-050";

/**
 * Hypothetical USD-like units per million tokens, not a quote for another provider.
 *
 * All hypothetical scenarios keep input at 1 and output at 5, so the only variables are the two
 * cache rates. `claude-like` is Claude Sonnet's shape (3 / 15 / 0.3 / 3.75 per million, i.e.
 * 1 / 5 / 0.1 / 1.25 once input is 1); `write-free` and `write-050` move only the cache-write
 * rate, which is the one rate DeepSeek charges nothing for and Claude charges 1.25x input for.
 * That is the structural difference a compaction-timing policy is supposed to react to: a
 * compaction rewrites a prefix, which is free on DeepSeek and expensive on a Claude-shaped bill.
 */
export const TRIAL_PRICES: Readonly<
  Record<
    Exclude<PriceScenarioId, "native">,
    {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  >
> = {
  "cache-read-60": { input: 1, output: 5, cacheRead: 0.6, cacheWrite: 1.25 },
  "cache-write-200": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  "claude-like": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "write-free": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
  "write-050": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0.5 },
};

/**
 * Four arms. Moving Pi's threshold earlier is part of how FoldPoint gets control, so it
 * cannot also be a difference between the arms being compared: `ask` isolates the threshold
 * move alone (same low threshold, observe-only), and `veto` adds FoldPoint's answers on top.
 * `late` asks whether a cheap fixed late threshold can do just as well as the dynamic veto.
 * It uses a 6K reserve, greater than the 4K recent-message budget used in this trial. This
 * arm is intended for the controlled 26K-window experiment, not as a universal Pi setting.
 */
export const CONDITIONS: ReadonlyArray<{
  id: ConditionId;
  mode: "observe" | "act";
  /** Pi's `compaction.reserveTokens` for this arm; the threshold is window minus this. */
  reserveTokens: number;
  label: string;
}> = [
  { id: "default", mode: "observe", reserveTokens: 16384, label: "Pi's own threshold, no policy" },
  { id: "ask", mode: "observe", reserveTokens: 24000, label: "low threshold, no policy" },
  { id: "veto", mode: "act", reserveTokens: 24000, label: "low threshold, FoldPoint answers" },
  { id: "late", mode: "observe", reserveTokens: 6000, label: "fixed late threshold, no policy" },
];

/** The line numbers an 8-step read of 60-line chunks must report. */
const STEP_LINES = [1, 61, 121, 181, 241, 301, 361, 421];

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRICING_ORACLE = "benchmarks/fixtures/pi-pricing/oracle.test.mjs";

function gitBytes(args: string[]): Buffer {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || result.stdout === null) {
    throw new Error(`git ${args[0]} failed while preparing the frozen pricing task`);
  }
  return result.stdout;
}

function pricingSnapshot(): { files: string[]; bytes: (path: string) => Buffer } {
  const revision = gitBytes(["rev-parse", "HEAD"]).toString("utf8").trim();
  const files = gitBytes(["ls-tree", "-r", "-z", "--name-only", revision])
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && path !== PRICING_ORACLE);
  return { files, bytes: (path) => gitBytes(["show", `${revision}:${path}`]) };
}

function pricingRegressionSource(source: string): string {
  const rewrite =
    "const rewriteCost = prompt * prices.cacheWritePerToken + output * prices.outputPerToken;";
  const liveTail =
    "(prompt - prefixTokens) * prices.inputPerToken +\n    output * prices.outputPerToken;";
  if (source.split(rewrite).length !== 2 || source.split(liveTail).length !== 2) {
    throw new Error("Pricing source changed; review the benchmark mutation before running");
  }
  return source
    .replace(
      rewrite,
      "const rewriteCost = prompt * prices.inputPerToken + output * prices.outputPerToken;",
    )
    .replace(liveTail, "(prompt - prefixTokens) * prices.inputPerToken;");
}

function safeVerificationEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ...extra,
  };
}

function npmInScratch(scratch: string, command: string, timeout: number): boolean {
  const result = spawnSync("npm.cmd", ["run", command], {
    cwd: scratch,
    shell: process.platform === "win32",
    env: safeVerificationEnv({
      npm_config_userconfig: join(scratch, ".npmrc"),
      FOLDPOINT_PRICING_VERIFY: "1",
    }),
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0;
}

function seedPricingRegression(scratch: string): void {
  const snapshot = pricingSnapshot();
  const installedDependencies = join(REPO_ROOT, "node_modules");
  if (
    !existsSync(installedDependencies) ||
    !readFileSync(join(REPO_ROOT, "package-lock.json")).equals(snapshot.bytes("package-lock.json"))
  ) {
    throw new Error("Run npm ci in the FoldPoint repository before seeding the pricing task");
  }
  for (const path of snapshot.files) {
    const destination = join(scratch, path);
    mkdirSync(dirname(destination), { recursive: true });
    const original = snapshot.bytes(path);
    writeFileSync(
      destination,
      path === "src/pricing.ts" ? pricingRegressionSource(original.toString("utf8")) : original,
    );
  }
  writeFileSync(join(scratch, ".npmrc"), "");
  // A one-time, lockfile-matched local install is copied into each arm. This keeps the
  // benchmark offline during seeding and avoids arm-order bias from registry/network latency.
  // It is a copy, never a junction back into the user's repository.
  cpSync(installedDependencies, join(scratch, "node_modules"), { recursive: true });
}

function checkPricingRegression(contents: string, scratch: string): boolean {
  if (contents.trim().length === 0) return false;
  const snapshot = pricingSnapshot();
  for (const path of snapshot.files) {
    if (path === "src/pricing.ts") continue;
    const expected = createHash("sha256").update(snapshot.bytes(path)).digest("hex");
    const actual = createHash("sha256")
      .update(readFileSync(join(scratch, path)))
      .digest("hex");
    if (actual !== expected) return false;
  }
  if (!npmInScratch(scratch, "typecheck", 30_000)) return false;
  if (!npmInScratch(scratch, "test", 60_000)) return false;
  if (!npmInScratch(scratch, "build", 60_000)) return false;
  const oracle = spawnSync(
    process.env.PI_NODE ?? process.execPath,
    ["--test", join(REPO_ROOT, PRICING_ORACLE)],
    {
      cwd: scratch,
      env: safeVerificationEnv({ FOLDPOINT_PRICING_BUILD: join(scratch, "dist", "index.js") }),
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return oracle.status === 0;
}

function hasExactStepLines(contents: string): boolean {
  const lines = contents
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  return (
    lines.length === STEP_LINES.length &&
    lines.every((line, index) => line === String(STEP_LINES[index]))
  );
}

/** Lines in the generated corpus, and the width each line is padded to. */
const CORPUS_LINES = 480;
const CORPUS_LINE_CHARS = 253;

/**
 * Write the task corpus instead of copying it from the seed directory.
 *
 * A cohort is only reproducible if the file that decided its token counts is reproducible too.
 * The first cohorts copied a 121,440-byte `big.txt` out of a temp directory; it is gone now, and
 * with it any chance of re-running those runs. This generator produces the same shape (480
 * lines, ~253 characters each) deterministically, and every report can cite its hash.
 */
function writeSeedCorpus(scratch: string): void {
  const stem =
    "the foldpoint scratch corpus records one deterministic sentence per line so that a reader can summarise it without ambiguity and without needing the surrounding file. ";
  const lines: string[] = [];
  for (let index = 1; index <= CORPUS_LINES; index += 1) {
    const prefix = `Line ${String(index).padStart(4, "0")}: `;
    const body = stem
      .repeat(Math.ceil(CORPUS_LINE_CHARS / stem.length))
      .slice(0, CORPUS_LINE_CHARS - prefix.length);
    lines.push(`${prefix}${body}`);
  }
  writeFileSync(join(scratch, "big.txt"), `${lines.join("\n")}\n`, "utf8");
}

export const TASKS: readonly Task[] = [
  {
    id: "steps",
    prompt:
      "Work through big.txt in 8 steps of 60 lines each, one step at a time, waiting for each read to finish: step 1 offset 1 limit 60, step 2 offset 61 limit 60, and so on. After each read append exactly the first line number you saw as one line in notes.md, with no other text. After step 8 print DONE.",
    artifact: "notes.md",
    expectation: "notes.md contains a line for each of the 8 chunk starts, 1 61 ... 421",
    check: hasExactStepLines,
    requiredInputs: [],
    seed: writeSeedCorpus,
  },
  {
    id: "sum",
    prompt:
      "Write a small node script sum.js that adds the numbers 1 to 1000 and prints the total, run it, read the output, and write the total into out-sum.md. Then print DONE.",
    artifact: "out-sum.md",
    expectation: "out-sum.md contains 500500",
    check: (contents) => contents.includes("500500"),
  },
  {
    // The point of this one: the task state lives in the workspace, not in the context, so a
    // compaction cannot make it fail. Both arms should finish it correctly, which is what makes
    // their costs comparable - a cheaper run that lost the task is not a saving.
    id: "resume",
    prompt:
      "Work through big.txt in 8 steps of 60 lines each. For step N read 60 lines starting at offset (N-1)*60+1. Before every step, read notes.md to see which steps are already recorded and do the next step that is missing. After each read, append exactly that chunk's first line number as one line in notes.md, with no other text. When all 8 steps are recorded, print DONE.",
    artifact: "notes.md",
    expectation: "notes.md contains a line for each of the 8 chunk starts, 1 61 ... 421",
    check: hasExactStepLines,
    requiredInputs: [],
    seed: writeSeedCorpus,
  },
  {
    id: "ledger",
    prompt:
      "Read SPEC.md and ledger.mjs. Repair summarizeLedger so it obeys the entire contract, then run your own focused checks. Keep the public export and do not alter SPEC.md. Finish with DONE.",
    artifact: "ledger.mjs",
    expectation: "the repaired module passes five independent, read-only oracle tests",
    requiredInputs: [],
    seed: (scratch) => {
      for (const name of ["SPEC.md", "ledger.mjs"]) {
        copyFileSync(
          fileURLToPath(new URL(`../benchmarks/fixtures/pi-ledger/${name}`, import.meta.url)),
          join(scratch, name),
        );
      }
    },
    check: (contents, scratch) => {
      if (contents.trim().length === 0) return false;
      const spec = fileURLToPath(
        new URL("../benchmarks/fixtures/pi-ledger/SPEC.md", import.meta.url),
      );
      if (readFileSync(join(scratch, "SPEC.md"), "utf8") !== readFileSync(spec, "utf8")) {
        return false;
      }
      const oracle = fileURLToPath(
        new URL("../benchmarks/fixtures/pi-ledger/oracle.test.mjs", import.meta.url),
      );
      const result = spawnSync(process.env.PI_NODE ?? process.execPath, ["--test", oracle], {
        cwd: scratch,
        // Candidate code is generated by an agent. Do not expose provider keys or inherited
        // Node hooks to the verification process; only the candidate path is needed.
        env: {
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          FOLDPOINT_LEDGER_CANDIDATE: join(scratch, "ledger.mjs"),
        },
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      return result.status === 0;
    },
  },
  {
    id: "pricing-regression",
    prompt:
      "This is a frozen FoldPoint repository snapshot with a regression in cache-aware call billing. Diagnose the failing tests and repair src/pricing.ts. In particular, the cost model must bill an expired cache write and a live cached call correctly, including output tokens. Do not change tests, documentation, package files or any other tracked file. Run the relevant tests and typecheck, then finish with DONE.",
    artifact: "src/pricing.ts",
    expectation:
      "unchanged repository except src/pricing.ts; full tests, typecheck, build and external pricing oracle pass",
    requiredInputs: [],
    seed: seedPricingRegression,
    check: checkPricingRegression,
  },
];

interface RunSpec {
  task: Task;
  condition: ConditionId;
  rep: number;
}

function parseArgs(argv: readonly string[]): {
  reps: number;
  tasks: string[];
  conditions: ConditionId[];
  priceScenario: PriceScenarioId;
  outPrefix: string;
  cacheWarming: CacheWarmingMode;
  temperature: number | undefined;
} {
  const options = {
    reps: 3,
    tasks: TASKS.map((task) => task.id),
    conditions: CONDITIONS.map((condition) => condition.id),
    priceScenario: "native" as PriceScenarioId,
    outPrefix: join(homedir(), ".foldpoint", "paired", `run-${Date.now()}`),
    cacheWarming: "off" as CacheWarmingMode,
    temperature: undefined as number | undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reps") {
      options.reps = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--tasks") {
      options.tasks = (argv[index + 1] ?? "").split(",").filter((id) => id.length > 0);
      index += 1;
    } else if (arg === "--conditions") {
      const selected = (argv[index + 1] ?? "").split(",");
      if (
        selected.length === 0 ||
        selected.some((id) => !CONDITIONS.some((arm) => arm.id === id))
      ) {
        throw new Error("--conditions must be a comma-separated subset of default,ask,veto,late");
      }
      options.conditions = selected as ConditionId[];
      index += 1;
    } else if (arg === "--price-scenario") {
      const scenario = argv[index + 1];
      if (scenario === undefined || !(scenario === "native" || scenario in TRIAL_PRICES)) {
        throw new Error(
          `--price-scenario must be native or one of ${Object.keys(TRIAL_PRICES).join(", ")}`,
        );
      }
      options.priceScenario = scenario as PriceScenarioId;
      index += 1;
    } else if (arg === "--temperature") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--temperature must be a non-negative number");
      }
      options.temperature = value;
      index += 1;
    } else if (arg === "--out") {
      options.outPrefix = resolve(argv[index + 1] ?? options.outPrefix);
      index += 1;
    } else if (arg === "--cache-warming") {
      const mode = argv[index + 1];
      if (mode !== "off" && mode !== "streaming" && mode !== "idle") {
        throw new Error("--cache-warming must be off, streaming or idle");
      }
      options.cacheWarming = mode;
      index += 1;
    }
  }
  return options;
}

export function sessionCostOf(
  tracePath: string,
  scenario: PriceScenarioId = "native",
): SessionCost | null {
  if (!existsSync(tracePath)) return null;
  const parsed = parseTraceJsonl(readFileSync(tracePath, "utf8"));
  if (parsed.errors.length > 0) {
    return null;
  }
  if (scenario !== "native") {
    const expected = TRIAL_PRICES[scenario];
    const decisions = parsed.events.filter((event) => event.type === "decision");
    if (
      decisions.length === 0 ||
      decisions.some((event) => {
        const price = event.profile.pricing;
        return (
          price?.currency !== "HYPOTHETICAL" ||
          price.source !== `pi-experiment:${scenario}:deepseek/deepseek-flash` ||
          price.inputPerMillion !== expected.input ||
          price.outputPerMillion !== expected.output ||
          price.cacheReadPerMillion !== expected.cacheRead ||
          price.cacheWritePerMillion !== expected.cacheWrite
        );
      })
    ) {
      throw new Error(`Trace price mismatch for ${scenario}: ${tracePath}`);
    }
  }
  const analysis = analyzeTraceEvents(parsed.events as TraceEvent[]);
  if (scenario !== "native" && analysis.cacheWarms > 0) {
    throw new Error(`Hypothetical cost cannot mix Pi's actual-price cache warming: ${tracePath}`);
  }
  // A partial trace may contain a plausible but undercounted cost. Never compare it as a
  // successful priced run; the report will show '?' and omit it from paired deltas.
  if (
    !analysis.usableForCalibration ||
    analysis.completeSessions !== 1 ||
    analysis.censoredSessions !== 0 ||
    analysis.sessionCosts.length !== 1 ||
    analysis.unpairedDecisions !== 0 ||
    analysis.unpriceable !== 0 ||
    analysis.unknownCacheUsage !== 0
  ) {
    return null;
  }
  return analysis.sessionCosts[0] ?? null;
}

/** Read-only seed files. A run gets a fresh directory; nothing in PI_SCRATCH is deleted. */
const SCRATCH_INPUTS = ["big.txt", "notes-a.txt", "data-01.txt", "data-02.txt", "data-03.txt"];

export function prepareScratch(
  seedRoot: string,
  requiredInputs: readonly string[] = ["big.txt"],
): string {
  if (!existsSync(seedRoot) || !lstatSync(seedRoot).isDirectory()) {
    throw new Error(`PI_SCRATCH must be an existing seed directory: ${seedRoot}`);
  }
  const seeded = SCRATCH_INPUTS.filter((name) => existsSync(join(seedRoot, name)));
  for (const name of requiredInputs) {
    if (!seeded.includes(name)) {
      throw new Error(`PI_SCRATCH is missing required seed file ${name}: ${seedRoot}`);
    }
  }
  for (const name of seeded) {
    if (!lstatSync(join(seedRoot, name)).isFile()) {
      throw new Error(`PI_SCRATCH seed must be a regular file: ${name}`);
    }
  }
  const scratch = mkdtempSync(join(seedRoot, "foldpoint-run-"));
  for (const name of seeded) {
    copyFileSync(join(seedRoot, name), join(scratch, name));
  }
  return scratch;
}

export function prepareTaskScratch(seedRoot: string, task: Task): string {
  const scratch = prepareScratch(seedRoot, task.requiredInputs ?? []);
  task.seed?.(scratch);
  return scratch;
}

/**
 * Use a fresh Pi configuration per run, leaving the user's settings and credentials intact.
 *
 * `temperature` fixes the model's sampling for the whole trial. A policy comparison needs the
 * arms to differ by the policy and not by the path the model happened to take: in the first
 * cohorts the same task took 18 to 29 calls across runs, which is larger than the effect being
 * measured. Setting it to 0 trades realism for a comparison that can resolve a small delta.
 */
export function prepareAgentDir(
  base: string,
  condition: ConditionId,
  cacheWarming: CacheWarmingMode = "off",
  priceScenario: PriceScenarioId = "native",
  temperature: number | undefined = undefined,
): string {
  if (!existsSync(base) || !lstatSync(base).isDirectory()) {
    throw new Error(`PI_CODING_AGENT_DIR must be an existing experiment directory: ${base}`);
  }
  const selected = CONDITIONS.find((entry) => entry.id === condition);
  if (selected === undefined) throw new Error(`unknown condition ${condition}`);
  const settingsPath = join(base, "settings.json");
  const settings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  if (settings === null || Array.isArray(settings) || typeof settings !== "object") {
    throw new Error(`Invalid Pi settings object: ${settingsPath}`);
  }
  const agentDir = mkdtempSync(join(base, "foldpoint-agent-"));
  const modelsPath = join(base, "models.json");
  if (existsSync(modelsPath)) copyFileSync(modelsPath, join(agentDir, "models.json"));

  /** Rewrite the run's models.json from the experiment base, optionally patching the model. */
  const patchModel = (patch: (model: Record<string, unknown>) => void): void => {
    if (!existsSync(modelsPath)) {
      throw new Error("This trial requires a models.json experiment config");
    }
    const models = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers?: {
        deepseek?: { modelOverrides?: { "deepseek-flash"?: Record<string, unknown> } };
      };
    };
    const model = models.providers?.deepseek?.modelOverrides?.["deepseek-flash"];
    if (model === undefined) {
      throw new Error("This trial requires deepseek/deepseek-flash modelOverrides");
    }
    patch(model);
    writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
  };

  if (priceScenario !== "native") {
    if (cacheWarming !== "off") {
      throw new Error(
        "Hypothetical pricing requires cache warming off: Pi reports warmer cost at real prices",
      );
    }
    patchModel((model) => {
      model.cost = { ...TRIAL_PRICES[priceScenario] };
    });
  }
  if (temperature !== undefined) {
    // Pi merges `model.samplingParams` into the provider request (`packages/ai/src/simple-options.ts`).
    patchModel((model) => {
      model.samplingParams = {
        ...((model.samplingParams as Record<string, unknown> | undefined) ?? {}),
        temperature,
      };
    });
  }
  const previousCompaction = settings.compaction;
  settings.compaction = {
    ...(previousCompaction !== null &&
    typeof previousCompaction === "object" &&
    !Array.isArray(previousCompaction)
      ? previousCompaction
      : {}),
    enabled: true,
    reserveTokens: selected.reserveTokens,
    keepRecentTokens: 4000,
    modelOverrides: {},
  };
  // Pi 0.87's one-token warming is a separate paid intervention. Keep its configured mode
  // identical across all four arms; default off isolates compaction timing alone.
  settings.cacheWarming = cacheWarming;
  settings.sessionDir = join(agentDir, "sessions");
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return agentDir;
}

/**
 * Proves the extension is actually loaded before anything is spent.
 *
 * Pi loads extensions during boot, before any model call, and the adapter writes its trace
 * header from the extension factory. A `--list-models` run therefore costs nothing and still
 * shows whether the adapter is in the process - the difference between "FoldPoint vetoed" and
 * "FoldPoint was never there" is otherwise invisible in the results.
 */
function preflight(
  scratch: string,
  tracePath: string,
  agentDir: string,
  priceScenario: PriceScenarioId,
): void {
  const piCli = process.env.PI_CLI;
  if (piCli === undefined) {
    throw new Error("PI_CLI must point at Pi's dist/bundle/cli.js");
  }
  if (existsSync(tracePath)) throw new Error(`Refusing to overwrite trace: ${tracePath}`);
  mkdirSync(dirname(tracePath), { recursive: true });
  const result = spawnSync(
    process.env.PI_NODE ?? process.execPath,
    [piCli, "--list-models", "--no-approve", "--extension", extensionPath()],
    {
      cwd: scratch,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
        FOLDPOINT_TRACE: tracePath,
        FOLDPOINT_PRICE_SCENARIO: priceScenario === "native" ? undefined : priceScenario,
      },
    },
  );
  if ((result.status ?? -1) !== 0) {
    throw new Error(`preflight failed: Pi exited ${result.status}\n${result.stderr}`);
  }
  let firstLine = "";
  try {
    firstLine = readFileSync(tracePath, "utf8").split("\n")[0] ?? "";
  } catch {
    throw new Error(
      `preflight failed: the extension wrote no trace at ${tracePath}, so it did not load`,
    );
  }
  if (!firstLine.includes('"type":"header"')) {
    throw new Error(`preflight failed: ${tracePath} does not start with a trace header`);
  }
}

function extensionPath(): string {
  return (
    process.env.PI_EXTENSION ??
    fileURLToPath(new URL("../adapters/pi/foldpoint-observe.ts", import.meta.url))
  );
}

function runOnce(
  spec: RunSpec,
  scratch: string,
  tracePath: string,
  agentDir: string,
  cacheWarming: CacheWarmingMode,
  priceScenario: PriceScenarioId,
): RunResult {
  const piCli = process.env.PI_CLI;
  if (piCli === undefined) {
    throw new Error("PI_CLI must point at Pi's dist/bundle/cli.js");
  }
  const extension = extensionPath();
  const condition = CONDITIONS.find((entry) => entry.id === spec.condition);
  if (condition === undefined) {
    throw new Error(`unknown condition ${spec.condition}`);
  }

  if (existsSync(tracePath)) throw new Error(`Refusing to overwrite trace: ${tracePath}`);
  mkdirSync(dirname(tracePath), { recursive: true });

  const result = spawnSync(
    process.env.PI_NODE ?? process.execPath,
    [
      piCli,
      "--print",
      "--model",
      process.env.PI_MODEL ?? "deepseek-flash",
      "--no-approve",
      "--extension",
      extension,
      spec.task.prompt,
    ],
    {
      cwd: scratch,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
        FOLDPOINT_TRACE: tracePath,
        FOLDPOINT_MODE: condition.mode,
        FOLDPOINT_PRICE_SCENARIO: priceScenario === "native" ? undefined : priceScenario,
      },
    },
  );

  let artifactOk = false;
  try {
    artifactOk = spec.task.check(readFileSync(join(scratch, spec.task.artifact), "utf8"), scratch);
  } catch {
    artifactOk = false;
  }

  const observedCost = sessionCostOf(tracePath, priceScenario);
  return {
    task: spec.task.id,
    condition: spec.condition,
    priceScenario,
    cacheWarming,
    rep: spec.rep,
    exitCode: result.status ?? -1,
    ok: (result.status ?? -1) === 0,
    artifactOk,
    cost: observedCost,
    trace: tracePath,
  };
}

export function renderComparison(
  results: readonly RunResult[],
  tasks: readonly Task[],
  cacheWarming: CacheWarmingMode = "off",
): string {
  if (results.some((result) => result.cacheWarming !== cacheWarming)) {
    throw new Error("Cannot compare runs with different Pi cache-warming modes");
  }
  const priceScenario = results[0]?.priceScenario ?? "native";
  if (results.some((result) => result.priceScenario !== priceScenario)) {
    throw new Error("Cannot compare runs with different hypothetical price scenarios");
  }
  const lines = [
    `Cache warming: ${cacheWarming} (fixed across all arms)`,
    `Price scenario: ${priceScenario}${priceScenario === "native" ? " (Pi model prices)" : ` (hypothetical units per million: ${JSON.stringify(TRIAL_PRICES[priceScenario])}; not the provider bill)`}`,
    "",
    "| task | condition | rep | exit | artifact | calls | compactions | unpriced failures | cache warms | warm cost | observed cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.task} | ${result.condition} | ${result.rep} | ${result.exitCode} | ${result.artifactOk ? "ok" : "MISSING"} | ${result.cost?.calls ?? "?"} | ${result.cost?.compactions ?? "?"} | ${result.cost?.unpricedCompactions ?? "?"} | ${result.cost?.cacheWarms ?? "?"} | ${result.cost ? `${result.cost.cacheWarmCost.toFixed(6)} ${result.cost.currency}` : "?"} | ${result.cost ? `${result.cost.totalCost.toFixed(6)} ${result.cost.currency}` : "?"} |`,
    );
  }

  for (const task of tasks) {
    const runs = results.filter((result) => result.task === task.id);
    const byCondition = (condition: ConditionId): RunResult[] =>
      runs.filter((result) => result.condition === condition);
    const activeConditions = CONDITIONS.filter((condition) => byCondition(condition.id).length > 0);
    const totals = (condition: ConditionId): number =>
      byCondition(condition).reduce((sum, result) => sum + (result.cost?.totalCost ?? 0), 0);
    const quality = (condition: ConditionId): number =>
      byCondition(condition).filter((result) => result.ok && result.artifactOk).length;
    const summary = activeConditions
      .map(
        (condition) =>
          `${condition.id} ${totals(condition.id).toFixed(6)} (${quality(condition.id)}/${byCondition(condition.id).length} ok)`,
      )
      .join(" vs ");
    lines.push(
      "",
      `**${task.id}** (${task.expectation}), all-run observed costs (lower bounds if failures are unpriced): ${summary}`,
    );

    // A missing artifact or a non-zero exit is not a successful run. Report each arm's passing
    // totals, but only compare costs within the same repetition when both arms succeeded.
    const passing = runs.filter((result) => result.ok && result.artifactOk && result.cost !== null);
    const passingCost = (condition: ConditionId): { total: number; runs: number } => {
      const selected = passing.filter((result) => result.condition === condition);
      return {
        total: selected.reduce((sum, result) => sum + (result.cost?.totalCost ?? 0), 0),
        runs: selected.length,
      };
    };
    const passingSummary = activeConditions
      .map((condition) => {
        const arm = passingCost(condition.id);
        return `${condition.id} ${arm.runs === 0 ? "n/a" : arm.total.toFixed(6)} (${arm.runs} runs)`;
      })
      .join(" vs ");
    lines.push(`  - passing runs (not directly comparable if counts differ): ${passingSummary}`);
    for (const [condition, baseline] of [
      ["ask", "default"],
      ["veto", "default"],
      ["late", "default"],
      ["veto", "late"],
    ] as const) {
      if (byCondition(condition).length === 0 || byCondition(baseline).length === 0) continue;
      const matched = passing.filter(
        (result) =>
          result.condition === baseline &&
          passing.some((other) => other.condition === condition && other.rep === result.rep),
      );
      const priced = matched.filter((result) => {
        const candidate = passing.find(
          (other) => other.condition === condition && other.rep === result.rep,
        );
        return result.cost?.unpricedCompactions === 0 && candidate?.cost?.unpricedCompactions === 0;
      });
      // If neither side actually compacted, different model/tool paths may still change the
      // bill, but that delta says nothing about the compaction timing policy.
      const paired = priced.filter((result) => {
        const candidate = passing.find(
          (other) => other.condition === condition && other.rep === result.rep,
        );
        return (result.cost?.compactions ?? 0) + (candidate?.cost?.compactions ?? 0) > 0;
      });
      const baselineTotal = paired.reduce((sum, result) => sum + (result.cost?.totalCost ?? 0), 0);
      const candidateTotal = paired.reduce(
        (sum, result) =>
          sum +
          (passing.find((other) => other.condition === condition && other.rep === result.rep)?.cost
            ?.totalCost ?? 0),
        0,
      );
      const delta =
        paired.length > 0 && baselineTotal > 0
          ? `${(((candidateTotal - baselineTotal) / baselineTotal) * 100).toFixed(1)}%`
          : "n/a";
      const unpriced = matched.length - priced.length;
      const noCompaction = priced.length - paired.length;
      lines.push(
        `  - paired ${condition} vs ${baseline}: ${paired.length}/${matched.length} informative matched passing rep(s), ${delta} cost change${unpriced > 0 ? `; ${unpriced} unpriced-failure pair(s) excluded` : ""}${noCompaction > 0 ? `; ${noCompaction} no-compaction pair(s) excluded` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isSafeInteger(options.reps) || options.reps <= 0) {
    throw new Error("--reps must be a positive integer");
  }
  const unknownTasks = options.tasks.filter((id) => !TASKS.some((task) => task.id === id));
  if (unknownTasks.length > 0 || options.tasks.length === 0) {
    throw new Error(`Unknown or empty task selection: ${options.tasks.join(",")}`);
  }
  if (new Set(options.conditions).size !== options.conditions.length) {
    throw new Error("--conditions must not contain duplicate arms");
  }
  if (
    options.priceScenario !== "native" &&
    (options.cacheWarming !== "off" ||
      (process.env.PI_MODEL ?? "deepseek-flash") !== "deepseek-flash")
  ) {
    throw new Error("Hypothetical pricing requires deepseek-flash and --cache-warming off");
  }
  const scratch = process.env.PI_SCRATCH ?? join(homedir(), ".foldpoint", "paired", "scratch");
  const agentBase = process.env.PI_CODING_AGENT_DIR;
  if (agentBase === undefined)
    throw new Error("PI_CODING_AGENT_DIR is required for a controlled trial");

  const selected = TASKS.filter((task) => options.tasks.includes(task.id));
  const specs: RunSpec[] = [];
  const armOrder = options.conditions;
  for (const task of selected) {
    for (let rep = 1; rep <= options.reps; rep += 1) {
      // Rotate which arm goes first: if the model or the provider drifts over a session, running
      // one arm and then another would turn that drift into an effect.
      const rotated = armOrder.map(
        (_, index) => armOrder[(index + rep - 1) % armOrder.length] as ConditionId,
      );
      for (const condition of rotated) {
        specs.push({ task, condition, rep });
      }
    }
  }

  const outputPaths = [
    `${options.outPrefix}-preflight.jsonl`,
    `${options.outPrefix}-results.json`,
    `${options.outPrefix}-comparison.md`,
    ...specs.map(
      (spec) => `${options.outPrefix}-${spec.task.id}-${spec.condition}-${spec.rep}.jsonl`,
    ),
  ];
  const occupied = outputPaths.find((path) => existsSync(path));
  if (occupied !== undefined) throw new Error(`Refusing to overwrite existing output: ${occupied}`);

  preflight(
    prepareTaskScratch(scratch, selected[0] as Task),
    `${options.outPrefix}-preflight.jsonl`,
    prepareAgentDir(
      agentBase,
      options.conditions[0] as ConditionId,
      options.cacheWarming,
      options.priceScenario,
      options.temperature,
    ),
    options.priceScenario,
  );
  console.log("preflight: the extension loaded and wrote a trace header");

  const results: RunResult[] = [];
  for (const spec of specs) {
    const tracePath = `${options.outPrefix}-${spec.task.id}-${spec.condition}-${spec.rep}.jsonl`;
    const result = runOnce(
      spec,
      prepareTaskScratch(scratch, spec.task),
      tracePath,
      prepareAgentDir(
        agentBase,
        spec.condition,
        options.cacheWarming,
        options.priceScenario,
        options.temperature,
      ),
      options.cacheWarming,
      options.priceScenario,
    );
    results.push(result);
    console.log(
      `${spec.task.id} ${spec.condition} #${spec.rep}: exit=${result.exitCode} artifact=${result.artifactOk ? "ok" : "MISSING"} observedCost=${result.cost?.totalCost.toFixed(6) ?? "?"} unpricedCompactions=${result.cost?.unpricedCompactions ?? "?"}`,
    );
  }

  writeFileSync(
    `${options.outPrefix}-results.json`,
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    `${options.outPrefix}-comparison.md`,
    `${renderComparison(results, selected, options.cacheWarming)}\n`,
    "utf8",
  );
  console.log(`\n${renderComparison(results, selected, options.cacheWarming)}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/pi-paired-run.ts") === true) {
  main();
}
