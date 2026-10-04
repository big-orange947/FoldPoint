/** Public synthetic ledger; expected answers are evaluator-only and never part of summaries. */
import { createHash } from "node:crypto";
import { createRawFixedThresholdStrategy } from "./fixed-threshold";
import { buildMillionScenarios } from "./million-simulation";
import { createFoldPointStrategy, runSession } from "./simulator";

export const QUALITY_CHECKPOINTS = [19, 39, 59] as const;
export const QUALITY_QUESTION = `Return only a JSON object with exactly these keys:
branch, deployment_window, retention, build, test_status, approval, backup, rollback.
Use the current task state, not superseded values. Values must be concise strings.
Format deployment_window as HH:MMZ, retention as Nd, test_status as passed/total (for example 1/2).
Use approval: pending/approved/rejected, backup: pending/verified/failed, rollback: required/not-required.
If the conversation does not establish a value, use "unknown". Do not invent completed work.`;

export function qualityExpected(step: number): Record<string, string> {
  return {
    branch: "main",
    deployment_window: step >= 25 ? "23:30Z" : "23:00Z",
    retention: "7d",
    build: step >= 30 ? "BUILD-422" : "BUILD-421",
    test_status: step >= 35 ? "7/7" : "6/7",
    approval: step >= 45 ? "approved" : "pending",
    backup: "pending",
    rollback: "required",
  };
}

export function qualityMessages(step: number) {
  const updates: Record<number, string> = {
    0: "Owner requirements: work on branch main. Deployment window 23:00Z. Log retention 7d. Rollback is required. Target build BUILD-421. Approval is pending. Backup verification is pending.",
    5: "Tool result: test suite 6/7. MIG-7 failed. This does not authorize deployment.",
    25: "Owner correction: deployment window is now 23:30Z, replacing 23:00Z. Other requirements unchanged.",
    30: "Owner decision: replace target build BUILD-421 with BUILD-422. Approval still pending.",
    35: "Tool result: MIG-7 fixed and the complete test suite now passes 7/7. Backup verification still pending.",
    45: "Owner approved BUILD-422. Backup verification has not been performed; it is still pending, not done.",
  };
  const details = Array.from(
    { length: 10 },
    (_, i) =>
      `Inspection ${step}-${i}: component module_${(step + i) % 17} reports lint clean; artifact probe_${step}_${i} is a diagnostic only, not deployment, approval or backup completion.`,
  ).join("\n");
  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `Task log stage ${step + 1}.\n${updates[step] ?? "No changes to requirements or deployment state."}\n${details}`,
        },
      ],
      timestamp: step + 1,
    },
  ];
}

export function buildQualityPlan() {
  // Predeclared exposure case, NOT selected by quality scores or used to retune a policy.
  const scenario = buildMillionScenarios().find(
    (s) => s.id === "expensiveRead-warm-0.1-0.002-60-32000",
  );
  if (!scenario) throw new Error("Missing frozen schedule case");
  const schedules = {
    fixed60: runSession(scenario, createRawFixedThresholdStrategy(0.6)).compactions.map(
      (c) => c.step,
    ),
    experimental: runSession(
      scenario,
      createFoldPointStrategy(scenario, {
        omitRequestCacheEvidence: true,
        verifiedAppendOnlyPrefix: true,
        defaults: { compactOutputRatio: 0.002 },
        runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
      }),
    ).compactions.map((c) => c.step),
  };
  return {
    kind: "foldpoint.summary-quality-plan.v2",
    stages: 60,
    checkpoints: QUALITY_CHECKPOINTS,
    scheduleSource: scenario.id,
    schedules,
    summaryCalls: schedules.fixed60.length + schedules.experimental.length,
    checkpointCalls: 9, // full-history reference + both summary chains, at identical stages
    corpusSha256: createHash("sha256")
      .update(JSON.stringify(Array.from({ length: 60 }, (_, step) => qualityMessages(step))))
      .digest("hex"),
    summaryMaxOutputTokens: 13_107,
    limitations: [
      "Frozen 1M simulation schedules applied to a smaller synthetic ledger; NOT live strategy timing or 1M savings.",
      "Pi generateSummaryWithUsage initial/update prompts are real, but full compaction cut points/recent-tail preservation are not exercised.",
      "Measures current-state evidence retention via answer probes, NOT agent task completion or user population quality.",
      "Single corpus and one sample per arm; no statistical non-inferiority claim.",
    ],
  };
}

export function gradeQuality(answer: string, step: number) {
  let actual: Record<string, unknown> = {};
  try {
    actual = JSON.parse(
      answer
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    /* malformed output fails */
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) actual = {};
  const expected = qualityExpected(step);
  const fields = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [key, actual[key] === value]),
  );
  return {
    fields,
    correct: Object.values(fields).filter(Boolean).length,
    total: 8,
    exact:
      Object.keys(actual).sort().join(",") === Object.keys(expected).sort().join(",") &&
      Object.values(fields).every(Boolean),
  };
}
