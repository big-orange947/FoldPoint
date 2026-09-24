import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareAgentDir,
  prepareScratch,
  type RunResult,
  renderComparison,
  TASKS,
} from "../tools/pi-paired-run";
import type { SessionCost } from "../tools/trace-analyze";

describe("paired Pi trial isolation", () => {
  it("requires each step artifact to contain the ordered eight numbers exactly once", () => {
    const task = TASKS.find((entry) => entry.id === "steps");
    expect(task).toBeDefined();
    const valid = "1\n61\n121\n181\n241\n301\n361\n421\n";
    expect(task?.check(valid)).toBe(true);
    expect(task?.check(`${valid}421\n`)).toBe(false);
    expect(task?.check("421\n361\n301\n241\n181\n121\n61\n1\n")).toBe(false);
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
    const cost = (totalCost: number): SessionCost => ({
      sessionId: "s",
      calls: 1,
      callCost: totalCost,
      compactions: 0,
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
      "paired veto vs default: 1 matched passing rep(s), -20.0% cost change",
    );
    expect(report).toContain(
      "paired late vs default: 1 matched passing rep(s), -10.0% cost change",
    );
    expect(report).toContain("paired veto vs late: 1 matched passing rep(s), -11.1% cost change");
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
