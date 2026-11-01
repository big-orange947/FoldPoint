// Local Pi SDK lifecycle probe: deterministic loopback responses; never accesses a provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPiSettlementObserver } from "../adapters/pi/settlement-observer.ts";

const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== "--pi" ||
  !args[1] ||
  args[2] !== "--out" ||
  !args[3] ||
  existsSync(args[3])
)
  throw new Error("fresh --out and --pi required");
const root = resolve(args[1]),
  out = resolve(args[3]);
let scenario = "",
  calls = 0,
  externalAttempts = 0,
  releaseAbort;
const abortReceived = new Promise((resolvePromise) => {
  releaseAbort = resolvePromise;
});
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    for await (const _chunk of req) {
      /* Never persist request body. */
    }
    calls++;
    if (scenario === "abort") {
      releaseAbort();
      return;
    }
    if (scenario === "error" || (scenario === "retry" && calls === 1)) {
      res.writeHead(scenario === "retry" ? 503 : 400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              scenario === "retry" ? "service temporarily unavailable" : "invalid synthetic input",
            type: "server_error",
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (choices, usage) => ({
      id: "local",
      object: "chat.completion.chunk",
      created: 0,
      model: "probe",
      choices,
      ...(usage ? { usage } : {}),
    });
    for (const item of [
      chunk([{ index: 0, delta: { role: "assistant", content: "ACK" }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
      chunk([], {
        prompt_tokens: 1000,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    ])
      res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`,
  originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== origin) {
    externalAttempts++;
    throw new Error("external network forbidden");
  }
  return originalFetch(input, { ...init, redirect: "error" });
};
const deny = () => {
  externalAttempts++;
  throw new Error("external network forbidden");
};
http.request = deny;
https.request = deny;
syncBuiltinESMExports();
const report = {
  runner: "foldpoint.pi-settlement-probe.v1",
  paidCalls: 0,
  externalAttempts: 0,
  cases: [],
};
try {
  const load = (p) => import(pathToFileURL(join(root, p)).href);
  const [
    { createAgentSession },
    { AuthStorage },
    { SessionManager },
    { SettingsManager },
    helpers,
    utilities,
  ] = await Promise.all([
    load("packages/coding-agent/src/core/sdk.ts"),
    load("packages/coding-agent/src/core/auth-storage.ts"),
    load("packages/coding-agent/src/core/session-manager.ts"),
    load("packages/coding-agent/src/core/settings-manager.ts"),
    load("packages/coding-agent/test/model-runtime-test-utils.ts"),
    load("packages/coding-agent/test/utilities.ts"),
  ]);
  mkdirSync(out, { recursive: true });
  report.piCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  report.serializerSha256 = createHash("sha256")
    .update(readFileSync(join(root, "packages/ai/dist/api/openai-completions.js")))
    .digest("hex");
  const modelsPath = join(out, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        localtest: {
          baseUrl: `${origin}/v1`,
          api: "openai-completions",
          apiKey: "synthetic-local-only",
          compat: { maxTokensField: "max_tokens" },
          models: [
            {
              id: "probe",
              contextWindow: 100000,
              maxTokens: 2048,
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            },
          ],
        },
      },
    }),
  );
  const auth = AuthStorage.inMemory();
  await auth.modify("localtest", async () => ({ type: "api_key", key: "synthetic-local-only" }));
  const registry = await helpers.createModelRegistry(auth, modelsPath),
    model = registry.find("localtest", "probe");
  assert(model);
  for (const name of ["success", "error", "retry", "abort"]) {
    scenario = name;
    calls = 0;
    const dir = join(out, name);
    mkdirSync(dir);
    const events = [],
      activities = [];
    const observer = createPiSettlementObserver((record) => {
      activities.push(record);
    });
    const extensionsResult = await utilities.createTestExtensionsResult(
      [
        (pi) => {
          for (const type of ["agent_start", "agent_end", "agent_before_settle", "agent_settled"])
            pi.on(type, (event) => {
              observer.observe(event);
              events.push({
                type,
                ...(type === "agent_before_settle"
                  ? {
                      outcome: ["completed", "aborted", "error"].includes(event.outcome)
                        ? event.outcome
                        : "unknown",
                    }
                  : {}),
              });
            });
          pi.on("message_end", (event) => {
            observer.observe(event);
          });
        },
      ],
      dir,
    );
    const settings = SettingsManager.create(dir, dir);
    settings.applyOverrides({
      compaction: { enabled: false },
      retry: { enabled: name === "retry", maxRetries: name === "retry" ? 1 : 0, baseDelayMs: 1 },
      cacheWarming: "off",
    });
    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      noTools: "all",
      cwd: dir,
      agentDir: dir,
      sessionManager: SessionManager.inMemory(),
      settingsManager: settings,
      modelRuntime: helpers.getModelRuntime(registry),
      resourceLoader: utilities.createTestResourceLoader({ extensionsResult }),
    });
    try {
      session.subscribe((event) => {
        if (["auto_retry_start", "auto_retry_end"].includes(event.type))
          events.push({
            type: event.type,
            ...(event.type === "auto_retry_end" ? { success: event.success } : {}),
          });
      });
      await session.bindExtensions({});
      const run = session.prompt("Synthetic task. Reply ACK.");
      if (name === "abort") {
        await abortReceived;
        await session.abort();
      }
      await run.catch(() => {});
      await session.waitForIdle();
      report.cases.push({ scenario: name, calls, events, activities });
    } finally {
      session.dispose();
    }
  }
  assert.equal(externalAttempts, 0);
  report.externalAttempts = externalAttempts;
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch {
  process.stderr.write("Settlement probe failed; no source files modified\n");
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
