/** Persistent, staged Pi RPC runner for the three-arm 1M trial. No prompt text in reports. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceJsonl, type TraceEvent } from "../src/index";
import { type MillionArmId, prepareMillionAgentDir } from "./pi-million-config";
import { analyzeTraceEvents } from "./trace-analyze";

interface Stage {
  file: string;
  /** A short, exact marker expected in the final assistant reply. Not prompt content. */
  expectedContains?: string;
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
}

interface ArmResult {
  arm: MillionArmId;
  completed: boolean;
  stages: StageResult[];
  reason: string | null;
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
}

interface RpcEvent {
  type?: string;
  id?: string;
  success?: boolean;
  error?: string;
  data?: { isCompacting?: boolean };
  message?: {
    role?: string;
    stopReason?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

const ARM_IDS: readonly MillionArmId[] = ["default", "fixed60", "dynamic"];
const EXTENSION = fileURLToPath(new URL("../adapters/pi/foldpoint-observe.ts", import.meta.url));

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
        (typeof stage.expectedContains !== "string" || stage.expectedContains.length > 128))
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

class RpcSession {
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
      if (remaining <= 0 || this.child.exitCode !== null || this.#spawnError) {
        throw new Error(`Pi RPC event timeout or exit (exit=${this.child.exitCode ?? "running"})`);
      }
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

  async settleCompaction(from: number, timeoutMs: number): Promise<void> {
    // `agent_settled` may precede the adapter's detached 250-ms idle poll. Give it two
    // ticks, then confirm no compaction remains; never send a prompt while Pi is compacting.
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
      if (state.data?.isCompacting !== true && starts === ends) return;
      if (Date.now() >= deadline)
        throw new Error("Pi compaction did not settle before the next turn");
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

function traceTotals(path: string): { promptTokens: number; compactions: number } {
  if (!existsSync(path)) return { promptTokens: 0, compactions: 0 };
  const parsed = parseTraceJsonl(readFileSync(path, "utf8"));
  if (parsed.errors.length > 0) throw new Error("Incomplete or invalid FoldPoint trace");
  return {
    promptTokens: parsed.events
      .filter((event) => event.type === "request")
      .reduce((sum, event) => sum + event.usage.promptTokens, 0),
    compactions: parsed.events.filter((event) => event.type === "compaction" && event.success)
      .length,
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
): Promise<ArmResult> {
  const { agentDir, env: armEnv } = prepareMillionAgentDir(base, arm);
  const tracePath = `${out}-${arm}.jsonl`;
  if (existsSync(tracePath)) throw new Error(`Refusing to overwrite trace: ${tracePath}`);
  const rpc = new RpcSession(
    piNode,
    [piCli, "--mode", "rpc", "--model", "deepseek-flash", "--no-approve", "--extension", EXTENSION],
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
  try {
    await rpc.command("get_state");
    for (let index = 0; index < prompts.length; index += 1) {
      const from = rpc.events.length;
      await rpc.command("prompt", { message: prompts[index] }, 30_000);
      const { index: settledIndex } = await rpc.waitFor(
        (event) => event.type === "agent_settled",
        from,
        300_000,
      );
      await rpc.settleCompaction(from, 300_000);
      const replies = rpc.events
        .slice(from, settledIndex + 1)
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant");
      const last = replies.at(-1)?.message;
      const answer = (last?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      const expected = manifest.stages[index]?.expectedContains;
      const passed =
        last?.stopReason === "stop" && (expected === undefined || answer.includes(expected));
      const totals = traceTotals(tracePath);
      stages.push({
        stage: index + 1,
        passed,
        promptTokensSoFar: totals.promptTokens,
        compactionsSoFar: totals.compactions,
      });
      if (!passed) {
        reason = `quality-failure-stage-${index + 1}`;
        break;
      }
      if (totals.promptTokens > maxPromptTokens) {
        reason = "prompt-token-budget";
        break;
      }
    }
  } catch (error) {
    reason = error instanceof Error ? error.message.slice(0, 120) : "unknown Pi RPC failure";
  } finally {
    await rpc.close();
  }
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
  if (rpc.diagnostics.badLines > 0) reason ??= "non-JSON Pi RPC output";
  if (
    analysis === null ||
    !analysis.usableForCalibration ||
    analysis.completeSessions !== 1 ||
    analysis.censoredSessions !== 0 ||
    analysis.sessionCosts.length !== 1 ||
    analysis.unpairedDecisions > 0 ||
    analysis.unpriceable > 0 ||
    analysis.unknownCacheUsage > 0 ||
    !pricingConsistent ||
    (cost?.unpricedCompactions ?? 0) > 0
  ) {
    reason ??= "incomplete-or-unpriced-trace";
  }
  return {
    arm,
    completed: reason === null && stages.length === prompts.length,
    stages,
    reason,
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
      "Usage: PI_CLI=... tsx tools/pi-million-rpc.ts --manifest <json> --agent-base <dir> --out <prefix> [--max-prompt-tokens N]",
    );
  }
  const maxPromptTokens = Number(value("--max-prompt-tokens") ?? 40_000_000);
  if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens <= 0)
    throw new Error("Invalid prompt-token budget");
  const minCompactions = Number(value("--min-compactions") ?? 2);
  if (!Number.isSafeInteger(minCompactions) || minCompactions < 0)
    throw new Error("Invalid minimum compaction count");
  const output = resolve(out);
  const manifestData = readManifest(resolve(manifestPath));
  const reportPath = `${output}-report.json`;
  if (existsSync(reportPath) || ARM_IDS.some((arm) => existsSync(`${output}-${arm}.jsonl`))) {
    throw new Error("Refusing to overwrite an existing 1M trial result");
  }
  mkdirSync(dirname(output), { recursive: true });
  const results: ArmResult[] = [];
  for (const arm of ARM_IDS) {
    const result = await runArm(
      arm,
      resolve(base),
      piCli,
      process.env.PI_NODE ?? process.execPath,
      output,
      manifestData.manifest,
      manifestData.prompts,
      maxPromptTokens,
    );
    results.push(result);
    process.stdout.write(
      `${arm}: ${result.completed ? "complete" : result.reason}, calls=${result.calls}, compactions=${result.compactions}\n`,
    );
    if (!result.completed) break;
  }
  const report = {
    runner: "foldpoint.pi-million-rpc.v1",
    qualityGate: "exact expectedContains marker per stage; external task oracle not included",
    manifestId: manifestData.manifest.id,
    manifestHash: manifestData.hash,
    minCompactions,
    arms: results,
    comparable:
      results.length === 3 &&
      results.every((result) => result.completed && result.compactions >= minCompactions) &&
      results.every((result) => result.pricingFingerprint === results[0]?.pricingFingerprint),
    costBasis: "Pi model pricing snapshot applied to provider usage; not the final provider bill",
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`report: ${reportPath}\n`);
  if (!report.comparable) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
