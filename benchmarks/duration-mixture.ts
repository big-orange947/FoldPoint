/** Frozen illustrative prior. New combinations are run only after fixing the model. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateRuntimeDuration } from "../src/index";
import { warmCases, warmRenewalReport } from "./warm-renewal";

export const DURATION_PRIOR = [
  { weight: 0.8, continuationProbability: 0.8 },
  { weight: 0.2, continuationProbability: 0.98 },
] as const;

export function durationCases() {
  const old = warmCases();
  const base = old[0];
  if (!base) throw new Error("Missing base fixture");
  const fresh = [99, 210].flatMap((steps) =>
    [19000, 37000].flatMap((growthPerStep) =>
      [0.065, 0.23].map((retentionRatio) => ({
        ...base,
        id: `heldout-fresh-${steps}-${growthPerStep}-${retentionRatio}`,
        seed: 277,
        steps,
        growthPerStep,
        growthJitter: 3500,
        compactor: { retentionRatio, outputRatio: 0.004, successRate: 1 },
      })),
    ),
  );
  return [...old, ...fresh];
}

export function durationMixtureReport(cases = durationCases(), timingMargin = false) {
  const raw = warmRenewalReport(cases, undefined, {
    durationComponents: DURATION_PRIOR,
    timingMargin,
  });
  const rows = raw.rows.map((r) => ({
    ...r,
    suite: r.id.startsWith("heldout-floor-")
      ? "floor-stress"
      : r.id.startsWith("heldout-margin-")
        ? "validation-warm"
        : r.id.startsWith("heldout-fresh-")
          ? timingMargin
            ? "seen-regression"
            : "fresh-warm"
          : r.suite === "heldout-warm"
            ? "seen-regression"
            : r.suite,
  }));
  const summary = raw.profiles.flatMap((p) =>
    [
      "dev-warm-long",
      "fresh-warm",
      "seen-regression",
      "near-end",
      "cold-regression",
      ...(timingMargin ? ["validation-warm", "floor-stress"] : []),
    ].flatMap((suite) =>
      (timingMargin
        ? ["durationMixture", "durationTiming"]
        : ["geometric256", "durationMixture", "frozenDuration"]
      ).flatMap((candidate) =>
        (timingMargin
          ? ["fixed60", "frozenFixed", "durationMixture"]
          : ["fixed60", "frozenFixed", "renewalWeighted"]
        ).map((baseline) => {
          const selected = rows.filter(
            (r) =>
              r.profile === p.id &&
              (suite === "dev-warm-long"
                ? r.suite === "dev-warm" && r.calls === 140
                : r.suite === suite),
          );
          const comparator =
            baseline === "frozenFixed" ? (raw.frozenFixed[p.id] ?? "fixed60") : baseline;
          const get = (r: (typeof rows)[number], name: string) => {
            const a = r.arms[name];
            if (!a) throw new Error("Missing arm");
            return a;
          };
          const compared = selected.filter(
            (r) => get(r, candidate).attempts > 0 || get(r, comparator).attempts > 0,
          );
          const ds = compared.map((r) => get(r, candidate).cost / get(r, comparator).cost - 1);
          // Endpoint is scoring-only, never passed to the policy.
          const forecastSamples = selected.reduce(
            (sum, r) => sum + (r.diagnostics[candidate]?.forecastSamples ?? 0),
            0,
          );
          const brierSum = selected.reduce(
            (sum, r) => sum + (r.diagnostics[candidate]?.brierSum ?? 0),
            0,
          );
          return {
            profile: p.id,
            suite,
            candidate,
            baseline,
            comparator,
            cases: selected.length,
            compared: compared.length,
            excluded: selected.length - compared.length,
            wins: ds.filter((d) => d < -1e-9).length,
            losses: ds.filter((d) => d > 1e-9).length,
            ties: ds.filter((d) => Math.abs(d) <= 1e-9).length,
            mean: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null,
            worst: ds.length ? Math.max(...ds) : null,
            brier: forecastSamples ? brierSum / forecastSamples : null,
            forecasts: forecastSamples,
            attempts: selected.reduce((s, r) => s + get(r, candidate).attempts, 0),
            overflow: selected.reduce((s, r) => s + get(r, candidate).overflow, 0),
          };
        }),
      ),
    ),
  );
  return {
    kind: "foldpoint.duration-mixture.v1",
    paidCalls: 0,
    prior: DURATION_PRIOR,
    profiles: raw.profiles,
    frozenFixed: raw.frozenFixed,
    casesPerProfile: rows.length / raw.profiles.length,
    priorEvolution: [0, 5, 20, 60, 140].map((completedCalls) => ({
      completedCalls,
      ...estimateRuntimeDuration({ completedCalls, components: DURATION_PRIOR }, 256),
    })),
    limitations: [
      ...raw.limitations,
      "先验是显式未校准的研究假设，不是训练得到；混合模型并不证明已持续的任务一定更长，任务分布变化会失效。",
      "对存活至某时点的任务做条件更新；摘要/预热和只读决策不增加年龄，不使用本轮真实总长度。",
      "概率压力检查在混合模型中向最短成分移动 5% 后验质量；与旧版固定 q 减 0.05 不同，模型和压力契约的改动不能混为纯年龄收益。",
      "三个新增对照均用 256 调用预测上限，保留原 64 调用对照；截断尾部超过 5% 仍拒绝经济触发。",
      "frozenDuration 采用同样的先验曲线和压力规则，但年龄永远固定为零，分离条件更新的贡献；它不代表推荐用法。",
      "Brier 是这些固定长度合成轨迹的逐调用分数，不是完整校准证明；长任务占更多调用，需同时检查临近结束。",
    ],
    summary,
    rows,
  };
}

export function renderDuration(report: ReturnType<typeof durationMixtureReport>) {
  return [
    "# 持续时间混合模型：零付费暖缓存实验",
    "",
    "固定显式先验，不按供应商调参。负数更省。",
    "",
    "| 价格 | 分组 | 分支 | 对照 | 胜/负/平 | 平均变化 | 最差变化 | Brier |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary
      .filter(
        (s) =>
          s.candidate === "durationMixture" &&
          ["dev-warm-long", "fresh-warm", "near-end"].includes(s.suite) &&
          s.baseline !== "renewalWeighted",
      )
      .map(
        (s) =>
          `| ${s.profile} | ${s.suite} | ${s.candidate} | ${s.baseline}/${s.comparator} | ${s.wins}/${s.losses}/${s.ties} | ${s.mean === null ? "—" : `${(s.mean * 100).toFixed(2)}%`} | ${s.worst === null ? "—" : `${(s.worst * 100).toFixed(2)}%`} | ${s.brier?.toFixed(4) ?? "—"} |`,
      ),
    "",
    "## 限制",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = durationMixtureReport();
  const path = fileURLToPath(new URL("./reports/duration-mixture.json", import.meta.url));
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
  writeFileSync(new URL("./duration-mixture.md", import.meta.url), renderDuration(report));
  console.log(
    JSON.stringify(
      report.summary.filter(
        (s) =>
          s.candidate === "durationMixture" &&
          s.suite === "dev-warm-long" &&
          s.baseline === "fixed60",
      ),
      null,
      2,
    ),
  );
}
