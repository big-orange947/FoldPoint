/** Public synthetic evidence-retention probe, NOT an agent task-completion benchmark. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { buildRecoveryMatrixReport } from "./recovery-matrix";

export const REPEATED_CHECKPOINTS = [29, 59, 89] as const;
export const REPEATED_QUESTION = `Return JSON only, with exactly these keys:
branch, deployment_window, retention, build, test_status, approval, backup, rollback,
owner, config_path, deployment_allowed, next_action.
Use current established facts, not superseded instructions or guesses.
All values are strings except deployment_allowed, which must be a boolean.
Use HH:MMZ for deployment_window, Nd for retention, passed/total for test_status.
Use pending/approved/rejected for approval, pending/verified/failed for backup,
required/not-required for rollback, and verify-backup/deploy for next_action.
deployment_allowed means the stated approval/test/backup prerequisites are satisfied,
not that deployment already happened or that a wall-clock window has arrived.
Use "unknown" for any unestablished string. Do not mark unperformed work complete.`;

export function repeatedExpected(step: number): Record<string, string | boolean> {
  if (!Number.isSafeInteger(step) || step < 0 || step >= 90) throw new RangeError("invalid stage");
  return {
    branch: "main",
    deployment_window: step >= 25 ? "23:30Z" : "23:00Z",
    retention: "7d",
    build: step >= 30 ? "BUILD-422" : "BUILD-421",
    test_status: step >= 35 ? "7/7" : "6/7",
    approval: step >= 45 ? "approved" : "pending",
    backup: step >= 75 ? "verified" : "pending",
    rollback: "required",
    owner: "operator-mira",
    config_path: step >= 63 ? "config/prod.toml" : "config/release.toml",
    deployment_allowed: step >= 75,
    next_action: step >= 75 ? "deploy" : "verify-backup",
  };
}
export function repeatedMessages(step: number) {
  // Validate the public stage, never use evaluator answers to construct prompts.
  if (!Number.isSafeInteger(step) || step < 0 || step >= 90) throw new RangeError("invalid stage");
  const updates: Record<number, string> = {
    0: "Owner instructions: branch main, deployment window 23:00Z, retention 7d, rollback required, target BUILD-421. Owner is operator-mira. Edit config/release.toml. Approval and backup verification are pending. Next action is verify-backup until verification is complete; after approval, all tests and backup verification are complete, next action is deploy. Never deploy before those prerequisites are satisfied.",
    5: "Tool report: tests 6/7; MIG-7 failed. No deployment was performed.",
    25: "Owner correction: deployment window is now 23:30Z, replacing 23:00Z. Other instructions unchanged.",
    30: "Owner replaces BUILD-421 with BUILD-422. Approval remains pending.",
    35: "Tool report: MIG-7 fixed; complete tests pass 7/7. Backup is not yet verified.",
    45: "Owner approved BUILD-422. Approval alone is not backup verification. No backup verification has been performed.",
    63: "Owner correction: edit config/prod.toml, replacing config/release.toml. Other constraints unchanged.",
    75: "Tool report: backup verification succeeded for BUILD-422. The backup is now verified. Deployment itself has NOT been performed.",
  };
  const noise = Array.from(
    { length: 10 },
    (_, i) =>
      `Inspection ${step}-${i}: module_${(step + i) % 17} lint clean, artifact probe_${step}_${i} is diagnostic only; it does not establish approval, backup or deployment completion.`,
  ).join("\n");
  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `Task log stage ${step + 1}.\n${updates[step] ?? "No new authoritative changes to requirements or deployment state."}\n${noise}`,
        },
      ],
      timestamp: step + 1,
    },
  ];
}
export function gradeRepeated(answer: string, step: number) {
  let actual: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(
      answer
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      actual = parsed as Record<string, unknown>;
  } catch {
    /* malformed output fails */
  }
  const expected = repeatedExpected(step);
  const fields = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [key, actual[key] === value]),
  );
  return {
    fields,
    correct: Object.values(fields).filter(Boolean).length,
    total: 12,
    exact:
      Object.keys(actual).sort().join(",") === Object.keys(expected).sort().join(",") &&
      Object.values(fields).every(Boolean),
  };
}
export function buildRepeatedQualityPlan() {
  const raw = readFileSync(
    new URL("../benchmarks/reports/recovery-matrix.json", import.meta.url),
    "utf8",
  );
  const matrixSha = createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex");
  if (matrixSha !== "052fc67fb6dc5ae931d7dbf8d0ad354d3833ec345ccd97949fb238d6262a08b6")
    throw new Error("frozen matrix changed");
  const matrix = JSON.parse(raw) as ReturnType<typeof buildRecoveryMatrixReport>;
  const source = {
    profile: "claude-sonnet-5.5-5m-price",
    sourceFixture: "heldout-floor-180-22000-20000",
    seed: 151,
    steps: 120,
  };
  const row = matrix.main.find(
    (r) =>
      r.profile === source.profile &&
      r.sourceFixture === source.sourceFixture &&
      r.seed === source.seed &&
      r.steps === source.steps,
  );
  if (!row || matrix.metadata.manifest.candidateCommit !== "8c054cc")
    throw new Error("missing frozen exposure case");
  const schedules = {
    fixed60: row.fixed60.compactions.filter((c) => c.step < 90).map((c) => c.step),
    experimental: row.candidate.compactions.filter((c) => c.step < 90).map((c) => c.step),
  };
  return {
    kind: "foldpoint.repeated-summary-plan.v1",
    stages: 90,
    checkpoints: REPEATED_CHECKPOINTS,
    scheduleSource: "frozen-8c054cc-matrix-prefix",
    source,
    matrixSha256: matrixSha,
    schedules,
    summaryCalls: schedules.fixed60.length + schedules.experimental.length,
    checkpointCalls: 9,
    corpusSha256: createHash("sha256")
      .update(
        JSON.stringify({
          messages: Array.from({ length: 90 }, (_, step) => repeatedMessages(step)),
          question: REPEATED_QUESTION,
        }),
      )
      .digest("hex"),
    summaryMaxOutputTokens: 13107,
    maxHttpCalls: 24,
    maxPromptByteUnits: 1500000,
    limitations: [
      "Frozen 90-step exposure prefix from a 120-call synthetic schedule, applied to a smaller public task log. NOT live adaptive timing, a new 1M trial or a provider-cost comparison.",
      "One predeclared source case, not the whole frequency matrix or a heldout quality dataset. No selection using retention scores.",
      "Only Pi initial/update summary prompts are exercised; normal agent reasoning/tool execution, native cut points and recent-tail preservation are not.",
      "Answer probes measure evidence retention and simple state prerequisites, not task completion. Dry-run fake responses are never scored as quality evidence.",
    ],
  };
}
