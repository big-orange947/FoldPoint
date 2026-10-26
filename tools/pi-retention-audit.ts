/** Prequential immediate-host-size audit. Pure learning path; no policy or network use. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PiImmediateRetentionLearner,
  type RetentionAssumptions,
  type RetentionBinding,
} from "./pi-retention-learner";

export function auditImmediateRetention(
  samples: readonly Record<string, unknown>[],
  binding: RetentionBinding,
  assumptions: RetentionAssumptions,
) {
  const learner = new PiImmediateRetentionLearner(binding, assumptions);
  const rows = [];
  for (const s of samples) {
    if (typeof s.beforeTokens !== "number" || typeof s.afterTokens !== "number")
      throw new Error("invalid metadata");
    // Snapshot/predict FIRST. Only this row's input size is used; its after-size cannot train its forecast.
    const before = learner.predict(s.beforeTokens);
    const accepted = learner.observe(s);
    if (accepted !== "accepted" && accepted !== "accepted-after-drift-reset")
      throw new Error("incompatible or invalid immediate feedback");
    rows.push({
      sequence: s.sequence,
      beforeTokens: s.beforeTokens,
      hostAfterTokens: s.afterTokens,
      forecastStatus: before.status,
      predictedAfterTokens: before.pointTokens,
      relativeError:
        before.pointTokens !== null && s.afterTokens > 0
          ? (before.pointTokens - s.afterTokens) / s.afterTokens
          : null,
      priorSampleCount: before.state.accepted,
      accepted,
      identifiableBefore: before.state.identifiable,
    });
  }
  const learned = rows.filter((r) => r.forecastStatus !== "prior-only" && r.relativeError !== null);
  return {
    runner: "foldpoint.pi-immediate-retention-audit.v1",
    paidCalls: 0,
    policyChanged: false,
    forecastBeforeObservation: true,
    hostEstimateOnly: true,
    canDrivePolicy: false,
    assumptions: { ...assumptions },
    summary: {
      samples: rows.length,
      priorForecasts: rows.filter((r) => r.forecastStatus === "prior-only").length,
      learnedForecasts: learned.length,
      unavailableForecasts: rows.filter((r) => r.predictedAfterTokens === null).length,
      outsideObservedRange: rows.filter((r) => r.forecastStatus === "outside-observed-range")
        .length,
      fittedForecasts: rows.filter((r) => r.forecastStatus === "fitted-host-model").length,
      learnedMeanAbsoluteRelativeError: learned.length
        ? learned.reduce((n, r) => n + Math.abs(r.relativeError ?? 0), 0) / learned.length
        : null,
    },
    rows,
    finalState: learner.snapshot(),
    limitations: [
      "Uses immediate Pi host estimates, not provider token truth; zero assumed errors means nominal host coordinates only.",
      "Cold prior forecasts and unavailable extrapolations are not counted as learned-model successes.",
      "No policy execution, new savings evidence or automatic use of historical reconstructed sessions.",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const names = ["--feedback", "--estimator-id", "--host-error-tokens", "--out"];
    if (args.length !== names.length * 2) throw new Error("invalid args");
    for (let i = 0; i < args.length; i += 2)
      if (!names.includes(args[i] ?? "") || !args[i + 1] || args[i + 1]?.startsWith("--"))
        throw new Error("invalid args");
    if (!names.every((n) => args.includes(n))) throw new Error("missing args");
    const value = (n: string) => args[args.indexOf(n) + 1] ?? "";
    const out = value("--out");
    if (existsSync(out)) throw new Error("existing output");
    const bytes = readFileSync(value("--feedback"));
    const samples = bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
    const first = samples[0];
    if (!first || typeof first.binding !== "string" || typeof first.compactorBinding !== "string")
      throw new Error("missing binding");
    const error = Number(value("--host-error-tokens"));
    const report = auditImmediateRetention(
      samples,
      {
        profileBinding: first.binding,
        compactorBinding: first.compactorBinding,
        estimatorId: value("--estimator-id"),
      },
      { beforeErrorTokens: error, afterErrorTokens: error, driftToleranceRatio: 0.05 },
    );
    writeFileSync(
      out,
      `${JSON.stringify({ ...report, feedbackSha256: createHash("sha256").update(bytes).digest("hex") }, null, 2)}\n`,
      { flag: "wx" },
    );
    process.stdout.write(
      `${JSON.stringify({ summary: report.summary, finalState: report.finalState, paidCalls: 0 }, null, 2)}\n`,
    );
  } catch {
    process.stderr.write("Immediate retention audit failed validation; source files unchanged\n");
    process.exitCode = 1;
  }
}
