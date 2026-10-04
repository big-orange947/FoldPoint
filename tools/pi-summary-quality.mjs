// No paid request without --live. Dry-run exercises real Pi summary prompts with a fake stream.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildQualityPlan,
  gradeQuality,
  QUALITY_QUESTION,
  qualityMessages,
} from "../benchmarks/summary-quality-corpus.ts";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (["--live", "--fake-summary-cap"].includes(args[i])) continue;
  if (
    ["--pi", "--out", "--arms"].includes(args[i]) &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  ) {
    i += 1;
    continue;
  }
  throw new Error("Unknown or incomplete argument; use the direct node/tsx command");
}
const live = args.includes("--live");
const fakeCap = args.includes("--fake-summary-cap");
if (live && fakeCap) throw new Error("Fake failure injection is dry-run only");
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const piRoot = resolve(value("--pi", "D:/pi"));
const out = value("--out", undefined);
const plan = buildQualityPlan();
const runArms = value("--arms", "fullHistory,fixed60,experimental").split(",");
if (
  runArms.length !== new Set(runArms).size ||
  runArms.some((arm) => !["fullHistory", "fixed60", "experimental"].includes(arm))
)
  throw new Error("Invalid arms");
const plannedCalls = runArms.reduce(
  (sum, arm) => sum + (plan.schedules[arm]?.length ?? 0) + plan.checkpoints.length,
  0,
);
if (live && !out) throw new Error("Live runs require a fresh --out directory");
if (out && existsSync(out)) throw new Error("Refusing to overwrite an existing quality result");
const maxHttpCalls = 24;
const maxPromptByteUnits = 500_000; // conservative planning proxy, not a tokenizer guarantee
let httpCalls = 0;
let promptByteUnits = 0;
let logicalCalls = 0;
let httpRequestByteUnits = 0;
const requestAudit = {
  initialSummaries: 0,
  updatedSummaries: 0,
  summariesWithoutCacheRetentionNone: 0,
  summaryOutputCaps: [],
};
const fetchOriginal = globalThis.fetch;
const deny = () => {
  throw new Error("Network forbidden in dry-run");
};
if (!live) {
  globalThis.fetch = deny;
  http.request = deny;
  https.request = deny;
  syncBuiltinESMExports();
} else {
  globalThis.fetch = async (...input) => {
    const url = String(input[0] instanceof Request ? input[0].url : input[0]);
    if (!url.startsWith("https://api.deepseek.com/"))
      throw new Error("Unexpected provider endpoint");
    if (httpCalls >= maxHttpCalls) throw new Error("HTTP budget exhausted");
    const body =
      input[1]?.body ?? (input[0] instanceof Request ? await input[0].clone().text() : undefined);
    if (typeof body !== "string") throw new Error("Unaccountable provider request body");
    const bytes = Buffer.byteLength(body);
    if (httpRequestByteUnits + bytes > maxPromptByteUnits)
      throw new Error("HTTP input planning budget exhausted");
    httpRequestByteUnits += bytes;
    httpCalls += 1;
    return fetchOriginal(...input);
  };
}
const load = (path) => import(pathToFileURL(join(piRoot, path)).href);
const [ai, compat, { generateSummaryWithUsage }] = await Promise.all([
  load("packages/ai/dist/index.js"),
  load("packages/ai/dist/compat.js"),
  load("packages/coding-agent/src/core/compaction/compaction.ts"),
]);
const model = {
  ...compat.getModel("deepseek", "deepseek-flash"),
  maxTokens: plan.summaryMaxOutputTokens,
};
if (!model.id) throw new Error("DeepSeek model missing from local Pi");
const key = live ? process.env.DEEPSEEK_API_KEY : undefined;
if (live && !key) throw new Error("Set DEEPSEEK_API_KEY before --live; nothing was sent");
if (plannedCalls > maxHttpCalls) throw new Error("Plan exceeds the predeclared call budget");
const calls = [];
const usageLedger = [];
let activeCall;
const account = (events) => {
  const originalResult = events.result.bind(events);
  let recorded = false;
  events.result = async () => {
    const response = await originalResult();
    if (!recorded) {
      const usage = response.usage;
      const usageKnown =
        usage !== undefined &&
        [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(Number.isFinite) &&
        (response.stopReason !== "error" ||
          usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0);
      usageLedger.push({
        ...activeCall,
        usage: usage ?? null,
        usageKnown,
        stopReason: response.stopReason,
      });
      recorded = true;
    }
    return response;
  };
  return events;
};
const stream = async (requestModel, context, options) => {
  const bytes = Buffer.byteLength(JSON.stringify(context));
  const serialized = JSON.stringify(context);
  const isSummary = serialized.includes("<conversation>");
  if (isSummary) {
    if (serialized.includes("<previous-summary>")) requestAudit.updatedSummaries += 1;
    else requestAudit.initialSummaries += 1;
    if (options.cacheRetention !== "none") requestAudit.summariesWithoutCacheRetentionNone += 1;
    requestAudit.summaryOutputCaps.push(options.maxTokens);
  }
  if (promptByteUnits + bytes > maxPromptByteUnits || logicalCalls >= maxHttpCalls)
    throw new Error("Logical/input planning budget exhausted");
  promptByteUnits += bytes;
  logicalCalls += 1;
  if (!live) {
    const events = ai.createAssistantMessageEventStream();
    queueMicrotask(() =>
      events.push({
        type: "done",
        reason: fakeCap && isSummary ? "length" : "stop",
        message: {
          ...ai.fauxAssistantMessage("{}"),
          stopReason: fakeCap && isSummary ? "length" : "stop",
          api: requestModel.api,
          provider: requestModel.provider,
          model: requestModel.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      }),
    );
    return account(events);
  }
  return account(
    compat.streamSimple(requestModel, context, {
      ...options,
      apiKey: key,
      reasoning: undefined,
      temperature: 0,
    }),
  );
};
const report = {
  kind: "foldpoint.pi-summary-quality.v2",
  mode: live ? "live" : "dry-run-fake",
  plan,
  runArms,
  plannedCalls,
  harnessSourceSha256: createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex"),
  corpusSourceSha256: createHash("sha256")
    .update(readFileSync(new URL("../benchmarks/summary-quality-corpus.ts", import.meta.url)))
    .digest("hex"),
  piCompactionSourceSha256: createHash("sha256")
    .update(readFileSync(join(piRoot, "packages/coding-agent/src/core/compaction/compaction.ts")))
    .digest("hex"),
  piCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: piRoot, encoding: "utf8" }).trim(),
  taskQualityMeasured: false,
  evidenceRetentionMeasured: live,
  checkpoints: [],
  calls,
  usageLedger,
  hardFailure: null,
  requestAudit,
  budgetEstimate: {
    source: "local Pi model catalog, not a verified current provider quotation",
    currency: "USD",
    conservativeProxyCost:
      (maxPromptByteUnits *
        Math.max(model.cost.input, model.cost.cacheWrite, model.cost.cacheRead) +
        maxHttpCalls * plan.summaryMaxOutputTokens * model.cost.output) /
      1_000_000,
    note: "One byte is budgeted as one input token; this is a planning proxy, not a billing/tokenizer guarantee.",
  },
};
if (out) mkdirSync(out, { recursive: true });
const invoke = async (kind, arm, fn) => {
  activeCall = { kind, arm };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const result = await fn(controller.signal);
    calls.push({ kind, arm, usage: result.usage });
    if (live)
      console.error(
        JSON.stringify({
          completed: calls.length,
          plannedCalls,
          kind,
          arm,
          input: result.usage.input,
          cacheRead: result.usage.cacheRead,
          output: result.usage.output,
        }),
      );
    return result;
  } finally {
    clearTimeout(timer);
  }
};
try {
  for (const arm of runArms) {
    let previousSummary;
    let pending = [];
    for (let step = 0; step < plan.stages; step++) {
      pending.push(...qualityMessages(step));
      if (arm !== "fullHistory" && plan.schedules[arm].includes(step)) {
        const result = await invoke("summary", arm, (signal) =>
          generateSummaryWithUsage(
            pending,
            model,
            16384,
            key,
            undefined,
            signal,
            undefined,
            previousSummary,
            "off",
            stream,
          ),
        );
        previousSummary = result.text;
        pending = [];
      }
      if (plan.checkpoints.includes(step)) {
        const context = {
          messages: [
            {
              role: "system",
              content: "Answer using only the task log and summary. Return JSON only.",
              timestamp: 0,
            },
            ...(previousSummary
              ? [{ role: "user", content: `Prior task summary:\n${previousSummary}`, timestamp: 0 }]
              : []),
            ...pending,
            { role: "user", content: QUALITY_QUESTION, timestamp: step + 100 },
          ],
        };
        const answer = await invoke("check", arm, async (signal) => {
          const response = await (
            await stream(model, context, { signal, maxTokens: 512, reasoning: undefined })
          ).result();
          if (response.stopReason !== "stop") throw new Error("Incomplete answer");
          return {
            text: response.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join(""),
            usage: response.usage,
          };
        });
        report.checkpoints.push({
          arm,
          step,
          measured: live,
          grade: live ? gradeQuality(answer.text, step) : null,
        });
      }
    }
  }
} catch {
  report.hardFailure =
    usageLedger.at(-1)?.stopReason === "length" ? "output-token-cap" : "request-or-budget-failure";
  report.evidenceRetentionMeasured = false;
  process.exitCode = 1;
} finally {
  report.completedPlannedRun = report.hardFailure === null && calls.length === plannedCalls;
  report.comparableThreeArmRun =
    live &&
    report.completedPlannedRun &&
    runArms.length === 3 &&
    report.checkpoints.filter((c) => c.arm === "fullHistory").every((c) => c.grade?.exact === true);
  report.usage = {
    logicalCalls,
    httpCalls,
    promptByteUnits,
    httpRequestByteUnits,
    maxHttpCalls,
    maxPromptByteUnits,
    unaccountedHttpAttempts: Math.max(
      0,
      httpCalls - usageLedger.filter((call) => call.usageKnown).length,
    ),
    reportedTokens: usageLedger
      .filter((call) => call.usageKnown)
      .reduce(
        (sum, call) =>
          sum + call.usage.input + call.usage.cacheRead + call.usage.cacheWrite + call.usage.output,
        0,
      ),
  };
  if (out) writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        mode: report.mode,
        plan: report.plan,
        runArms,
        plannedCalls,
        checkpoints: report.checkpoints,
        requestAudit,
        usage: report.usage,
        budgetEstimate: report.budgetEstimate,
        hardFailure: report.hardFailure,
        completedPlannedRun: report.completedPlannedRun,
        comparableThreeArmRun: report.comparableThreeArmRun,
      },
      null,
      2,
    ),
  );
}
