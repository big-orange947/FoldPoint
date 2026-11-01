import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const inputs = [
  "traces/pi-ledger-floor-v2-20261023-full-01-dynamic.jsonl",
  "traces/pi-ledger-floor-v2-20261023-full-01-steady-control.jsonl",
  "traces/pi-ledger-floor-v2-20261023-full-01-summary-feedback.jsonl",
];
const command = (out: string) => [
  "--import",
  "tsx",
  "tools/pi-cycle-realized-audit.mjs",
  "--trace",
  inputs[0] ?? "",
  "--control",
  inputs[1] ?? "",
  "--feedback",
  inputs[2] ?? "",
  "--out",
  out,
];
it.skipIf(!inputs.every(existsSync))(
  "reconciles real complete cycles while retaining the censored final interval",
  () => {
    const out = join(mkdtempSync(join(tmpdir(), "cycle-audit-")), "report.json");
    const result = spawnSync(process.execPath, command(out), { encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(0);
    const r = JSON.parse(readFileSync(out, "utf8"));
    expect(r).toMatchObject({ paidCalls: 0, completeIntervals: 10, finalIntervalExcluded: true });
    expect(r.mean.actualCalls).toBe(12);
    expect(r.mean.predictedCalls).toBe(11);
    expect(r.mean.actualOrdinaryInputPerCall).toBeCloseTo(0.0060174538, 10);
    expect(r.mean.actualInputAndSummaryPerCall).toBeCloseTo(0.0111471738, 10);
  },
);
it("refuses to overwrite a report without exposing raw errors", () => {
  const out = join(mkdtempSync(join(tmpdir(), "cycle-audit-existing-")), "report.json");
  writeFileSync(out, "preserve");
  const result = spawnSync(process.execPath, command(out), { encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(1);
  expect(readFileSync(out, "utf8")).toBe("preserve");
  expect(result.stderr).toContain("failed validation");
});
