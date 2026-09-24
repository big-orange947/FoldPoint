/**
 * Paired real-task trial: Pi's own compaction timing against FoldPoint's.
 *
 * The same tasks, the same model, the same compactor (Pi's), the same adapter - only
 * `FOLDPOINT_MODE` differs. `observe` leaves Pi's threshold compaction alone; `act` lets
 * FoldPoint veto it. Both are measured from the traces, including what the compactions
 * themselves cost, and every task has a machine-checkable artifact: a cheaper run that got the
 * answer wrong is not a win.
 *
 *   npx tsx tools/pi-paired-run.ts [--reps 3] [--tasks a,b] [--out <prefix>]
 *
 * Environment: `PI_CLI` (path to Pi's cli.js), `PI_AGENT_DIR`, `PI_MODEL` (default
 * `deepseek-flash`), `PI_EXTENSION` (default `adapters/pi/foldpoint-observe.ts`).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  check: (contents: string) => boolean;
  /** What the check means, for the report. */
  expectation: string;
}

export interface RunResult {
  task: string;
  condition: ConditionId;
  rep: number;
  exitCode: number;
  ok: boolean;
  artifactOk: boolean;
  cost: SessionCost | null;
  trace: string;
}

export type ConditionId = "default" | "ask" | "veto";

/**
 * The three arms. Moving Pi's threshold earlier is part of how FoldPoint gets control, so it
 * cannot also be a difference between the arms being compared: `ask` isolates the threshold
 * move alone (same low threshold, observe-only), and `veto` adds FoldPoint's answers on top.
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
];

/** The line numbers an 8-step read of 60-line chunks must report. */
const STEP_LINES = [1, 61, 121, 181, 241, 301, 361, 421];

export const TASKS: readonly Task[] = [
  {
    id: "steps",
    prompt:
      "Work through big.txt in 8 steps of 60 lines each, one step at a time, waiting for each read to finish: step 1 offset 1 limit 60, step 2 offset 61 limit 60, and so on. After each read append one line to notes.md with the first line number you saw. After step 8 print DONE.",
    artifact: "notes.md",
    expectation: "notes.md contains a line for each of the 8 chunk starts, 1 61 ... 421",
    check: (contents) =>
      STEP_LINES.every((line) =>
        contents.split(/\r?\n/).some((row) => new RegExp(`(^|\\D)${line}(\\D|$)`).test(row)),
      ),
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
      "Work through big.txt in 8 steps of 60 lines each. For step N read 60 lines starting at offset (N-1)*60+1. Before every step, read notes.md to see which steps are already recorded and do the next step that is missing. After each read, append one line to notes.md with that chunk's first line number. When all 8 steps are recorded, print DONE.",
    artifact: "notes.md",
    expectation: "notes.md contains a line for each of the 8 chunk starts, 1 61 ... 421",
    check: (contents) =>
      STEP_LINES.every((line) =>
        contents.split(/\r?\n/).some((row) => new RegExp(`(^|\\D)${line}(\\D|$)`).test(row)),
      ),
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
} {
  const options = {
    reps: 3,
    tasks: TASKS.map((task) => task.id),
    outPrefix: join(homedir(), ".foldpoint", "paired", "run"),
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
    }
  }
  return options;
}

function sessionCostOf(tracePath: string): SessionCost | null {
  const parsed = parseTraceJsonl(readFileSync(tracePath, "utf8"));
  if (parsed.errors.length > 0) {
    return null;
  }
  const analysis = analyzeTraceEvents(parsed.events as TraceEvent[]);
  return analysis.sessionCosts[0] ?? null;
}

/** Files the tasks need; everything else in the scratch directory is reset before each run. */
const SCRATCH_INPUTS = ["big.txt", "notes-a.txt", "data-01.txt", "data-02.txt", "data-03.txt"];

/**
 * A run must not inherit the previous run's workspace, or a later run gets a head start.
 *
 * Only the seeded inputs survive: every artifact a task can produce is removed, so both arms
 * start from the same state whatever the previous run left behind.
 */
function resetScratch(scratch: string): void {
  mkdirSync(scratch, { recursive: true });
  for (const entry of readdirSync(scratch)) {
    if (!SCRATCH_INPUTS.includes(entry)) {
      rmSync(join(scratch, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Proves the extension is actually loaded before anything is spent.
 *
 * Pi loads extensions during boot, before any model call, and the adapter writes its trace
 * header from the extension factory. A `--list-models` run therefore costs nothing and still
 * shows whether the adapter is in the process - the difference between "FoldPoint vetoed" and
 * "FoldPoint was never there" is otherwise invisible in the results.
 */
function preflight(scratch: string, tracePath: string): void {
  const piCli = process.env.PI_CLI;
  if (piCli === undefined) {
    throw new Error("PI_CLI must point at Pi's dist/bundle/cli.js");
  }
  rmSync(tracePath, { force: true });
  const result = spawnSync(
    process.execPath,
    [piCli, "--list-models", "--extension", extensionPath()],
    {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, FOLDPOINT_TRACE: tracePath },
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

function runOnce(spec: RunSpec, scratch: string, tracePath: string): RunResult {
  const piCli = process.env.PI_CLI;
  if (piCli === undefined) {
    throw new Error("PI_CLI must point at Pi's dist/bundle/cli.js");
  }
  const extension = extensionPath();
  const condition = CONDITIONS.find((entry) => entry.id === spec.condition);
  if (condition === undefined) {
    throw new Error(`unknown condition ${spec.condition}`);
  }

  // Pi reads its settings at startup, so writing them here is enough to give each arm its own
  // threshold without touching the user's own agent directory.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir !== undefined) {
    const settingsPath = join(agentDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      settings = {};
    }
    settings.compaction = {
      enabled: true,
      reserveTokens: condition.reserveTokens,
      keepRecentTokens: 4000,
    };
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  resetScratch(scratch);
  rmSync(tracePath, { force: true });
  mkdirSync(dirname(tracePath), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      piCli,
      "--print",
      spec.task.prompt,
      "--model",
      process.env.PI_MODEL ?? "deepseek-flash",
      "--no-approve",
      "--extension",
      extension,
    ],
    {
      cwd: scratch,
      encoding: "utf8",
      env: {
        ...process.env,
        FOLDPOINT_TRACE: tracePath,
        FOLDPOINT_MODE: condition.mode,
      },
    },
  );

  let artifactOk = false;
  try {
    artifactOk = spec.task.check(readFileSync(join(scratch, spec.task.artifact), "utf8"));
  } catch {
    artifactOk = false;
  }

  return {
    task: spec.task.id,
    condition: spec.condition,
    rep: spec.rep,
    exitCode: result.status ?? -1,
    ok: (result.status ?? -1) === 0,
    artifactOk,
    cost: sessionCostOf(tracePath),
    trace: tracePath,
  };
}

export function renderComparison(results: readonly RunResult[], tasks: readonly Task[]): string {
  const lines = [
    "| task | condition | rep | exit | artifact | calls | compactions | total cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.task} | ${result.condition} | ${result.rep} | ${result.exitCode} | ${result.artifactOk ? "ok" : "MISSING"} | ${result.cost?.calls ?? "?"} | ${result.cost?.compactions ?? "?"} | ${result.cost ? `${result.cost.totalCost.toFixed(6)} ${result.cost.currency}` : "?"} |`,
    );
  }

  for (const task of tasks) {
    const runs = results.filter((result) => result.task === task.id);
    const byCondition = (condition: ConditionId): RunResult[] =>
      runs.filter((result) => result.condition === condition);
    const totals = (condition: ConditionId): number =>
      byCondition(condition).reduce((sum, result) => sum + (result.cost?.totalCost ?? 0), 0);
    const quality = (condition: ConditionId): number =>
      byCondition(condition).filter((result) => result.artifactOk).length;
    const summary = CONDITIONS.map(
      (condition) =>
        `${condition.id} ${totals(condition.id).toFixed(6)} (${quality(condition.id)}/${byCondition(condition.id).length} ok)`,
    ).join(" vs ");
    lines.push("", `**${task.id}** (${task.expectation}): ${summary}`);

    // The comparison that answers "what does it save when the outcome is the same": only runs
    // that produced the expected artifact, so a failed run cannot make an arm look cheap.
    const passing = runs.filter((result) => result.artifactOk && result.cost !== null);
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
    const baseline = passingCost("default");
    const vetoed = passingCost("veto");
    const delta =
      baseline.runs > 0 && vetoed.runs > 0
        ? ` — veto ${(((vetoed.total - baseline.total) / baseline.total) * 100).toFixed(0)}% vs default`
        : "";
    lines.push(`  - same outcome only: ${passingSummary}${delta}`);
  }
  return lines.join("\n");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const scratch = process.env.PI_SCRATCH ?? join(homedir(), ".foldpoint", "paired", "scratch");
  mkdirSync(scratch, { recursive: true });

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

  preflight(scratch, `${options.outPrefix}-preflight.jsonl`);
  console.log("preflight: the extension loaded and wrote a trace header");

  const results: RunResult[] = [];
  for (const spec of specs) {
    const tracePath = `${options.outPrefix}-${spec.task.id}-${spec.condition}-${spec.rep}.jsonl`;
    const result = runOnce(spec, scratch, tracePath);
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
    `${renderComparison(results, selected)}\n`,
    "utf8",
  );
  console.log(`\n${renderComparison(results, selected)}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/pi-paired-run.ts") === true) {
  main();
}
