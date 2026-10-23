// Read-only forensic estimate. Never calls an LLM, opens a writable SessionManager or repairs history.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveUnitPrices } from "../src/index.ts";
import { summaryHistoryBinding } from "./pi-steady-history.ts";
import { extractImmediateSummary, scoreImmediateSummary } from "./pi-summary-feedback.ts";

async function main() {
  const args = process.argv.slice(2),
    names = ["--session", "--audit", "--run-report", "--pi", "--out"];
  for (let i = 0; i < args.length; i += 2)
    if (!names.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Expected explicit session/audit/run-report/pi/out paths");
  const value = (name) => args[args.indexOf(name) + 1];
  if (names.some((n) => !args.includes(n))) throw new Error("Missing reconstruction input");
  const out = resolve(value("--out")),
    piRoot = resolve(value("--pi"));
  if (existsSync(out)) throw new Error("Refusing to overwrite reconstruction");
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const parse = (bytes) =>
    bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  let attempts = 0;
  const deny = () => {
    attempts++;
    throw new Error("Reconstruction is offline only");
  };
  globalThis.fetch = deny;
  http.request = deny;
  https.request = deny;
  syncBuiltinESMExports();
  const load = (p) => import(pathToFileURL(join(piRoot, p)).href);
  const [{ buildSessionProjection, CURRENT_SESSION_VERSION }, { estimateTokens }] =
    await Promise.all([
      load("packages/coding-agent/src/core/session-manager.ts"),
      load("packages/coding-agent/src/core/compaction/index.ts"),
    ]);
  const sessionBytes = readFileSync(value("--session")),
    auditBytes = readFileSync(value("--audit")),
    runBytes = readFileSync(value("--run-report")),
    run = JSON.parse(runBytes);
  assert.equal(
    sha(readFileSync(join(piRoot, "packages/coding-agent/dist/bundle/cli.js"))),
    run.steadyControl.piCliSha256,
  );
  const all = parse(sessionBytes),
    header = all[0];
  assert.equal(header.type, "session");
  assert.equal(header.version, CURRENT_SESSION_VERSION);
  const entries = all.slice(1),
    permits = parse(auditBytes).filter((c) => c.applied && c.resolution === "allow");
  const compactions = entries.filter((e) => e.type === "compaction");
  assert.equal(compactions.length, permits.length);
  assert.equal(compactions.length, run.arms[0].compactions);
  let stage = 0,
    sequence = 0;
  const rows = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "message" && e.message?.role === "assistant" && e.message.stopReason === "stop")
      stage++;
    if (e.type !== "compaction") continue;
    const permit = permits[sequence],
      snapshot = permit.prediction.snapshot;
    assert.equal(e.tokensBefore, snapshot.input.contextTokens);
    // Truncate first: future messages/edits cannot influence an older checkpoint.
    const projection = buildSessionProjection(entries.slice(0, i + 1), e.id);
    const after = projection.messages.reduce((n, m) => n + estimateTokens(m), 0);
    const binding = sha(summaryHistoryBinding(snapshot.input.profile));
    const sample = extractImmediateSummary(
      { tokensBefore: e.tokensBefore, estimatedTokensAfter: after, usage: e.usage },
      {
        sequence: ++sequence,
        stage,
        binding,
        compactorBinding: sha(JSON.stringify([20000, 13107, run.steadyControl.piCliSha256])),
      },
    );
    assert(sample);
    const score = scoreImmediateSummary(
      sample,
      snapshot.options.compactorTokenModel,
      resolveUnitPrices(snapshot.input.profile.pricing),
      "recorded-pre-compaction-decision-model",
    );
    rows.push({ ...sample, source: "offline-pi-projection-at-compaction-entry", score });
  }
  assert.equal(attempts, 0);
  const actualCost = rows.reduce((n, r) => n + (r.score.actualSummaryCost ?? 0), 0);
  assert(rows.every((r) => r.score.actualSummaryCost !== null));
  assert(Math.abs(actualCost - run.arms[0].compactionCost) < 1e-10);
  const mean = (key) => rows.reduce((n, r) => n + r.score[key], 0) / rows.length;
  const report = {
    runner: "foldpoint.pi-summary-reconstruction.v1",
    paidCalls: 0,
    networkAttempts: attempts,
    policyChanged: false,
    policyConsumed: false,
    estimatedOnly: true,
    source: "offline reconstruction, not captured immediate feedback or provider token truth",
    sourceSha256: sha(readFileSync(new URL(import.meta.url))),
    sessionSha256: sha(sessionBytes),
    auditSha256: sha(auditBytes),
    runReportSha256: sha(runBytes),
    piSourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: piRoot,
      encoding: "utf8",
    }).trim(),
    samples: rows.length,
    summaryCostReconciled: true,
    meanAfterRelativeError: mean("afterRelativeError"),
    meanSummaryCostError: mean("summaryCostError"),
    rows,
    limitations: [
      "Source helpers reproduce host estimates; matching CLI hash alone does not prove source/build identity.",
      "The method is checked against live SDK immediate estimates in a synthetic loopback fixture, not provider token counts.",
      "No historical trace is backfilled and no estimate is used to retune the measured policy.",
    ],
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({
      samples: report.samples,
      meanAfterRelativeError: report.meanAfterRelativeError,
      meanSummaryCostError: report.meanSummaryCostError,
      summaryCostReconciled: true,
      paidCalls: 0,
    })}\n`,
  );
}
await main().catch(() => {
  process.stderr.write(
    "Summary reconstruction failed validation; historical files were not modified\n",
  );
  process.exitCode = 1;
});
