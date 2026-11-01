/** Predefined synthetic grid, same actual workload and compactor for every arm. */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeLearnedReplay } from "./learned-cycle-replay";

export function evaluateFiniteGate(continuationProbability = 0.98) {
  const cells: Array<{
    world: Parameters<typeof executeLearnedReplay>[0];
    baseline: { total: number; compactions: number };
    original: { total: number; compactions: number };
    candidate: { total: number; compactions: number; reasons: Record<string, number> };
  }> = [];
  for (const steps of [40, 160, 480])
    for (const growth of [6000, 22000])
      for (const readRatio of [0.02, 0.2])
        for (const law of ["fixed", "ratio", "affine"] as const)
          for (const history of ["cold", "past-wide"] as const) {
            const world = { steps, growth, readRatio, law, history };
            const baseline = executeLearnedReplay(world, "fixed60");
            const original = executeLearnedReplay(world, "supported");
            const candidate = executeLearnedReplay(world, "finite", continuationProbability);
            if (
              candidate.offeredGrowth !== baseline.offeredGrowth ||
              candidate.ordinaryCalls !== baseline.ordinaryCalls
            )
              throw new Error("different workload");
            cells.push({
              world,
              baseline: { total: baseline.total, compactions: baseline.compactions },
              original: { total: original.total, compactions: original.compactions },
              candidate: {
                total: candidate.total,
                compactions: candidate.compactions,
                reasons: candidate.reasons,
              },
            });
          }
  const summary = ["cold", "past-wide"].map((history) => {
    const rows = cells.filter((c) => c.world.history === history);
    const total = rows.reduce((n, c) => n + c.candidate.total, 0),
      base = rows.reduce((n, c) => n + c.baseline.total, 0);
    return {
      history,
      count: rows.length,
      wins: rows.filter((c) => c.candidate.total < c.baseline.total - 1e-10).length,
      ties: rows.filter((c) => Math.abs(c.candidate.total - c.baseline.total) <= 1e-10).length,
      losses: rows.filter((c) => c.candidate.total > c.baseline.total + 1e-10).length,
      total,
      baseline: base,
      relativeDifference: total / base - 1,
    };
  });
  return {
    runner: "foldpoint.finite-gate-eval.v1",
    paidCalls: 0,
    realTask: false,
    policyChanged: false,
    continuationProbability,
    summary,
    cells,
    limitations: [
      "A fixed survival assumption is hypothetical, not learned from these tasks or proof of their completion probability.",
      "Simulated warm cache and successful single-request summaries only; no quality, provider, failure or TTL validation.",
      "Forecasts are truncated at 128 calls; fallback if the residual survival probability exceeds 0.1.",
      "Past-wide synthetic history is supplied, not free newly acquired observations; no future task endpoint enters policy.",
    ],
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out" || !args[1] || existsSync(args[1]))
    throw new Error("A fresh --out path is required");
  const report = evaluateFiniteGate();
  writeFileSync(args[1], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}
