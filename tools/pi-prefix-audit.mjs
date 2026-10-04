// Zero-paid request-transform audit against the real local Pi ExtensionRunner.
// Synthetic messages only; not an actual provider serialization/cache test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = resolve(process.argv[2] ?? "D:/pi");
for (const name of Object.keys(process.env)) {
  if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD/.test(name)) delete process.env[name];
}
let networkAttempts = 0;
const denyNetwork = () => {
  networkAttempts += 1;
  throw new Error("Network forbidden in prefix audit");
};
globalThis.fetch = denyNetwork;
http.request = denyNetwork;
https.request = denyNetwork;
syncBuiltinESMExports();
const load = (path) => import(pathToFileURL(join(piRoot, path)).href);
const [{ ExtensionRunner }, { SessionManager }, { AuthStorage }, helpers, utilities] =
  await Promise.all([
    load("packages/coding-agent/src/core/extensions/runner.ts"),
    load("packages/coding-agent/src/core/session-manager.ts"),
    load("packages/coding-agent/src/core/auth-storage.ts"),
    load("packages/coding-agent/test/model-runtime-test-utils.ts"),
    load("packages/coding-agent/test/utilities.ts"),
  ]);
const temp = mkdtempSync(join(tmpdir(), "foldpoint-prefix-audit-"));
const registry = await helpers.createInMemoryModelRegistry(AuthStorage.inMemory());
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const extendsPrefix = (previous, current) =>
  previous.length <= current.length &&
  previous.every((message, index) => fingerprint(message) === fingerprint(current[index]));
const makeMessages = () => [
  {
    role: "system",
    content: "Synthetic system instructions",
    timestamp: 1,
    toolsAdded: [{ name: "read", description: "Synthetic tool", parameters: { type: "object" } }],
  },
  { role: "user", content: [{ type: "text", text: "Synthetic private fixture" }], timestamp: 2 },
];
const cases = [
  { id: "append-only", expectedEarly: true, expectedFinal: true },
  { id: "late-context-rewrite", expectedEarly: true, expectedFinal: false },
  { id: "system-rewrite", expectedEarly: true, expectedFinal: false },
  { id: "tool-rewrite", expectedEarly: true, expectedFinal: false },
  { id: "payload-rewrite", expectedEarly: true, expectedFinal: false },
  { id: "model-change", expectedEarly: true, expectedFinal: false },
  { id: "truncation", expectedEarly: false, expectedFinal: false },
  { id: "compaction-replacement", expectedEarly: false, expectedFinal: false },
];
const results = [];
for (const scenario of cases) {
  let phase = 0;
  const early = [];
  const errors = [];
  const extensions = await utilities.createTestExtensionsResult(
    [
      (pi) => {
        pi.on("context", (event) => {
          early.push(structuredClone(event.messages));
        });
      },
      (pi) => {
        pi.on("context", (event) => {
          if (phase === 1 && scenario.id === "late-context-rewrite") {
            event.messages[0].content = [{ type: "text", text: "Synthetic rewritten message" }];
          }
        });
        pi.on("context_with_system", (event) => {
          if (phase !== 1) return;
          if (scenario.id === "system-rewrite") event.messages[0].content = "Synthetic new system";
          if (scenario.id === "tool-rewrite")
            event.messages[0].toolsAdded[0].description = "Changed";
        });
        pi.on("before_provider_request", (event) => {
          if (phase === 1 && scenario.id === "payload-rewrite") {
            const payload = structuredClone(event.payload);
            payload.messages[1].content = [{ type: "text", text: "Synthetic payload replacement" }];
            return payload;
          }
        });
      },
    ],
    temp,
  );
  const runner = new ExtensionRunner(
    extensions.extensions,
    extensions.runtime,
    temp,
    SessionManager.inMemory(),
    registry,
  );
  runner.onError((error) => errors.push(error.event));
  const original = makeMessages();
  const first = await runner.emitBeforeProviderRequest({
    model: "synthetic-model-a",
    messages: await runner.emitContext(original),
  });
  phase = 1;
  let next = [
    ...makeMessages(),
    { role: "user", content: [{ type: "text", text: "Synthetic appended task" }], timestamp: 3 },
  ];
  if (scenario.id === "truncation") next = [next[0], next[2]];
  if (scenario.id === "compaction-replacement") {
    next = [next[0], { role: "user", content: "Synthetic compacted summary", timestamp: 3 }];
  }
  const second = await runner.emitBeforeProviderRequest({
    model: scenario.id === "model-change" ? "synthetic-model-b" : "synthetic-model-a",
    messages: await runner.emitContext(next),
  });
  const earlyLooksAppendOnly = extendsPrefix(early[0], early[1]);
  const finalPrefixUnchanged =
    first.model === second.model && extendsPrefix(first.messages, second.messages);
  assert.deepEqual(errors, [], `${scenario.id}: Pi handler failed`);
  assert.equal(earlyLooksAppendOnly, scenario.expectedEarly, scenario.id);
  assert.equal(finalPrefixUnchanged, scenario.expectedFinal, scenario.id);
  results.push({ id: scenario.id, earlyLooksAppendOnly, finalPrefixUnchanged, passed: true });
}
assert.equal(networkAttempts, 0);
console.log(
  JSON.stringify(
    {
      runner: "foldpoint.pi-prefix-audit.v1",
      piCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: piRoot,
        encoding: "utf8",
      }).trim(),
      piTrackedDirty:
        execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
          cwd: piRoot,
          encoding: "utf8",
        }).trim() !== "",
      runnerSourceSha256: createHash("sha256")
        .update(readFileSync(join(piRoot, "packages/coding-agent/src/core/extensions/runner.ts")))
        .digest("hex"),
      passed: true,
      scenarios: results,
      earlyFalsePositives: results.filter(
        (row) => row.earlyLooksAppendOnly && !row.finalPrefixUnchanged,
      ).length,
      networkAttempts,
      paidCalls: 0,
      providerSerializationExercised: false,
      cacheHitsMeasured: false,
      taskQualityMeasured: false,
    },
    null,
    2,
  ),
);
