import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideFoldPoint, TraceRecorder } from "../src/index";
import {
  prepareAgentDir,
  prepareScratch,
  prepareTaskScratch,
  type RunResult,
  renderComparison,
  sessionCostOf,
  TASKS,
  TRIAL_PRICES,
} from "../tools/pi-paired-run";
import type { SessionCost } from "../tools/trace-analyze";
import { makeInput, makeLearning, makeProfile, makeSession } from "./helpers";

describe("paired Pi trial isolation", () => {
  it("treats failed compactions as unpriced but does not mistake a veto for a paid failure", () => {
    const root = mkdtempSync(join(tmpdir(), "foldpoint-unpriced-"));
    const tracePath = join(root, "trace.jsonl");
    const trace = new TraceRecorder({ producer: "test", now: () => 1 });
    const input = makeInput({ sessionId: "session", timestamp: 1 });
    const decision = decideFoldPoint(input, makeLearning(), makeSession());
    const events = [
      trace.header(),
      trace.decision(input, decision, { callId: "call-1" }),
      trace.request("session", "call-1", {
        timestamp: 1,
        promptTokens: 10_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
      }),
      trace.compaction(
        "session",
        { timestamp: 2, beforeTokens: 10_000, afterTokens: 10_000, success: false },
        { errorCode: "failed" },
      ),
      trace.compaction(
        "session",
        { timestamp: 3, beforeTokens: 10_000, afterTokens: 10_000, success: false },
        { errorCode: "vetoed" },
      ),
      trace.sessionEnd("session", { timestamp: 4 }),
    ];
    writeFileSync(tracePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    expect(sessionCostOf(tracePath)?.unpricedCompactions).toBe(1);
  });

  it("rejects actual-price cache warming in a hypothetical-price trace", () => {
    const root = mkdtempSync(join(tmpdir(), "foldpoint-mixed-price-"));
    const tracePath = join(root, "trace.jsonl");
    const trace = new TraceRecorder({ producer: "test", now: () => 1 });
    const input = makeInput({
      sessionId: "session",
      timestamp: 1,
      profile: makeProfile({
        provider: "deepseek",
        model: "deepseek-flash",
        pricing: {
          currency: "HYPOTHETICAL",
          source: "pi-experiment:cache-read-60:deepseek/deepseek-flash",
          inputPerMillion: 1,
          outputPerMillion: 5,
          cacheReadPerMillion: 0.6,
          cacheWritePerMillion: 1.25,
        },
      }),
    });
    const decision = decideFoldPoint(input, makeLearning(), makeSession());
    const events = [
      trace.header(),
      trace.decision(input, decision, { callId: "call-1" }),
      trace.request("session", "call-1", {
        timestamp: 1,
        promptTokens: 10_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
      }),
      trace.cacheWarm("session", 2, {
        promptTokens: 1000,
        cachedInputTokens: 999,
        cacheWriteTokens: 0,
        outputTokens: 1,
        actualCost: 0.001,
      }),
      trace.sessionEnd("session", { timestamp: 3 }),
    ];
    writeFileSync(tracePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    expect(() => sessionCostOf(tracePath, "cache-read-60")).toThrow(/actual-price cache warming/);
  });

  it.skipIf(process.env.FOLDPOINT_PRICING_VERIFY === "1")(
    "starts the frozen repository task with failing billing and accepts a repaired source",
    () => {
      const root = mkdtempSync(join(tmpdir(), "foldpoint-pricing-seed-"));
      const task = TASKS.find((entry) => entry.id === "pricing-regression");
      expect(task).toBeDefined();
      if (task === undefined) return;
      const scratch = prepareTaskScratch(root, task);
      const pricingPath = join(scratch, "src", "pricing.ts");
      expect(task.check(readFileSync(pricingPath, "utf8"), scratch)).toBe(false);
      copyFileSync(fileURLToPath(new URL("../src/pricing.ts", import.meta.url)), pricingPath);
      expect(task.check(readFileSync(pricingPath, "utf8"), scratch)).toBe(true);
      writeFileSync(join(scratch, "tests", "cache.test.ts"), "modified test");
      expect(task.check(readFileSync(pricingPath, "utf8"), scratch)).toBe(false);
    },
    240_000,
  );

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

  it("copies the same hypothetical tariff into isolated Pi model configs", () => {
    const root = mkdtempSync(join(tmpdir(), "foldpoint-price-scenario-"));
    const original = {
      providers: {
        deepseek: {
          modelOverrides: {
            "deepseek-flash": { contextWindow: 26_000, maxTokens: 4_000 },
          },
        },
      },
    };
    writeFileSync(join(root, "models.json"), JSON.stringify(original));
    const defaultDir = prepareAgentDir(root, "default", "off", "cache-read-60");
    const vetoDir = prepareAgentDir(root, "veto", "off", "cache-read-60");
    const priceAt = (dir: string) => {
      const config = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
      return config.providers.deepseek.modelOverrides["deepseek-flash"].cost;
    };
    expect(priceAt(defaultDir)).toEqual(TRIAL_PRICES["cache-read-60"]);
    expect(priceAt(vetoDir)).toEqual(TRIAL_PRICES["cache-read-60"]);
    expect(JSON.parse(readFileSync(join(root, "models.json"), "utf8"))).toEqual(original);
    expect(() => prepareAgentDir(root, "veto", "streaming", "cache-read-60")).toThrow(
      /requires cache warming off/,
    );
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
      unpricedCompactions: 0,
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
      priceScenario: "native",
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
    expect(report).not.toContain("ask 0.000000");
    expect(report).not.toContain("paired ask vs default:");
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
    const unpriced = renderComparison(
      [
        { ...result("default", 1, 10), cost: { ...cost(10), unpricedCompactions: 2 } },
        result("veto", 1, 8),
      ],
      TASKS.filter((task) => task.id === "sum"),
    );
    expect(unpriced).toContain(
      "paired veto vs default: 0/1 informative matched passing rep(s), n/a cost change; 1 unpriced-failure pair(s) excluded",
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
    expect(() =>
      renderComparison(
        [result("default", 1, 10), { ...result("veto", 1, 8), priceScenario: "cache-read-60" }],
        TASKS.filter((task) => task.id === "sum"),
      ),
    ).toThrow(/different hypothetical price scenarios/);
  });
});
