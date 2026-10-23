/** Offline structural comparison, not a simulated task or a savings result. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompactorTokenModel } from "../src/experimental-compactor";
import { stableCycleCandidates } from "../src/experimental-cycle";
import { resolveUnitPrices } from "../src/pricing";
import { predictRetainedFloor, retainedFloorCycles } from "./retained-floor";

export function auditRetainedFloor() {
  const retention = { totalRatio: 0.1, recentBudgetTokens: 20000 };
  const model: CompactorTokenModel = {
    after: { slope: 0.1, intercept: 20000, residual: 0 },
    output: { slope: 0.002, intercept: 0, residual: 0 },
    samples: 0,
    minBefore: 0,
    maxBefore: 700000,
    summaryInputCostPerToken: 0.3e-6,
  };
  const cells = [];
  for (const readRatio of [0.01, 0.1, 0.5, 1])
    for (const growth of [1000, 5000, 15000, 50000])
      for (const summarySharedPrefixRatio of [undefined, 1]) {
        const prices = resolveUnitPrices({
          inputPerMillion: 0.3,
          outputPerMillion: 1.2,
          cacheReadPerMillion: 0.3 * readRatio,
          cacheWritePerMillion: 0.3,
        });
        const billing = { summarySharedPrefixRatio };
        // Identical eligibility window; only the retention semantics differ.
        const best = (rows: ReturnType<typeof stableCycleCandidates>, minimum = 500000) =>
          rows
            .filter((r) => r.before >= minimum)
            .reduce<(typeof rows)[number] | null>(
              (a, b) => (!a || b.costPerOrdinaryCall < a.costPerOrdinaryCall ? b : a),
              null,
            );
        const legacyRows = stableCycleCandidates(prices, model, growth, 700000, billing);
        const revisedRows = retainedFloorCycles(prices, model, retention, growth, 700000, billing);
        const legacy = best(legacyRows);
        const revised = best(revisedRows);
        cells.push({
          readRatio,
          growth,
          summarySharedPrefixRatio: summarySharedPrefixRatio ?? null,
          legacy,
          revised,
          boundaryDelta: legacy && revised ? revised.before - legacy.before : null,
          unconstrained: { legacy: best(legacyRows, 0), revised: best(revisedRows, 0) },
        });
      }
  return {
    runner: "foldpoint.retained-floor-audit.v1",
    paidCalls: 0,
    policyChanged: false,
    executedTask: false,
    retention,
    eligibilityWindow: [500000, 700000],
    sizeChecks: [10000, 100000, 200000, 250000, 600000, 1000000].map((before) => ({
      before,
      legacyAfter: before * 0.1 + 20000,
      revisedAfter: predictRetainedFloor(retention, before),
    })),
    cells,
    limitations: [
      "Costs belong to different forecast worlds, not observed execution; do not subtract them as savings.",
      "500k eligibility is an explicit comparison constraint, not a new Pi default or a learned optimum.",
      "No task endpoint, provider cache behavior, quality or general superiority is measured.",
      "A recent-token budget is only a conservative prior floor, not an observed retained size.",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out" || !args[1] || args[1].startsWith("--"))
    throw new Error("usage: --out <fresh JSON path>");
  if (existsSync(args[1])) throw new Error("Refusing to overwrite retention audit");
  const report = auditRetainedFloor();
  writeFileSync(args[1], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  // Read back the complete artifact, not just a count printed before a failed write.
  const stored = JSON.parse(readFileSync(args[1], "utf8")) as typeof report;
  process.stdout.write(
    `${JSON.stringify({
      cells: stored.cells.length,
      unavailable: stored.cells.filter((c) => !c.legacy || !c.revised).length,
      earlier: stored.cells.filter((c) => c.boundaryDelta !== null && c.boundaryDelta < -1e-8)
        .length,
      later: stored.cells.filter((c) => c.boundaryDelta !== null && c.boundaryDelta > 1e-8).length,
      paidCalls: 0,
      savingsMeasured: false,
    })}\n`,
  );
}
