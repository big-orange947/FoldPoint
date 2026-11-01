// Read-only numeric comparison for the controlled 140-stage development run.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { costOfUsage, resolveUnitPrices } from "../src/pricing.ts";

try {
  const args = process.argv.slice(2),
    names = ["--trace", "--control", "--feedback", "--out"];
  if (args.length !== 8 || !names.every((n) => args.includes(n)))
    throw new Error("invalid arguments");
  for (let i = 0; i < args.length; i += 2)
    if (!names.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("invalid arguments");
  const value = (n) => args[args.indexOf(n) + 1];
  if (existsSync(value("--out"))) throw new Error("output exists");
  const read = (n) => readFileSync(value(n));
  const lines = (b) => b.toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const trace = read("--trace"),
    control = read("--control"),
    feedbackBytes = read("--feedback");
  const requests = lines(trace).filter((e) => e.type === "request");
  const permits = lines(control).filter(
    (e) => e.applied && e.basis === "total-floor-v2" && e.resolution === "allow",
  );
  const feedback = lines(feedbackBytes);
  if (requests.length !== 140 || permits.length !== 11 || feedback.length !== 11)
    throw new Error("unexpected corpus");
  const prices = resolveUnitPrices(permits[0].prediction.snapshot.input.profile.pricing);
  const intervals = [];
  for (let i = 0; i + 1 < feedback.length; i++) {
    const current = feedback[i],
      next = feedback[i + 1],
      selected = permits[i].prediction.selected;
    if (
      current.sequence !== i + 1 ||
      next.sequence !== i + 2 ||
      current.stage >= next.stage ||
      permits[i].prediction.snapshot.input.contextTokens !== current.beforeTokens ||
      next.score?.actualSummaryCost == null
    )
      throw new Error("unaligned events");
    // Current stage's ordinary call occurs after current compaction; next stage compacts before its ordinary call.
    const calls = requests.slice(current.stage - 1, next.stage - 1);
    if (
      calls.length !== next.stage - current.stage ||
      calls.some(
        (r) =>
          r.outcome !== "ok" ||
          !Number.isSafeInteger(r.usage?.promptTokens) ||
          !Number.isSafeInteger(r.usage?.cachedInputTokens) ||
          !Number.isSafeInteger(r.usage?.outputTokens) ||
          !Number.isSafeInteger(r.usage?.cacheWriteTokens) ||
          r.usage.cachedInputTokens + r.usage.cacheWriteTokens > r.usage.promptTokens,
      )
    )
      throw new Error("invalid usage");
    const prompt = calls.reduce((n, c) => n + c.usage.promptTokens, 0);
    const cached = calls.reduce((n, c) => n + c.usage.cachedInputTokens, 0);
    const ordinaryInput = calls.reduce(
      (n, c) => n + costOfUsage(prices, { ...c.usage, outputTokens: 0 }),
      0,
    );
    const ordinaryOutput = calls.reduce(
      (n, c) => n + c.usage.outputTokens * prices.outputPerToken,
      0,
    );
    intervals.push({
      sequence: current.sequence,
      actualCalls: calls.length,
      predictedCalls: selected.ordinaryCalls,
      actualCachedFraction: prompt ? cached / prompt : null,
      actualOrdinaryInputPerCall: ordinaryInput / calls.length,
      predictedOrdinaryInputPerCall: selected.ordinaryCost / selected.ordinaryCalls,
      actualNextSummaryCost: next.score.actualSummaryCost,
      predictedNextSummaryCost: selected.summaryCost,
      actualInputAndSummaryPerCall: (ordinaryInput + next.score.actualSummaryCost) / calls.length,
      predictedInputAndSummaryPerCall: selected.costPerOrdinaryCall,
      ordinaryOutputCost: ordinaryOutput,
    });
  }
  const mean = (key) => intervals.reduce((n, r) => n + r[key], 0) / intervals.length;
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  const output = {
    runner: "foldpoint.pi-cycle-realized-audit.v1",
    paidCalls: 0,
    policyChanged: false,
    inputs: {
      traceSha256: hash(trace),
      controlSha256: hash(control),
      feedbackSha256: hash(feedbackBytes),
    },
    completeIntervals: intervals.length,
    finalIntervalExcluded: true,
    intervals,
    mean: {
      actualCalls: mean("actualCalls"),
      predictedCalls: mean("predictedCalls"),
      actualCachedFraction: mean("actualCachedFraction"),
      actualOrdinaryInputPerCall: mean("actualOrdinaryInputPerCall"),
      predictedOrdinaryInputPerCall: mean("predictedOrdinaryInputPerCall"),
      actualNextSummaryCost: mean("actualNextSummaryCost"),
      predictedNextSummaryCost: mean("predictedNextSummaryCost"),
      actualInputAndSummaryPerCall: mean("actualInputAndSummaryPerCall"),
      predictedInputAndSummaryPerCall: mean("predictedInputAndSummaryPerCall"),
    },
    limitations: [
      "One controlled development task; no counterfactual alternative policy is observed.",
      "Matches this runner's one-successful-request-per-stage protocol; final incomplete interval excluded.",
      "Ordinary output omitted from both cycle comparisons; separately reported per interval.",
      "Observed provider usage priced using the recorded local snapshot, not invoice totals.",
    ],
  };
  writeFileSync(value("--out"), `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(output.mean, null, 2)}\n`);
} catch {
  process.stderr.write("Cycle audit failed validation; source files unchanged\n");
  process.exitCode = 1;
}
