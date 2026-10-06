/** Reproduce frozen failures with a read-only mirror of actual compaction feedback. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DURATION_PRIOR } from "../benchmarks/duration-mixture";
import type { buildReplicationReport } from "../benchmarks/future-replication";
import { replicationSourceHashes } from "../benchmarks/future-replication";
import { collectCompactorHistory } from "../benchmarks/history-reuse";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import { warmLengthCases } from "../benchmarks/warm-length-seed";
import { ExperimentalCompactorLearner, resolveUnitPrices } from "../src/index";

const root = fileURLToPath(new URL("../", import.meta.url));
const report = JSON.parse(
  readFileSync(resolve(root, "benchmarks/reports/future-replication.json"), "utf8"),
) as ReturnType<typeof buildReplicationReport>;
const hashes = replicationSourceHashes();
const rows = report.failures.map((failure) => {
  const c = warmLengthCases().find(
    (c) =>
      c.suite === "main" &&
      c.profile === failure.profile &&
      c.sourceFixture === failure.sourceFixture &&
      c.seed === failure.seed &&
      c.steps === failure.steps,
  );
  if (!c) throw new Error("missing failed scenario");
  const scenario = c.scenario;
  const history = collectCompactorHistory({ ...scenario, cycleBilling: undefined });
  const mirror = new ExperimentalCompactorLearner(history.observations);
  let successfulCompactions = 0;
  let lastValidStep: number | null = null;
  let evidence:
    | {
        step: number;
        contextTokens: number;
        samples: number;
        minBefore: number;
        maxBefore: number;
        spanRatio: number;
        modelAvailable: boolean;
        successfulCompactions: number;
      }
    | undefined;
  const base = createFoldPointStrategy(scenario, {
    learnedCompactorTokens: true,
    compactorHistory: history.observations,
    warmCoreFromHistory: true,
    enforceForecastExecutionGates: true,
    omitRequestCacheEvidence: true,
    verifiedAppendOnlyPrefix: true,
    defaults: { compactOutputRatio: 0.002 },
    runtimeSurvival: {
      continuationProbability: 0.95,
      maxImmediateLossRatio: 1,
      maxCalls: 256,
      rolloutMode: "renewal",
      endingRiskMode: "survival-weighted",
      endingLossBudgetRatio: 1,
      savingMarginBasis: "timing",
      durationModel: { completedCalls: 0, components: DURATION_PRIOR },
      cycleBilling: scenario.cycleBilling,
      stressWaitSelection: "paired-policy",
      futureQualification: { maxChecksPerPath: 2 },
    },
  });
  const prices = resolveUnitPrices(scenario.pricing);
  let caught: unknown;
  try {
    runSession(scenario, {
      ...base,
      decide(request) {
        const points = mirror.exportObservations();
        const minBefore = Math.min(...points.map((p) => p.beforeTokens));
        const maxBefore = Math.max(...points.map((p) => p.beforeTokens));
        const modelAvailable = mirror.snapshot() !== undefined;
        evidence = {
          step: request.step,
          contextTokens: request.contextTokens,
          samples: points.length,
          minBefore,
          maxBefore,
          spanRatio: (maxBefore - minBefore) / maxBefore,
          modelAvailable,
          successfulCompactions,
        };
        if (modelAvailable) lastValidStep = request.step;
        return base.decide(request);
      },
      onCompaction(event) {
        base.onCompaction?.(event);
        if (!event.success) return;
        successfulCompactions++;
        mirror.observe({
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
          outputTokens: event.outputTokens,
          summaryInputCostPerToken:
            event.summaryInputCostPerToken ??
            Math.max(0, event.cost - event.outputTokens * prices.outputPerToken) /
              event.beforeTokens,
        });
      },
    });
  } catch (error) {
    caught = error;
  }
  if (
    !(caught instanceof RangeError) ||
    caught.message !==
      "future qualification requires renewal, paired stress, execution gates and token model; excludes other ablations and cumulative budgets"
  )
    throw caught ?? new Error("failure did not reproduce");
  if (!evidence || evidence.modelAvailable || evidence.samples !== 32 || evidence.spanRatio >= 0.2)
    throw new Error("low-span diagnosis not confirmed");
  console.log(
    `confirmed ${c.profile}/${c.sourceFixture}/${c.seed}/${c.steps}: step=${evidence.step}, span=${evidence.spanRatio}`,
  );
  return {
    ...failure,
    evidence,
    lastValidStep,
    evidenceKind: "mirror-of-actual-successful-feedback",
  };
});
if (JSON.stringify(replicationSourceHashes()) !== JSON.stringify(hashes))
  throw new Error("source changed during diagnosis");
const out = {
  kind: "foldpoint.future-model-diagnosis.v1",
  candidateCommit: "dafcc42",
  externalCalls: 0,
  paidCalls: 0,
  sourceHashes: hashes,
  rows,
  limitation:
    "Diagnostic mirror consumes only actual successful feedback and never enters the frozen controller. It reproduces the error, not a proposed fix or cost projection for failed runs.",
};
mkdirSync(resolve(root, "benchmarks/reports"), { recursive: true });
writeFileSync(
  resolve(root, "benchmarks/reports/future-model-diagnosis.json"),
  `${JSON.stringify(out, null, 2)}\n`,
);
