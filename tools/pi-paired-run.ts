/**
 * Paired real-task trial: Pi's own compaction timing against FoldPoint's.
 *
 * The same tasks, model, compactor (Pi's), adapter and cache-warming mode across four arms:
 * Pi default threshold, low threshold alone, low threshold plus FoldPoint veto, and a fixed
 * late threshold. All costs, including compactions, come from traces. Every task has a
 * machine-checkable artifact: a cheaper run that got the answer wrong is not a win.
 *
 *   npx tsx tools/pi-paired-run.ts [--reps 3] [--tasks a,b] [--cache-warming off|streaming|idle] [--out <prefix>]
 *
 * Environment: `PI_CLI` (path to Pi's cli.js), optional `PI_NODE` (Node >=22.19),
 * `PI_CODING_AGENT_DIR`, `PI_MODEL` (default
 * `deepseek-flash`), `PI_EXTENSION` (default `adapters/pi/foldpoint-observe.ts`).
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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

export const TASKS: readonly Task[] = [
  {
    id: "steps",
    prompt:
      "Work through big.txt in 8 steps of 60 lines each, one step at a time, waiting for each read to finish: step 1 offset 1 limit 60, step 2 offset 61 limit 60, and so on. After each read append exactly the first line number you saw as one line in notes.md, with no other text. After step 8 print DONE.",
    artifact: "notes.md",
    expectation: "notes.md contains a line for each of the 8 chunk starts, 1 61 ... 421",
    check: hasExactStepLines,
    requiredInputs: ["big.txt"],
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
    requiredInputs: ["big.txt"],
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
];

interface RunSpec {
  task: Task;
  condition: ConditionId;
  rep: number;
}

function parseArgs(argv: readonly string[]): {
  reps: number;
  tasks: string[];
  outPrefix: string;
  cacheWarming: CacheWarmingMode;
} {
  const options = {
    reps: 3,
    tasks: TASKS.map((task) => task.id),
    outPrefix: join(homedir(), ".foldpoint", "paired", `run-${Date.now()}`),
    cacheWarming: "off" as CacheWarmingMode,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reps") {
      options.reps = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--tasks") {
      options.tasks = (argv[index + 1] ?? "").split(",").filter((id) => id.length > 0);
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

function sessionCostOf(tracePath: string): SessionCost | null {
  if (!existsSync(tracePath)) return null;
  const parsed = parseTraceJsonl(readFileSync(tracePath, "utf8"));
  if (parsed.errors.length > 0) {
    return null;
  }
  const analysis = analyzeTraceEvents(parsed.events as TraceEvent[]);
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

/** Use a fresh Pi configuration per run, leaving the user's settings and credentials intact. */
export function prepareAgentDir(
  base: string,
  condition: ConditionId,
  cacheWarming: CacheWarmingMode = "off",
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
function preflight(scratch: string, tracePath: string, agentDir: string): void {
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
      },
    },
  );

  let artifactOk = false;
  try {
    artifactOk = spec.task.check(readFileSync(join(scratch, spec.task.artifact), "utf8"), scratch);
  } catch {
    artifactOk = false;
  }

  return {
    task: spec.task.id,
    condition: spec.condition,
    cacheWarming,
    rep: spec.rep,
    exitCode: result.status ?? -1,
    ok: (result.status ?? -1) === 0,
    artifactOk,
    cost: sessionCostOf(tracePath),
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
  const lines = [
    `Cache warming: ${cacheWarming} (fixed across all arms)`,
    "",
    "| task | condition | rep | exit | artifact | calls | compactions | cache warms | warm cost | total cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.task} | ${result.condition} | ${result.rep} | ${result.exitCode} | ${result.artifactOk ? "ok" : "MISSING"} | ${result.cost?.calls ?? "?"} | ${result.cost?.compactions ?? "?"} | ${result.cost?.cacheWarms ?? "?"} | ${result.cost ? `${result.cost.cacheWarmCost.toFixed(6)} ${result.cost.currency}` : "?"} | ${result.cost ? `${result.cost.totalCost.toFixed(6)} ${result.cost.currency}` : "?"} |`,
    );
  }

  for (const task of tasks) {
    const runs = results.filter((result) => result.task === task.id);
    const byCondition = (condition: ConditionId): RunResult[] =>
      runs.filter((result) => result.condition === condition);
    const totals = (condition: ConditionId): number =>
      byCondition(condition).reduce((sum, result) => sum + (result.cost?.totalCost ?? 0), 0);
    const quality = (condition: ConditionId): number =>
      byCondition(condition).filter((result) => result.ok && result.artifactOk).length;
    const summary = CONDITIONS.map(
      (condition) =>
        `${condition.id} ${totals(condition.id).toFixed(6)} (${quality(condition.id)}/${byCondition(condition.id).length} ok)`,
    ).join(" vs ");
    lines.push("", `**${task.id}** (${task.expectation}), all-run incurred costs: ${summary}`);

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
    const passingSummary = CONDITIONS.map((condition) => {
      const arm = passingCost(condition.id);
      return `${condition.id} ${arm.runs === 0 ? "n/a" : arm.total.toFixed(6)} (${arm.runs} runs)`;
    }).join(" vs ");
    lines.push(`  - passing runs (not directly comparable if counts differ): ${passingSummary}`);
    for (const [condition, baseline] of [
      ["ask", "default"],
      ["veto", "default"],
      ["late", "default"],
      ["veto", "late"],
    ] as const) {
      const paired = passing.filter(
        (result) =>
          result.condition === baseline &&
          passing.some((other) => other.condition === condition && other.rep === result.rep),
      );
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
      lines.push(
        `  - paired ${condition} vs ${baseline}: ${paired.length} matched passing rep(s), ${delta} cost change`,
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
  const scratch = process.env.PI_SCRATCH ?? join(homedir(), ".foldpoint", "paired", "scratch");
  const agentBase = process.env.PI_CODING_AGENT_DIR;
  if (agentBase === undefined)
    throw new Error("PI_CODING_AGENT_DIR is required for a controlled trial");

  const selected = TASKS.filter((task) => options.tasks.includes(task.id));
  const specs: RunSpec[] = [];
  const armOrder = CONDITIONS.map((condition) => condition.id);
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
    prepareAgentDir(agentBase, "default", options.cacheWarming),
  );
  console.log("preflight: the extension loaded and wrote a trace header");

  const results: RunResult[] = [];
  for (const spec of specs) {
    const tracePath = `${options.outPrefix}-${spec.task.id}-${spec.condition}-${spec.rep}.jsonl`;
    const result = runOnce(
      spec,
      prepareTaskScratch(scratch, spec.task),
      tracePath,
      prepareAgentDir(agentBase, spec.condition, options.cacheWarming),
      options.cacheWarming,
    );
    results.push(result);
    console.log(
      `${spec.task.id} ${spec.condition} #${spec.rep}: exit=${result.exitCode} artifact=${result.artifactOk ? "ok" : "MISSING"} cost=${result.cost?.totalCost.toFixed(6) ?? "?"}`,
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
