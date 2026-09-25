import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareAgentDir,
  prepareScratch,
  prepareTaskScratch,
  type RunResult,
  renderComparison,
  TASKS,
} from "../tools/pi-paired-run";
import type { SessionCost } from "../tools/trace-analyze";

describe("paired Pi trial isolation", () => {
  it("seeds the ledger repair task and checks it with an oracle outside the scratch directory", () => {
    const root = mkdtempSync(join(tmpdir(), "foldpoint-ledger-seed-"));
    const task = TASKS.find((entry) => entry.id === "ledger");
    expect(task).toBeDefined();
    if (task === undefined) return;
    const scratch = prepareTaskScratch(root, task);
    expect(readFileSync(join(scratch, "SPEC.md"), "utf8")).toContain("half-open UTC interval");
    const source = readFileSync(join(scratch, "ledger.mjs"), "utf8");
    expect(task.check(source, scratch)).toBe(false);
    expect(() => readFileSync(join(scratch, "oracle.test.mjs"), "utf8")).toThrow();

    const repaired = `export function summarizeLedger(rows, { from, to }) {
      const seen = new Set();
      const perUser = new Map();
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        if (row.occurredAt < from || row.occurredAt >= to) continue;
        const current = perUser.get(row.userId) ?? {
          userId: row.userId, netCents: 0, transactionCount: 0,
        };
        current.netCents += row.kind === "refund" ? -row.amountCents : row.amountCents;
        current.transactionCount += 1;
        perUser.set(row.userId, current);
      }
      return [...perUser.values()].sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
    }`;
    writeFileSync(join(scratch, "ledger.mjs"), repaired);
    expect(task.check(repaired, scratch)).toBe(true);
    writeFileSync(join(scratch, "SPEC.md"), "changed spec");
    expect(task.check(repaired, scratch)).toBe(false);
  });

  it("requires each step artifact to contain the ordered eight numbers exactly once", () => {
    const task = TASKS.find((entry) => entry.id === "steps");
    expect(task).toBeDefined();
    const valid = "1\n61\n121\n181\n241\n301\n361\n421\n";
    expect(task?.check(valid, "unused")).toBe(true);
    expect(task?.check(`${valid}421\n`, "unused")).toBe(false);
    expect(task?.check("421\n361\n301\n241\n181\n121\n61\n1\n", "unused")).toBe(false);
  });

  it("creates fresh workspaces without deleting anything in PI_SCRATCH", () => {
    const root = mkdtempSync(join(tmpdir(), "foldpoint-seed-"));
    writeFileSync(join(root, "big.txt"), "seed");
    writeFileSync(join(root, "unrelated-user-file.txt"), "keep me");
    const first = prepareScratch(root);
    writeFileSync(join(first, "out-sum.md"), "old result");
    const second = prepareScratch(root);
    expect(first).not.toBe(second);
    expect(readFileSync(join(root, "unrelated-user-file.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(first, "out-sum.md"), "utf8")).toBe("old result");
    expect(readFileSync(join(second, "big.txt"), "utf8")).toBe("seed");
    expect(() => readFileSync(join(second, "out-sum.md"), "utf8")).toThrow();
  });

  it("allows a sum-only run without a big.txt fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "foldpoint-sum-seed-"));
    const scratch = prepareScratch(root, []);
    expect(scratch).not.toBe(root);
    expect(() => prepareScratch(root)).toThrow(/missing required seed file big.txt/);
  });

  it("isolates arm settings and explicitly disables Pi cache warming in the timing trial", () => {
    const root = mkdtempSync(join(tmpdir(), "foldpoint-agent-"));
    const original = {
      cacheWarming: "streaming",
      compaction: {
        custom: 7,
        modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 9000 } },
      },
      other: true,
    };
    writeFileSync(join(root, "settings.json"), JSON.stringify(original));
    writeFileSync(join(root, "models.json"), "{}");
    const defaultDir = prepareAgentDir(root, "default");
    const vetoDir = prepareAgentDir(root, "veto");
    const lateDir = prepareAgentDir(root, "late");
    const warmDir = prepareAgentDir(root, "veto", "streaming");
    const read = (dir: string) =>
      JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(defaultDir).not.toBe(vetoDir);
    expect(read(defaultDir).cacheWarming).toBe("off");
    expect(read(vetoDir).cacheWarming).toBe("off");
    expect(read(warmDir).cacheWarming).toBe("streaming");
    expect(read(vetoDir).sessionDir).toBe(join(vetoDir, "sessions"));
    expect((read(defaultDir).compaction as { reserveTokens: number }).reserveTokens).toBe(16_384);
    expect((read(vetoDir).compaction as { reserveTokens: number }).reserveTokens).toBe(24_000);
    expect((read(vetoDir).compaction as { modelOverrides: object }).modelOverrides).toEqual({});
    expect((read(lateDir).compaction as { reserveTokens: number }).reserveTokens).toBe(6_000);
    expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(JSON.stringify(original));
    expect(readFileSync(join(vetoDir, "models.json"), "utf8")).toBe("{}");
  });

  it("compares only matched, successful repetitions", () => {
    const cost = (totalCost: number, compactions = 1): SessionCost => ({
      sessionId: "s",
      calls: 1,
      callCost: totalCost,
      compactions,
      compactionCost: 0,
      cacheWarms: 0,
      cacheWarmCost: 0,
      compactionsNotRun: 0,
      totalCost,
      compactionShare: 0,
      currency: "USD",
    });
    const result = (
      condition: RunResult["condition"],
      rep: number,
      amount: number,
      artifactOk = true,
    ): RunResult => ({
      task: "sum",
      condition,
      cacheWarming: "off",
      rep,
      exitCode: 0,
      ok: true,
      artifactOk,
      cost: cost(amount),
      trace: "trace",
    });
    const report = renderComparison(
      [
        result("default", 1, 10),
        result("veto", 1, 8),
        result("late", 1, 9),
        result("default", 2, 100),
        result("veto", 2, 1, false),
      ],
      TASKS.filter((task) => task.id === "sum"),
    );
    expect(report).toContain(
      "paired veto vs default: 1/1 informative matched passing rep(s), -20.0% cost change",
    );
    expect(report).toContain(
      "paired late vs default: 1/1 informative matched passing rep(s), -10.0% cost change",
    );
    expect(report).toContain(
      "paired veto vs late: 1/1 informative matched passing rep(s), -11.1% cost change",
    );
    const uninformative = renderComparison(
      [
        { ...result("default", 1, 10), cost: cost(10, 0) },
        { ...result("veto", 1, 8), cost: cost(8, 0) },
      ],
      TASKS.filter((task) => task.id === "sum"),
    );
    expect(uninformative).toContain(
      "paired veto vs default: 0/1 informative matched passing rep(s), n/a cost change; 1 no-compaction pair(s) excluded",
    );
    const mixed = renderComparison(
      [
        { ...result("default", 1, 100), cost: cost(100, 0) },
        { ...result("veto", 1, 1), cost: cost(1, 0) },
        result("default", 2, 10),
        result("veto", 2, 8),
      ],
      TASKS.filter((task) => task.id === "sum"),
    );
    expect(mixed).toContain(
      "paired veto vs default: 1/2 informative matched passing rep(s), -20.0% cost change; 1 no-compaction pair(s) excluded",
    );
    expect(() =>
      renderComparison(
        [
          result("default", 1, 10),
          {
            ...result("veto", 1, 8),
            cacheWarming: "streaming",
          },
        ],
        TASKS.filter((task) => task.id === "sum"),
      ),
    ).toThrow(/different Pi cache-warming modes/);
  });
});
