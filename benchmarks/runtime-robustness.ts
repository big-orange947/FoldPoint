import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession } from "./simulator";

export function runtimeRobustnessReport() {
  const rows = [];
  for (const steps of [3, 8, 20])
    for (const growth of [0, 8_000])
      for (const cache of ["warm", "cold"] as const)
        for (const horizon of ["unknown", "bounded", "overstated"] as const) {
          const scenario: Scenario = {
            id: `${steps}-${growth}-${cache}-${horizon}`,
            name: "runtime-matrix",
            title: "Synthetic runtime sensitivity",
            seed: 73,
            contextWindowTokens: 256_000,
            pricing: {
              inputPerMillion: 3,
              outputPerMillion: 15,
              cacheReadPerMillion: 0.3,
              cacheWritePerMillion: 3.75,
            },
            cachePolicy: { ttlMs: 60_000 },
            steps,
            startTokens: 80_000,
            growthPerStep: growth,
            growthJitter: 0,
            outputTokens: 500,
            idleMs: cache === "warm" ? 1_000 : 120_000,
            compactor: { retentionRatio: 0.1, outputRatio: 0.02, successRate: 1 },
            ...(horizon === "unknown" ? {} : { hostHorizon: horizon === "bounded" ? steps : 30 }),
          };
          const common = { uncappedHostHorizon: horizon === "overstated" };
          const nominal = runSession(
            scenario,
            createFoldPointStrategy(scenario, {
              ...common,
              defaults: {
                economicSavingMargin: 0,
                economicHorizonDiscount: 0,
                economicRetentionStress: 0,
              },
            }),
          );
          const robust = runSession(scenario, createFoldPointStrategy(scenario, common));
          rows.push({ scenario, nominal: nominal.metrics, robust: robust.metrics });
        }
  return {
    kind: "foldpoint.runtime-robustness.v1",
    paidCalls: 0,
    limitations: [
      "Synthetic costs only; no task quality measurement.",
      "Bounded horizons have known remaining-step information unavailable to Pi.",
      "Overstated horizons intentionally remain at 30 even near runtime end.",
    ],
    rows,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runtimeRobustnessReport();
  writeFileSync(
    new URL("./reports/runtime-robustness-report.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const horizon of ["unknown", "bounded", "overstated"]) {
    const rows = report.rows.filter((row) => row.scenario.id.endsWith(horizon));
    for (const arm of ["nominal", "robust"] as const) {
      const sum = (
        key:
          | "totalSimulatedCost"
          | "compactionAttemptCount"
          | "unnecessaryCompactionCount"
          | "judgedCompactionCount"
          | "overflowCount",
      ) => rows.reduce((n, row) => n + row[arm][key], 0);
      console.log(
        JSON.stringify({
          horizon,
          arm,
          cost: sum("totalSimulatedCost"),
          attempts: sum("compactionAttemptCount"),
          unneeded: sum("unnecessaryCompactionCount"),
          judged: sum("judgedCompactionCount"),
          overflow: sum("overflowCount"),
        }),
      );
    }
  }
}
