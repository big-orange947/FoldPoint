// Run with: npx tsx tools/pi-runtime-smoke.mjs D:/pi
// Uses the real local Pi event loop, an in-memory stream, and isolated fake credentials.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFoldPointObserver } from "../adapters/pi/foldpoint-observe.ts";
import { resolveTrialCondition } from "./pi-paired-run.ts";

const piRoot = resolve(process.argv[2] ?? "D:/pi");
const arm = process.argv[3];
const condition = arm === undefined ? undefined : resolveTrialCondition(arm, 64000);
for (const name of Object.keys(process.env)) {
  if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD/.test(name)) delete process.env[name];
}
let networkAttempts = 0;
const denyNetwork = () => {
  networkAttempts += 1;
  throw new Error("Network forbidden in Pi runtime smoke");
};
globalThis.fetch = denyNetwork;
http.request = denyNetwork;
https.request = denyNetwork;
syncBuiltinESMExports();
const load = (path) => import(pathToFileURL(join(piRoot, path)).href);
const [
  { Agent },
  ai,
  compat,
  { AgentSession },
  { AuthStorage },
  { SessionManager },
  { SettingsManager },
  helpers,
  utilities,
] = await Promise.all([
  load("packages/agent/dist/index.js"),
  load("packages/ai/dist/index.js"),
  load("packages/ai/dist/compat.js"),
  load("packages/coding-agent/src/core/agent-session.ts"),
  load("packages/coding-agent/src/core/auth-storage.ts"),
  load("packages/coding-agent/src/core/session-manager.ts"),
  load("packages/coding-agent/src/core/settings-manager.ts"),
  load("packages/coding-agent/test/model-runtime-test-utils.ts"),
  load("packages/coding-agent/test/utilities.ts"),
]);
const temp = mkdtempSync(join(tmpdir(), "foldpoint-real-pi-"));
const order = [];
const baseModel = compat.getModel("anthropic", "claude-sonnet-4-5");
assert.ok(baseModel);
const model =
  arm === undefined ? baseModel : { ...baseModel, contextWindow: 64000, maxTokens: 8192 };
const streamFn = (requestedModel) => {
  order.push("stream");
  const stream = ai.createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        ...ai.fauxAssistantMessage("Synthetic summary or response; no paid provider."),
        api: requestedModel.api,
        provider: requestedModel.provider,
        model: requestedModel.id,
        usage: {
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
  });
  return stream;
};
const agent = new Agent({
  streamFn,
  initialState: { model, systemPrompt: "Synthetic timing test", tools: [] },
});
const manager = SessionManager.inMemory();
const settings = SettingsManager.create(temp, temp);
settings.applyOverrides({
  compaction: {
    enabled: arm !== undefined,
    keepRecentTokens: 1,
    reserveTokens: condition?.reserveTokens ?? 16384,
  },
});
const auth = AuthStorage.inMemory();
await auth.modify(model.provider, async () => ({ type: "api_key", key: "fake-in-memory-only" }));
const registry = await helpers.createInMemoryModelRegistry(auth);
const factory = createFoldPointObserver({
  tracePath: join(temp, "trace.jsonl"),
  prefixStorePath: join(temp, "prefix.json"),
  compaction: condition?.compaction ?? "auto",
  mode: condition?.mode ?? "observe",
  log: () => {},
});
const extensions = await utilities.createTestExtensionsResult(
  [
    (pi) => {
      pi.on("before_agent_start", (_event, ctx) => {
        order.push(`preflight-idle:${ctx.isIdle()}`);
      });
      pi.on("session_before_compact", () => {
        order.push("compact-start");
      });
      pi.on("session_compact", () => {
        order.push("compact-end");
      });
      pi.on("agent_start", () => {
        order.push("agent-start");
      });
      pi.on("agent_end", () => {
        order.push("agent-end");
      });
      factory(pi);
    },
  ],
  temp,
);
const session = new AgentSession({
  agent,
  sessionManager: manager,
  settingsManager: settings,
  cwd: temp,
  modelRuntime: helpers.getModelRuntime(registry),
  resourceLoader: utilities.createTestResourceLoader({ extensionsResult: extensions }),
});
session.subscribe(() => {});
try {
  const tokens = arm === undefined ? Math.ceil(model.contextWindow * 0.75) : 40000;
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Synthetic previous user message" }],
    timestamp: Date.now() - 1000,
  });
  manager.appendMessage({
    ...ai.fauxAssistantMessage("Synthetic previous response"),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  agent.state.messages = manager.buildSessionContext().messages;
  await session.bindExtensions({});
  await session.prompt("Synthetic new task");
  await session.prompt("Synthetic second task, with a small fresh context");
  assert.ok(order.includes("preflight-idle:true"), JSON.stringify(order));
  const completed = order.filter((event) => event === "compact-end").length;
  assert.equal(completed, arm === undefined || arm === "fixed60" ? 1 : 0, JSON.stringify(order));
  if (completed > 0)
    assert.ok(order.indexOf("compact-end") < order.indexOf("agent-start"), JSON.stringify(order));
  if (arm === "dynamic") {
    const events = readFileSync(join(temp, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((event) => event.type === "compaction" && event.errorCode === "vetoed"),
      "No recorded native threshold veto",
    );
  }
  assert.ok(order.includes("agent-end"), JSON.stringify(order));
  assert.equal(order.filter((event) => event === "agent-end").length, 2, JSON.stringify(order));
  assert.equal(session.isIdle, true);
  assert.equal(networkAttempts, 0);
  console.log(
    JSON.stringify(
      {
        passed: true,
        piRoot,
        arm: arm ?? "preflight",
        order,
        networkAttempts,
        paidCalls: 0,
        artifactDirectory: temp,
      },
      null,
      2,
    ),
  );
} finally {
  session.dispose();
}
