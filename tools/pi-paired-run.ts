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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  condition: "default" | "act";
  rep: number;
  exitCode: number;
  ok: boolean;
  artifactOk: boolean;
  cost: SessionCost | null;
  trace: string;
}

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
  condition: "default" | "act";
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

function runOnce(spec: RunSpec, scratch: string, tracePath: string): RunResult {
  const piCli = process.env.PI_CLI;
  if (piCli === undefined) {
    throw new Error("PI_CLI must point at Pi's dist/bundle/cli.js");
  }
  const extension =
    process.env.PI_EXTENSION ??
    fileURLToPath(new URL("../adapters/pi/foldpoint-observe.ts", import.meta.url));

  rmSync(join(scratch, spec.task.artifact), { force: true });
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
        FOLDPOINT_MODE: spec.condition === "act" ? "act" : "observe",
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
    const byCondition = (condition: "default" | "act"): RunResult[] =>
      runs.filter((result) => result.condition === condition);
    const totals = (condition: "default" | "act"): number =>
      byCondition(condition).reduce((sum, result) => sum + (result.cost?.totalCost ?? 0), 0);
    const quality = (condition: "default" | "act"): number =>
      byCondition(condition).filter((result) => result.artifactOk).length;
    const def = totals("default");
    const act = totals("act");
    lines.push(
      "",
      `**${task.id}** (${task.expectation}): default ${def.toFixed(6)} vs act ${act.toFixed(6)} — ` +
        `${def === 0 ? "n/a" : `${(((act - def) / def) * 100).toFixed(0)}%`}, ` +
        `quality ${quality("default")}/${byCondition("default").length} vs ${quality("act")}/${byCondition("act").length}`,
    );

    // The comparison that answers "what does it save when the outcome is the same": only runs
    // that produced the expected artifact, so a failed run cannot make an arm look cheap.
    const passing = runs.filter((result) => result.artifactOk && result.cost !== null);
    const passingCost = (condition: "default" | "act"): { total: number; runs: number } => {
      const selected = passing.filter((result) => result.condition === condition);
      return {
        total: selected.reduce((sum, result) => sum + (result.cost?.totalCost ?? 0), 0),
        runs: selected.length,
      };
    };
    const defPassing = passingCost("default");
    const actPassing = passingCost("act");
    if (defPassing.runs > 0 && actPassing.runs > 0) {
      lines.push(
        `  - same outcome only (${defPassing.runs} vs ${actPassing.runs} runs): ` +
          `${defPassing.total.toFixed(6)} vs ${actPassing.total.toFixed(6)} — ` +
          `**${(((actPassing.total - defPassing.total) / defPassing.total) * 100).toFixed(0)}%**`,
      );
    } else {
      lines.push("  - same outcome only: not enough passing runs in both arms to compare");
    }
  }
  return lines.join("\n");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const scratch = process.env.PI_SCRATCH ?? join(homedir(), ".foldpoint", "paired", "scratch");
  mkdirSync(scratch, { recursive: true });

  const selected = TASKS.filter((task) => options.tasks.includes(task.id));
  const specs: RunSpec[] = [];
  for (const task of selected) {
    for (const condition of ["default", "act"] as const) {
      for (let rep = 1; rep <= options.reps; rep += 1) {
        specs.push({ task, condition, rep });
      }
    }
  }

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
