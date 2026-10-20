// Real local Pi AgentSession, metadata-only report. Network requires explicit --live.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFoldPointObserver } from "../adapters/pi/foldpoint-observe.ts";
import {
  DEFAULTS,
  ExperimentalCompactorLearner,
  parseTraceJsonl,
  profileKey,
  resolveUnitPrices,
} from "../src/index.ts";
import { ApproximateRetentionTracker } from "./approximate-feedback.ts";
import { admitMeasuredFeedback } from "./compactor-feedback-probe.ts";
import { repeatedMessages } from "./repeated-summary-corpus.ts";
import { SummaryInputCostLearner } from "./summary-input-cost.ts";
import { SummaryOutputLearner } from "./summary-output.ts";
import { analyzeTraceEvents } from "./trace-analyze.ts";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback.ts";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (
    [
      "--live",
      "--fake-summary-cap",
      "--fake-summary-error",
      "--steady-shadow",
      "--steady-model-probe",
      "--fake-prefix-rewrite",
      "--fake-system-rewrite",
    ].includes(args[i])
  )
    continue;
  if (
    ["--pi", "--out", "--approx-error-fraction"].includes(args[i]) &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  ) {
    i++;
    continue;
  }
  throw new Error("Unknown or incomplete argument");
}
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const live = args.includes("--live");
const modelProbe = args.includes("--steady-model-probe");
const systemRewrite = args.includes("--fake-system-rewrite");
const prefixRewrite = args.includes("--fake-prefix-rewrite") || systemRewrite;
const steadyShadow = args.includes("--steady-shadow") || modelProbe;
if (live && steadyShadow) throw new Error("Steady shadow lifecycle probe is offline only");
if (prefixRewrite && !modelProbe) throw new Error("Prefix rewrite requires offline model probe");
const errorAssumptionArg = value("--approx-error-fraction", undefined);
const errorAssumption = errorAssumptionArg === undefined ? undefined : Number(errorAssumptionArg);
if (modelProbe && errorAssumption === undefined)
  throw new Error("Model probe requires an explicit approximate error assumption");
if (
  errorAssumption !== undefined &&
  (!Number.isFinite(errorAssumption) || errorAssumption < 0 || errorAssumption >= 1)
)
  throw new Error("Approximate error fraction must be in [0,1)");
const fakeCap = args.includes("--fake-summary-cap");
const fakeError = args.includes("--fake-summary-error");
if ((live && (fakeCap || fakeError)) || (fakeCap && fakeError))
  throw new Error("Invalid failure injection");
const piRoot = resolve(value("--pi", "D:/pi"));
const outArg = value("--out", undefined);
if (!outArg) throw new Error("A fresh --out directory is required");
const out = resolve(outArg);
if (existsSync(out)) throw new Error("Refusing to overwrite an existing capture");
const key = live ? process.env.DEEPSEEK_API_KEY : undefined;
if (live && !key) throw new Error("DEEPSEEK_API_KEY is missing; nothing sent");
const maxCalls = modelProbe ? 7 : 4;
const expectedStages = [
  "pre-compaction",
  "summary",
  "first-post",
  "second-post",
  ...(modelProbe ? ["third-post", "fourth-post", "fifth-post"] : []),
];
const maxInputBytes = 200_000;
const summaryCap = 2048;
let networkAttempts = 0;
let inputBytes = 0;
let httpCalls = 0;
let stage = "pre-compaction";
const originalFetch = globalThis.fetch;
const deny = () => {
  networkAttempts++;
  throw new Error("Network forbidden");
};
if (!live) {
  globalThis.fetch = deny;
  http.request = deny;
  https.request = deny;
  syncBuiltinESMExports();
} else {
  // Cover SDK retries too. Whitelist an exact origin, not a string prefix.
  globalThis.fetch = async (...input) => {
    const target = new URL(input[0] instanceof Request ? input[0].url : String(input[0]));
    if (target.origin !== "https://api.deepseek.com") throw new Error("Unexpected endpoint");
    const body =
      input[1]?.body ?? (input[0] instanceof Request ? await input[0].clone().text() : undefined);
    if (typeof body !== "string") throw new Error("Unaccountable request body");
    if (httpCalls >= maxCalls || inputBytes + Buffer.byteLength(body) > maxInputBytes)
      throw new Error("Capture budget exhausted");
    httpCalls++;
    inputBytes += Buffer.byteLength(body);
    return originalFetch(...input);
  };
}
const load = (path) => import(pathToFileURL(join(piRoot, path)).href);
const [
  ai,
  compat,
  { createAgentSession },
  { AuthStorage },
  { SessionManager },
  { SettingsManager },
  helpers,
  utilities,
  { emitSessionShutdownEvent },
  { convertToLlm },
] = await Promise.all([
  load("packages/ai/dist/index.js"),
  load("packages/ai/dist/compat.js"),
  load("packages/coding-agent/src/core/sdk.ts"),
  load("packages/coding-agent/src/core/auth-storage.ts"),
  load("packages/coding-agent/src/core/session-manager.ts"),
  load("packages/coding-agent/src/core/settings-manager.ts"),
  load("packages/coding-agent/test/model-runtime-test-utils.ts"),
  load("packages/coding-agent/test/utilities.ts"),
  load("packages/coding-agent/src/core/extensions/runner.ts"),
  load("packages/coding-agent/src/core/messages.ts"),
]);
const base = compat.getModel("deepseek", "deepseek-flash");
if (!base) throw new Error("Local model config is missing");
const model = { ...base, maxTokens: summaryCap };
const ledger = [];
const afterModel = new UncertainAffineFeedback("pi-controlled-host/v1");
const outputModel = new SummaryOutputLearner("pi-controlled-output/v1");
// This controlled fixture fixes Pi/compactor settings and cache regime for its lifetime.
const inputCostBinding = JSON.stringify({
  model,
  summaryCap,
  keepRecentTokens: 512,
  cache: "fixture-no-summary-cache",
});
const inputCostModel = new SummaryInputCostLearner(inputCostBinding);
let learnedProfileKey;
let currentProfileKey;
let earlyRequest;
let previousRequest;
const prefixChecks = [];
// This controlled fixture has no tools, images or custom request transforms. These hashes
// are in-memory only, NOT a general provider serializer or a stock-Pi cache proof.
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textBlocks = (content) =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;
const conversation = (messages) =>
  messages
    .filter((m) => m.role !== "system")
    .map((m) => hash({ role: m.role, content: textBlocks(m.content) }));
const extendsHashes = (before, after) =>
  before.length <= after.length && before.every((v, i) => v === after[i]);
const streamFn = (requestedModel, context, options) => {
  if (ledger.length >= maxCalls) throw new Error("Logical budget exhausted");
  const currentStage = stage;
  const row = {
    stage: currentStage,
    outputCap: currentStage === "summary" ? summaryCap : 128,
    usage: null,
    stopReason: null,
  };
  ledger.push(row);
  if (modelProbe && currentStage !== "summary") {
    const actual = {
      conversation: conversation(context.messages),
      system: hash(
        compat
          .normalizeContext(context)
          .messages.filter((m) => m.role === "system")
          .map((m) => ({
            content: m.content,
            sections: m.sections,
            toolsAdded: m.toolsAdded,
            toolsRemoved: m.toolsRemoved,
          })),
      ),
    };
    const prefixClaimed = earlyRequest?.prefixTokens !== undefined;
    const systemMatches =
      !prefixClaimed || (previousRequest !== undefined && previousRequest.system === actual.system);
    const projectionMatches =
      earlyRequest !== undefined &&
      hash(actual.conversation) === hash(earlyRequest.conversation) &&
      systemMatches;
    prefixChecks.push({
      stage: currentStage,
      projectionMatches,
      conversationMatches:
        earlyRequest !== undefined && hash(actual.conversation) === hash(earlyRequest.conversation),
      systemMatches,
      systemComparedToPrevious: prefixClaimed,
      earlyMessageCount: earlyRequest?.conversation.length ?? null,
      finalMessageCount: actual.conversation.length,
      declaredPrefixTokens: earlyRequest?.prefixTokens ?? null,
    });
    if (!projectionMatches) throw new Error("controlled-prefix-contract-failed");
    previousRequest = {
      ...actual,
      hostSystem: earlyRequest.system,
      contextTokens: earlyRequest.contextTokens,
    };
  }
  const callOptions = {
    ...options,
    apiKey: key,
    maxTokens: row.outputCap,
    reasoning: undefined,
    temperature: 0,
    maxRetries: 0,
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  };
  let events;
  if (live) {
    events = compat.streamSimple(requestedModel, context, callOptions);
  } else {
    events = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      const summary = currentStage === "summary";
      const fixturePrompt =
        currentStage === "pre-compaction"
          ? 8000
          : summary
            ? 7500
            : currentStage === "first-post"
              ? 1500
              : 2000;
      const prompt = summary && fakeError ? 0 : fixturePrompt;
      const output = summary && fakeError ? 0 : summary ? 300 : 20;
      const stopReason = summary && fakeError ? "error" : summary && fakeCap ? "length" : "stop";
      events.push({
        type: "done",
        reason: stopReason,
        message: {
          ...ai.fauxAssistantMessage(
            summary
              ? "## Goal\nKeep owner constraints; approval pending.\n## Next Steps\nWait for verification."
              : "ACK",
          ),
          api: requestedModel.api,
          provider: requestedModel.provider,
          model: requestedModel.id,
          stopReason,
          usage: {
            input: prompt,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: prompt + output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
    });
  }
  const originalResult = events.result.bind(events);
  events.result = async () => {
    const result = await originalResult();
    const u = result.usage;
    if (
      u &&
      [u.input, u.output, u.cacheRead, u.cacheWrite].every(
        (x) => Number.isSafeInteger(x) && x >= 0,
      ) &&
      (result.stopReason !== "error" || u.input + u.output + u.cacheRead + u.cacheWrite > 0)
    ) {
      // Whitelist numeric usage only. Never store content, raw responses, headers or errors.
      row.usage = {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
      };
    }
    row.stopReason = ["stop", "length", "error", "aborted", "toolUse"].includes(result.stopReason)
      ? result.stopReason
      : "unknown";
    return result;
  };
  return events;
};
mkdirSync(out, { recursive: true });
const settingsDir = join(out, "isolated-settings");
mkdirSync(settingsDir);
const settings = SettingsManager.create(settingsDir, settingsDir);
settings.applyOverrides({
  compaction: { enabled: false, keepRecentTokens: 512, reserveTokens: 4096 },
  retry: { enabled: false, maxRetries: 0 },
  cacheWarming: "off",
});
const auth = AuthStorage.inMemory();
await auth.modify(model.provider, async () => ({
  type: "api_key",
  key: live ? key : "fake-in-memory-only",
}));
const registry = await helpers.createInMemoryModelRegistry(auth);
const manager = SessionManager.inMemory();
const runtime = helpers.getModelRuntime(registry);
// Keep SDK context/extension/request wiring intact; replace only the provider transport.
runtime.streamSimple = streamFn;
const observer = createFoldPointObserver({
  tracePath: join(out, "trace.jsonl"),
  prefixStorePath: join(out, "prefix.json"),
  mode: "observe",
  compaction: "off",
  log: () => {},
  ...(modelProbe ? { getReusablePrefixTokens: () => earlyRequest?.prefixTokens } : {}),
  ...(steadyShadow
    ? {
        experimentalSteadyShadow: {
          path: join(out, "steady-shadow.jsonl"),
          ...(modelProbe
            ? {
                getMetadata: (input, lifecycle) => {
                  currentProfileKey = profileKey(input.profile);
                  if (!learnedProfileKey || learnedProfileKey !== currentProfileKey)
                    return undefined;
                  const prediction = afterModel.predict(input.contextTokens),
                    state = afterModel.snapshot(),
                    outModel = outputModel.snapshot(),
                    inputRate =
                      inputCostModel.snapshot(inputCostBinding).effectiveInputCostPerBeforeToken;
                  if (!prediction || outModel.samples === 0 || inputRate === null) return undefined;
                  return {
                    profileKey: currentProfileKey,
                    compactorTokenModel: {
                      after: {
                        slope: state.model?.slope ?? prediction.pointTokens / input.contextTokens,
                        intercept: state.model?.floor ?? 0,
                        residual: 0,
                      },
                      output: { slope: outModel.slope, intercept: outModel.intercept, residual: 0 },
                      samples: state.acceptedApproximate,
                      minBefore: state.model?.minBefore ?? input.contextTokens,
                      maxBefore: state.model?.maxBefore ?? input.contextTokens,
                      summaryInputCostPerToken: inputRate,
                    },
                    durationModel: {
                      completedCalls: lifecycle.completedOrdinaryCalls,
                      components: [
                        { weight: 0.8, continuationProbability: 0.8 },
                        { weight: 0.2, continuationProbability: 0.98 },
                      ],
                    },
                    executionConstraints: {
                      hasAttempt: lifecycle.summaryAttempts > 0,
                      minCallsBetweenCompactions: DEFAULTS.minCallsBetweenCompactions,
                      minReclaimTokens: DEFAULTS.minReclaimTokens,
                      minReclaimRatio: DEFAULTS.minReclaimRatio,
                      softWindowTokens:
                        DEFAULTS.softWindowRatio * input.profile.contextWindowTokens,
                    },
                    cycleBilling: {}, // Effective aggregate input rate already includes observed cache pricing.
                  };
                },
              }
            : {}),
        },
      }
    : {}),
});
const boundaries = [];
const extensionResult = await utilities.createTestExtensionsResult(
  [
    (pi) => {
      pi.on("context", (event, ctx) => {
        if (modelProbe) {
          const current = conversation(convertToLlm(event.messages));
          const system = hash([textBlocks(ctx.getSystemPrompt())]);
          const tokens = ctx.getContextUsage()?.tokens ?? null;
          const reusable =
            previousRequest &&
            previousRequest.contextTokens !== null &&
            previousRequest.hostSystem === system &&
            extendsHashes(previousRequest.conversation, current);
          earlyRequest = {
            conversation: current,
            system,
            contextTokens: tokens,
            prefixTokens:
              reusable && tokens !== null
                ? Math.min(previousRequest.contextTokens, tokens)
                : undefined,
          };
        }
        boundaries.push({
          event: "context",
          stage,
          contextTokens: ctx.getContextUsage()?.tokens ?? null,
        });
      });
      observer(pi);
      if (prefixRewrite)
        pi.on("context_with_system", (event) => {
          if (stage === "third-post") {
            const message = event.messages.find(
              (m) => m.role === (systemRewrite ? "system" : "user"),
            );
            message.content = [
              { type: "text", text: "Synthetic late rewrite must invalidate the report." },
            ];
          }
        });
    },
  ],
  out,
);
const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  noTools: "all",
  agentDir: settingsDir,
  sessionManager: manager,
  settingsManager: settings,
  cwd: out,
  modelRuntime: runtime,
  resourceLoader: utilities.createTestResourceLoader({ extensionsResult: extensionResult }),
});
session.subscribe(() => {});
const report = {
  runner: "foldpoint.pi-feedback-capture.v1",
  mode: live ? "live" : "offline-fake-provider",
  piCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: piRoot, encoding: "utf8" }).trim(),
  sourceSha256: createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex"),
  model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow },
  budget: { maxCalls, maxInputBytes, summaryOutputCap: summaryCap, ordinaryOutputCap: 128 },
  boundaries,
  ledger,
  compaction: null,
  analysis: null,
  shadow: null,
  checks: null,
  completed: false,
  failure: null,
  limitations: [
    "Manual small-context native Pi SDK capture, not adaptive timing, 1M quality or policy cost comparison.",
    "Provider input includes system/retained messages/new input; host estimates are not measured retention.",
    "One compaction does not identify an affine fit; no fixture-derived compactor coefficients are injected.",
    "No task-quality score is awarded, including in live mode. SDK cache warming disabled through isolated settings.",
  ],
};
try {
  // Public history, not a private workspace or real agent account. No old usage is invented.
  for (let n = 0; n < 8; n++) {
    for (const message of repeatedMessages(n)) manager.appendMessage(message);
    manager.appendMessage({
      ...ai.fauxAssistantMessage("Acknowledged public diagnostic log."),
      api: model.api,
      provider: model.provider,
      model: model.id,
    });
  }
  session.agent.state.messages = manager.buildSessionContext().messages;
  await session.bindExtensions({});
  await session.prompt("Acknowledge the diagnostic log. Reply only ACK.");
  if (ledger.at(-1)?.stage !== stage || ledger.at(-1)?.stopReason !== "stop")
    throw new Error("pre-request-not-complete");
  stage = "summary";
  const result = await session.compact();
  if (modelProbe) {
    previousRequest = undefined; // A summary replaces the conversation, never reuses its old proof.
    const before = result.tokensBefore,
      after = result.estimatedTokensAfter;
    const summaryRows = ledger.filter((row) => row.stage === "summary");
    assert(
      summaryRows.length > 0 && summaryRows.every((row) => row.usage && row.stopReason === "stop"),
    );
    const aggregate = summaryRows.reduce(
      (total, row) => ({
        promptTokens:
          total.promptTokens + row.usage.input + row.usage.cacheRead + row.usage.cacheWrite,
        cachedInputTokens: total.cachedInputTokens + row.usage.cacheRead,
        cacheWriteTokens: total.cacheWriteTokens + row.usage.cacheWrite,
        outputTokens: total.outputTokens + row.usage.output,
      }),
      { promptTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    );
    const output = aggregate.outputTokens;
    assert(
      inputCostModel.observe({
        binding: inputCostBinding,
        sequence: 1,
        success: true,
        beforeTokens: before,
        usage: aggregate,
        prices: resolveUnitPrices({
          currency: "USD",
          inputPerMillion: model.cost.input,
          outputPerMillion: model.cost.output,
          ...(model.cost.cacheRead > 0 ? { cacheReadPerMillion: model.cost.cacheRead } : {}),
          ...(model.cost.cacheWrite > 0 ? { cacheWritePerMillion: model.cost.cacheWrite } : {}),
        }),
      }),
    );
    assert(Number.isSafeInteger(after) && Number.isSafeInteger(output));
    const beforeError = Math.ceil(errorAssumption * before);
    assert.equal(
      afterModel.observe({
        basisKey: "pi-controlled-host/v1",
        sequence: 1,
        source: "host-immediate",
        success: true,
        beforeTokens: before,
        afterTokens: after,
        beforeErrorTokens: beforeError,
        afterErrorTokens: Math.ceil(errorAssumption * after),
      }),
      "accepted-approximate",
    );
    assert.equal(
      outputModel.observe({
        sequence: 1,
        beforeTokens: before,
        beforeErrorTokens: beforeError,
        outputTokens: output,
        success: true,
      }),
      "accepted-approximate",
    );
    learnedProfileKey = currentProfileKey;
  }
  report.compaction = {
    beforeTokens: result.tokensBefore,
    immediateAfterEstimate: result.estimatedTokensAfter,
    estimateSource: "pi-estimateMessagesTokens",
    postCompactionContextTokens: session.getContextUsage()?.tokens ?? null,
  };
  stage = "first-post";
  await session.prompt("Acknowledge continuation after compaction. Reply only ACK.");
  if (ledger.at(-1)?.stage !== stage || ledger.at(-1)?.stopReason !== "stop")
    throw new Error("first-post-not-complete");
  stage = "second-post";
  await session.prompt("Acknowledge the next small update. Reply only ACK.");
  if (ledger.at(-1)?.stage !== stage || ledger.at(-1)?.stopReason !== "stop")
    throw new Error("second-post-not-complete");
  if (modelProbe)
    for (const extraStage of ["third-post", "fourth-post", "fifth-post"]) {
      stage = extraStage;
      await session.prompt("Acknowledge another synthetic update. Reply only ACK.");
      if (ledger.at(-1)?.stage !== stage || ledger.at(-1)?.stopReason !== "stop")
        throw new Error("extra-post-not-complete");
    }
  await emitSessionShutdownEvent(session.extensionRunner, {
    type: "session_shutdown",
    reason: "exit",
  });
  const parsed = parseTraceJsonl(readFileSync(join(out, "trace.jsonl"), "utf8"));
  assert.equal(parsed.errors.length, 0);
  const compactions = parsed.events.filter((e) => e.type === "compaction" && e.success);
  const captured = compactions[0];
  report.analysis = analyzeTraceEvents(parsed.events);
  if (steadyShadow) {
    const rows = readFileSync(join(out, "steady-shadow.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const predictions = rows.filter((r) => r.type === "prediction");
    const end = rows.find((r) => r.type === "session_end");
    report.steadyLifecycle = {
      predictions: predictions.length,
      blockedPredictions: predictions.filter((r) => r.status === "blocked").length,
      safetyPredictions: predictions.filter((r) => r.status === "safety").length,
      evaluatedPredictions: predictions.filter((r) => r.status === "evaluated").length,
      selectedCyclePredictions: predictions.filter(
        (r) => r.selected !== null && r.selected !== undefined,
      ).length,
      economicApprovals: predictions.filter(
        (r) => r.status === "evaluated" && r.action === "COMPACT",
      ).length,
      applied: rows.some((r) => r.applied !== false),
      final: end?.lifecycle ?? null,
      runtimeAgesAtDecisions: predictions.map((r) => r.lifecycle.completedOrdinaryCalls),
      limitations: modelProbe
        ? "Controlled normalized-context projection and one approximate host-immediate sample; not a provider serialization/cache or timing-control test."
        : "No compatible compactor model or verified final-request prefix injected; no economic approval expected.",
    };
    assert.equal(predictions.length, parsed.events.filter((e) => e.type === "decision").length);
    assert.equal(report.steadyLifecycle.applied, false);
    assert.equal(end?.lifecycle.ordinaryRequests, maxCalls - 1);
    assert.equal(end?.lifecycle.successfulOrdinaryRequests, maxCalls - 1);
    assert.equal(end?.lifecycle.successfulSummaries, 1);
    assert.equal(end?.lifecycle.cacheWarmCalls, 0);
    assert.equal(end?.lifecycle.exactRetentionSamples, 0);
    assert.equal(end?.lifecycle.completedOrdinaryCalls, 1);
    if (modelProbe) {
      assert(report.steadyLifecycle.evaluatedPredictions > 0);
      assert(report.steadyLifecycle.selectedCyclePredictions > 0);
      assert(prefixChecks.every((r) => r.projectionMatches));
    }
  }
  // No safe same-basis after-size is available: abstain, don't train on host estimates.
  const learner = new ExperimentalCompactorLearner();
  const admissions = compactions.map((event) => admitMeasuredFeedback(learner, event));
  report.shadow = {
    eligibleFeedback: admissions.filter((status) => status === "accepted").length,
    admissions,
    availability: learner.snapshotWithFallback(),
    economicForecastProduced: false,
    policyChanged: false,
  };
  // Opt-in metadata research only. No approximate samples enter the exact model or core.
  if (errorAssumption !== undefined) {
    const basisKey = `pi-host-estimate/${createHash("sha256")
      .update(
        JSON.stringify({
          provider: model.provider,
          model: model.id,
          piCommit: report.piCommit,
          summaryCap,
          keepRecentTokens: 512,
          estimator: "pi-native-boundary-v1",
        }),
      )
      .digest("hex")}`;
    const approximate = new ApproximateRetentionTracker(basisKey);
    const before = report.compaction.beforeTokens;
    const errorBefore = Math.ceil(errorAssumption * before);
    report.approximateShadow =
      errorBefore >= before
        ? { reason: "unbounded-before", canDrivePolicy: false }
        : {
            assumedErrorFraction: errorAssumption,
            admission: approximate.observe({
              basisKey,
              sequence: 1,
              success: true,
              source: "host-immediate",
              beforeTokens: before,
              afterTokens: report.compaction.immediateAfterEstimate,
              beforeErrorTokens: errorBefore,
              afterErrorTokens: Math.ceil(
                errorAssumption * report.compaction.immediateAfterEstimate,
              ),
            }),
            state: approximate.snapshot(),
            sameSizePrediction: approximate.predict(before),
            calibratedErrorBudget: false,
          };
  }
  report.checks = {
    [modelProbe ? "sevenCompletedCalls" : "fourCompletedCalls"]:
      ledger.length === maxCalls &&
      ledger.every((r) => r.usage !== null && r.stopReason === "stop") &&
      ledger.map((r) => r.stage).join(",") === expectedStages.join(","),
    oneNativeCompaction: compactions.length === 1,
    immediatelyUnknownContext: report.compaction.postCompactionContextTokens === null,
    hostEstimateLabelled: captured?.afterTokensSource === "host-estimate",
    firstProviderPromptPreserved:
      captured?.firstPostCompactionRequest?.promptTokens ===
      (ledger[2]?.usage?.input ?? 0) +
        (ledger[2]?.usage?.cacheRead ?? 0) +
        (ledger[2]?.usage?.cacheWrite ?? 0),
    noEstimatedRetentionCalibration: report.analysis.overall.retention.count === 0,
    completeSession: report.analysis.completeSessions === 1,
    correctCallAccounting:
      report.analysis.sessionCosts[0]?.calls === maxCalls - 1 &&
      report.analysis.sessionCosts[0]?.compactions === 1 &&
      report.analysis.sessionCosts[0]?.unpricedCompactions === 0,
    noHiddenHttp: live ? httpCalls === ledger.length : httpCalls === 0 && networkAttempts === 0,
  };
  assert.ok(Object.values(report.checks).every(Boolean), "capture-invariant-failed");
  report.completed = true;
} catch {
  // Raw errors may contain request bodies or credentials. Persist only a bounded stage code.
  report.failure = `incomplete-${stage}`;
  process.exitCode = 1;
} finally {
  session.dispose();
  if (modelProbe)
    report.modelProbe = {
      assumedErrorFraction: errorAssumption,
      feedbackSource: "pi-host-immediate-estimatedTokensAfter",
      binding: {
        piCommit: report.piCommit,
        provider: model.provider,
        model: model.id,
        summaryOutputCap: summaryCap,
        keepRecentTokens: 512,
        tools: "none",
      },
      prefixChecks,
      retention: afterModel.snapshot(),
      output: outputModel.snapshot(),
      inputCost: inputCostModel.snapshot(inputCostBinding),
      providerSerializationExercised: false,
      calibratedErrorBudget: false,
      policyChanged: false,
      timingControlExercised: false,
      usableForProviderCalibration: false,
    };
  report.usage = {
    httpCalls,
    networkAttempts,
    httpRequestBytes: inputBytes,
    logicalCalls: ledger.length,
    reportedTokens: ledger.reduce(
      (sum, row) => sum + (row.usage ? Object.values(row.usage).reduce((a, b) => a + b, 0) : 0),
      0,
    ),
    unaccountedHttpAttempts: live ? httpCalls - ledger.filter((r) => r.usage !== null).length : 0,
  };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      completed: report.completed,
      mode: report.mode,
      failure: report.failure,
      usage: report.usage,
      checks: report.checks,
    }),
  );
}
