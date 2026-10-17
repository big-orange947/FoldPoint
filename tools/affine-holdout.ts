/** Prospective synthetic prediction test. No provider, timing policy or oracle feedback. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ApproximateFeedback, ApproximateRetentionTracker } from "./approximate-feedback";
import { assertFeedbackSource } from "./feedback-prequential";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

export interface HoldoutCase {
  id: string;
  path: "irregular" | "narrow" | "ramp" | "cycle";
  ratio: number;
  floor: number;
  noise: number;
  error: number;
  change?: { at: number; ratio: number; floor: number };
  driftPerStep?: number;
  correlatedBias?: number;
  bias?: number;
  delayed?: "known" | "unknown";
  failEvery?: number;
}
export const HOLDOUT_PLAN = JSON.parse(
  readFileSync(new URL("../benchmarks/affine-holdout-plan.json", import.meta.url), "utf8"),
) as { cases: HoldoutCase[]; seeds: number[]; steps: number; candidateCommit: string };
export const CANDIDATE_SHA = "e1efddd1c7dcbfb853b5a9df76681353dfdd6cf39bb976c7f0cf4f2d996faef3";
export function sourceHash(source: string) {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
}
export function assertHoldoutCandidate(source: string) {
  if (sourceHash(source) !== CANDIDATE_SHA) throw new Error("Frozen holdout candidate changed");
}

type Frame = { feedback: ApproximateFeedback; truth: number | null };
export function makeHoldoutFrames(
  c: HoldoutCase,
  seed: number,
  steps = HOLDOUT_PLAN.steps,
): Frame[] {
  if (!Number.isInteger(steps) || steps < 1 || steps > 1000) throw new RangeError("invalid steps");
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: steps }, (_, i) => {
    // A fixed four draws per attempt: failures cannot shift future growth or measurement errors.
    const u = random();
    const v = random();
    const w = random();
    const z = random();
    const latentBefore = Math.round(
      c.path === "irregular"
        ? 25_000 + u * 915_000
        : c.path === "narrow"
          ? 590_000 + u * 40_000
          : c.path === "ramp"
            ? 220_000 + i * 10_000 + u * 6_000
            : 520_000 + (i % 8) * 16_000 + u * 8_000,
    );
    const phase = c.change && i >= c.change.at ? c.change : c;
    const truth = Math.round(
      latentBefore * (phase.ratio + i * (c.driftPerStep ?? 0)) + phase.floor,
    );
    const sharedBias = (c.correlatedBias ?? 0) * Math.sin(i / 5);
    const before = Math.round(latentBefore * (1 + sharedBias + c.noise * (v - 0.5)));
    const growth = c.delayed ? Math.round(5_000 + w * 35_000) : 0;
    const success = !c.failEvery || (i + 1) % c.failEvery !== 0;
    const after = success
      ? Math.round((truth + growth) * (1 + sharedBias + (c.bias ?? 0) + c.noise * (2 * z - 1)))
      : before;
    return {
      truth: success ? truth : null,
      feedback: {
        basisKey: "holdout-host/v1",
        sequence: i + 1,
        success,
        source: c.delayed ? "host-delayed" : "host-immediate",
        beforeTokens: before,
        afterTokens: after,
        beforeErrorTokens: Math.ceil(before * c.error),
        afterErrorTokens: Math.ceil(after * c.error),
        ...(c.delayed === "known"
          ? {
              growth: {
                lowerTokens: Math.floor(growth * 0.8),
                upperTokens: Math.ceil(growth * 1.2),
              },
            }
          : {}),
      },
    };
  });
}

export const ARMS = ["fixed10", "lastObserved", "pointEma", "approximate", "affine"] as const;
export function replayHoldout(frames: readonly Frame[]) {
  const approximate = new ApproximateRetentionTracker("holdout-host/v1");
  const affine = new UncertainAffineFeedback("holdout-host/v1");
  let last = 0.1;
  let ema: number | undefined;
  const rows = frames.map(({ feedback: o, truth }) => {
    // Only pre-request input is visible when predictions are issued. No current outcome or case ID.
    const interval = affine.predict(o.beforeTokens, o.beforeErrorTokens);
    const predictions = {
      fixed10: 0.1 * o.beforeTokens,
      lastObserved: last * o.beforeTokens,
      pointEma: (ema ?? 0.1) * o.beforeTokens,
      approximate:
        approximate.predict(o.beforeTokens, o.beforeErrorTokens)?.pointTokens ??
        0.1 * o.beforeTokens,
      affine: interval?.pointTokens ?? 0.1 * o.beforeTokens,
    };
    const admission = approximate.observe(o);
    if (affine.observe(o) !== admission) throw new Error("Feedback eligibility diverged");
    if (admission === "accepted-approximate") {
      const midpoint = o.growth ? (o.growth.lowerTokens + o.growth.upperTokens) / 2 : 0;
      last = Math.max(0, o.afterTokens - midpoint) / o.beforeTokens;
      ema = ema === undefined ? last : ema + 0.25 * (last - ema);
    }
    return { predictions, interval, admission, truth };
  });
  const scored = rows.filter((r) => r.truth !== null);
  const warm = scored.slice(3);
  const metrics = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      {
        samples: scored.length,
        mae: scored.length
          ? scored.reduce((s, r) => s + Math.abs(r.predictions[arm] - (r.truth ?? 0)), 0) /
            scored.length
          : null,
        relativeMae: scored.length
          ? scored.reduce(
              (s, r) => s + Math.abs(r.predictions[arm] - (r.truth ?? 0)) / (r.truth ?? 1),
              0,
            ) / scored.length
          : null,
        warmMae: warm.length
          ? warm.reduce((s, r) => s + Math.abs(r.predictions[arm] - (r.truth ?? 0)), 0) /
            warm.length
          : null,
      },
    ]),
  );
  const intervals = scored.filter((r) => r.interval !== null);
  return {
    rows,
    metrics,
    fitted: scored.filter((r) => r.interval?.source === "weighted-affine").length,
    fallback: scored.filter((r) => r.interval?.source !== "weighted-affine").length,
    intervalSamples: intervals.length,
    covered: intervals.filter(
      (r) =>
        r.interval &&
        (r.truth ?? 0) >= r.interval.lowerTokens &&
        (r.truth ?? 0) <= r.interval.upperTokens,
    ).length,
    meanRelativeWidth: intervals.length
      ? intervals.reduce(
          (s, r) =>
            s + ((r.interval?.upperTokens ?? 0) - (r.interval?.lowerTokens ?? 0)) / (r.truth ?? 1),
          0,
        ) / intervals.length
      : null,
    rejected: rows.filter((r) => r.admission !== "accepted-approximate").length,
  };
}

export function runAffineHoldout() {
  if (
    sourceHash(
      readFileSync(new URL("../benchmarks/affine-holdout-plan.json", import.meta.url), "utf8"),
    ) !== "02929b756a9b834a6d4f91c5b74da6439844064793ba7b77b89be5b2f5e69b37"
  )
    throw new Error("Preregistered holdout plan changed");
  assertHoldoutCandidate(
    readFileSync(new URL("./uncertain-affine-feedback.ts", import.meta.url), "utf8"),
  );
  assertFeedbackSource(readFileSync(new URL("./approximate-feedback.ts", import.meta.url), "utf8"));
  const runs = HOLDOUT_PLAN.cases.flatMap((c) =>
    HOLDOUT_PLAN.seeds.map((seed) => ({
      id: c.id,
      seed,
      ...replayHoldout(makeHoldoutFrames(c, seed)),
    })),
  );
  const aggregate = (selected: typeof runs) =>
    Object.fromEntries(
      ARMS.map((arm) => [
        arm,
        {
          mae: selected.reduce((s, r) => s + (r.metrics[arm]?.mae ?? 0), 0) / selected.length,
          relativeMae:
            selected.reduce((s, r) => s + (r.metrics[arm]?.relativeMae ?? 0), 0) / selected.length,
          warmMae:
            selected.reduce((s, r) => s + (r.metrics[arm]?.warmMae ?? 0), 0) / selected.length,
        },
      ]),
    );
  return {
    runner: "foldpoint.affine-holdout.v1",
    paidCalls: 0,
    candidateSha256: CANDIDATE_SHA,
    planSha256: sourceHash(
      readFileSync(new URL("../benchmarks/affine-holdout-plan.json", import.meta.url), "utf8"),
    ),
    candidateCommit: HOLDOUT_PLAN.candidateCommit,
    preregistrationCommit: "712446a",
    summary: {
      streams: runs.length,
      attempts: runs.length * HOLDOUT_PLAN.steps,
      samples: runs.reduce((s, r) => s + (r.metrics.affine?.samples ?? 0), 0),
      metrics: aggregate(runs),
      versus: Object.fromEntries(
        ARMS.filter((a) => a !== "affine").map((a) => [
          a,
          {
            wins: runs.filter((r) => (r.metrics.affine?.mae ?? 0) < (r.metrics[a]?.mae ?? 0) - 1e-9)
              .length,
            losses: runs.filter(
              (r) => (r.metrics.affine?.mae ?? 0) > (r.metrics[a]?.mae ?? 0) + 1e-9,
            ).length,
          },
        ]),
      ),
    },
    groups: HOLDOUT_PLAN.cases.map((c) => {
      const selected = runs.filter((r) => r.id === c.id);
      return {
        id: c.id,
        metrics: aggregate(selected),
        fitted: selected.reduce((s, r) => s + r.fitted, 0),
        fallback: selected.reduce((s, r) => s + r.fallback, 0),
        intervals: selected.reduce((s, r) => s + r.intervalSamples, 0),
        covered: selected.reduce((s, r) => s + r.covered, 0),
        width:
          selected[0]?.meanRelativeWidth === null
            ? null
            : selected.reduce((s, r) => s + (r.meanRelativeWidth ?? 0), 0) / selected.length,
      };
    }),
    runs,
  };
}

export function renderAffineHoldout(r: ReturnType<typeof runAffineHoldout>) {
  return [
    "# 冻结候选的前瞻合成留出检查",
    "",
    `先提交计划 712446a，再执行。候选冻结于 ${r.candidateCommit}，未调参。${r.summary.streams} 条流、${r.summary.attempts} 次尝试、${r.summary.samples} 次成功结果；付费调用 0。`,
    `候选 SHA-256：${r.candidateSha256}；计划 SHA-256：${r.planSha256}。`,
    "",
    "| 场景 | 固定10% MAE | 上次比例 | 普通EMA | 旧近似EMA | 底座＋比例 | 拟合/回退次数 | 范围覆盖/分母 | 宽度/真值 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...r.groups.map(
      (g) =>
        `| ${g.id} | ${ARMS.map((a) => g.metrics[a]?.mae.toFixed(0)).join(" | ")} | ${g.fitted}/${g.fallback} | ${g.covered}/${g.intervals} | ${g.width === null ? "—" : `${(g.width * 100).toFixed(1)}%`} |`,
    ),
    "",
    "| 方法 | 流等权 MAE | 流等权相对绝对误差 | 共同暖段 MAE（排除前3次成功） |",
    "| --- | ---: | ---: | ---: |",
    ...ARMS.map(
      (a) =>
        `| ${a} | ${r.summary.metrics[a]?.mae.toFixed(0)} | ${((r.summary.metrics[a]?.relativeMae ?? 0) * 100).toFixed(1)}% | ${r.summary.metrics[a]?.warmMae.toFixed(0)} |`,
    ),
    "",
    ...Object.entries(r.summary.versus).map(
      ([a, v]) =>
        `- 相比 ${a}：${v.wins} 胜、${v.losses} 负、${r.summary.streams - v.wins - v.losses} 平（逐流 MAE）。`,
    ),
    "",
    "## 初次结果解读",
    "",
    "新候选总体误差改善，但窄范围两类流完全未拟合，回退的上次比例比EMA更嘈杂；重复接近阈值和可变延迟增长也退步。这些更贴近压缩触发处的输入分布，不能被宽跨度流的收益掩盖。底座切换和不规则输入的改善支持结构假设，不支持直接推广默认策略。",
    "",
    "误差预算低估时仍有明显偏差，范围覆盖也失效；多数其他范围依然很宽。下一步优先在现有完整账单模拟中检查窄范围与回退的实际影响，不为了提升本留出集分数进行场景选择或事后调参。后续若修改候选，此集即成为已见回归集，不再称独立留出。",
    "",
    "## 口径与边界",
    "",
    "- 固定候选、12类场景、3个新种子、64步；没有按结果选择方法、排除负例或调整参数。所有方法先预测再接收相同反馈，冷启动/拒绝反馈后的回退照常评分。失败尝试不评分，但不改变后续随机流。",
    "- 这是本项目自行设计的前瞻合成留出，不是外部盲测或真实任务；仍有生成器设计偏差，同类种子并非独立真实用户样本，不做显著性推断。",
    "- 不再复用旧的四点输入循环。加入窄输入范围、缓慢增长、重复接近阈值、底座切换、渐变、相关误差和可变延迟增长。",
    "- 评测真值是合成潜变量；模型只收到宿主近似元数据，不收到真值、场景ID、变更点或任务终点。近似反馈不变成provider精确用量。",
    "- 宏平均按流等权；相对误差及共同暖段另外列出，避免大输入流主导唯一结论。范围覆盖与宽度同时报告，不视为置信区间。",
    "- 只检验体积预测。即使误差下降，也不证明固定60%或Pi原生的费用被击败；没有更改核心、Pi默认策略或验证任务质量。",
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/affine-holdout.ts");
  const result = runAffineHoldout();
  writeFileSync(
    new URL("../benchmarks/affine-holdout.md", import.meta.url),
    renderAffineHoldout(result),
  );
  console.log(JSON.stringify(result.summary, null, 2));
}
