/** Compare full path bills; change only the uncertainty-margin scale. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durationCases, durationMixtureReport } from "./duration-mixture";

export function timingCases() {
  const seen = durationCases();
  const base = seen[0];
  if (!base) throw new Error("Missing fixture");
  const validation = [87, 230].flatMap((steps) =>
    [25000, 44000].flatMap((growthPerStep) =>
      [0.09, 0.24].map((retentionRatio) => ({
        ...base,
        id: `heldout-margin-${steps}-${growthPerStep}-${retentionRatio}`,
        seed: 389,
        steps,
        growthPerStep,
        growthJitter: 3000,
        compactor: { retentionRatio, outputRatio: 0.005, successRate: 1 },
      })),
    ),
  );
  const floorStress = [180, 260].flatMap((steps) =>
    [22000, 41000].flatMap((growthPerStep) =>
      [20000, 50000].map((retainedFloorTokens) => ({
        ...base,
        id: `heldout-floor-${steps}-${growthPerStep}-${retainedFloorTokens}`,
        seed: 443,
        steps,
        growthPerStep,
        growthJitter: 4500,
        compactor: {
          retentionRatio: 0.1,
          outputRatio: 0.002,
          successRate: 1,
          retainedFloorTokens,
          outputFloorTokens: 2000,
        },
      })),
    ),
  );
  return [...seen, ...validation, ...floorStress];
}

export function timingMarginReport() {
  const raw = durationMixtureReport(timingCases(), true);
  return compactTimingReport({
    ...raw,
    kind: "foldpoint.timing-margin.v1",
    margin: {
      ratio: 0.1,
      oldScale: "entire-summary-cost",
      newScale: "current-replay-cost + growth * summary-cost-per-token",
    },
    limitations: [
      ...raw.limitations,
      "完整 NOW/WAIT 路径仍逐次计入摘要和重建；仅修改等待一轮可行时的余量尺度，不删除共同费用，不把全部摘要当作免费。",
      "模型、q、先验、压力和风险预算均未改；固定对照仍从原开发集选择后冻结，没有把固定百分比输入算法。",
      "以前的 fresh-warm 现在标 seen-regression；八个新组合只用于首次验证，已看过后不能反复调参称盲测。",
      "费用更低与摘要更多不代表任务质量不变；默认核心/Pi 未切换。成本拆分采用共同模拟计费，不是供应商真实账单。",
      "floor-stress 设置 20k/50k 保留底座与 2k 最低摘要输出，只通过实际压缩观测反馈，不提前把真实底座给策略；旧 fixture 默认底座为零。",
    ],
  });
}

/** Mechanical report projection; retain all cases and every reported comparator bill. */
export function compactTimingReport<T extends ReturnType<typeof durationMixtureReport>>(report: T) {
  const keep = new Set(["fixed50", "fixed60", "fixed70", "durationMixture", "durationTiming"]);
  return {
    ...report,
    summary: report.summary.filter(
      (s) =>
        ["durationMixture", "durationTiming"].includes(s.candidate) &&
        ["fixed60", "frozenFixed", "durationMixture"].includes(s.baseline),
    ),
    rows: report.rows.map((r) => ({
      ...r,
      arms: Object.fromEntries(
        Object.entries(r.arms)
          .filter(([name]) => keep.has(name))
          .map(([name, a]) => {
            const b = a.costBreakdown;
            return [
              name,
              {
                ...a,
                ...(b
                  ? {
                      costBreakdown: {
                        summaryCost: b.summaryCost,
                        firstPostCompactInputCost: b.firstPostCompactInputCost,
                        otherOrdinaryInputCost: b.otherOrdinaryInputCost,
                        ordinaryOutputCost: b.ordinaryOutputCost,
                        minimumGap: b.minimumGap,
                        adjacentSuccessfulPairs: b.adjacentSuccessfulPairs,
                      },
                    }
                  : {}),
              },
            ];
          }),
      ),
      diagnostics: Object.fromEntries(
        Object.entries(r.diagnostics).filter(([name]) =>
          ["durationMixture", "durationTiming"].includes(name),
        ),
      ),
    })),
  };
}

export function renderTiming(report: ReturnType<typeof timingMarginReport>) {
  return [
    "# 时机余量与费用归因：暖缓存实验",
    "",
    "负数更省，余量比例固定为 10%，仅改余量尺度。",
    "",
    "| 价格 | 分组 | 对照 | 胜/负/平 | 平均变化 | 最差变化 | 压缩次数 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary
      .filter(
        (s) =>
          s.candidate === "durationTiming" &&
          ["dev-warm-long", "validation-warm", "floor-stress", "near-end"].includes(s.suite) &&
          s.baseline !== "renewalWeighted",
      )
      .map(
        (s) =>
          `| ${s.profile} | ${s.suite} | ${s.baseline}/${s.comparator} | ${s.wins}/${s.losses}/${s.ties} | ${s.mean === null ? "—" : `${(s.mean * 100).toFixed(2)}%`} | ${s.worst === null ? "—" : `${(s.worst * 100).toFixed(2)}%`} | ${s.attempts} |`,
      ),
    "",
    "## 限制",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = fileURLToPath(new URL("./reports/timing-margin.json", import.meta.url));
  if (process.argv[2] && process.argv[2] !== "--format-existing") throw new Error("Unknown option");
  const report =
    process.argv[2] === "--format-existing"
      ? compactTimingReport(
          JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof timingMarginReport>,
        )
      : timingMarginReport();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url)),
      "format",
      "--write",
      path,
    ],
    { stdio: "pipe" },
  );
  writeFileSync(new URL("./timing-margin.md", import.meta.url), renderTiming(report));
  console.log(
    JSON.stringify(
      report.summary.filter(
        (s) =>
          s.candidate === "durationTiming" &&
          s.suite === "dev-warm-long" &&
          s.baseline === "fixed60",
      ),
      null,
      2,
    ),
  );
}
