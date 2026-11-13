/** Small prequential model selector. Observations are host estimates, not provider token truth. */
export type SizeModel = { slope: number; intercept: number };
type Kind = "ratio" | "absolute" | "affine";
type Observation = { before: number; after: number };
export function predictSize(model: SizeModel, before: number) {
  if (
    !Number.isFinite(before) ||
    before <= 1 ||
    !Number.isFinite(model.slope) ||
    model.slope < 0 ||
    model.slope >= 1 ||
    !Number.isFinite(model.intercept) ||
    model.intercept < 0
  )
    throw new Error("invalid size model");
  return Math.max(
    1,
    Math.min(Math.floor(before) - 1, Math.round(model.slope * before + model.intercept)),
  );
}

export class RetainedSizeChoice {
  private observations: Observation[] = [];
  private errors: Partial<Record<Kind, number>>[] = [];
  private count = 0;
  private models(): Partial<Record<Kind, SizeModel>> {
    const xs = this.observations,
      n = xs.length;
    if (!n) return { ratio: { slope: 0.1, intercept: 0 } };
    const x = xs.reduce((s, r) => s + r.before, 0) / n,
      y = xs.reduce((s, r) => s + r.after, 0) / n;
    const result: Partial<Record<Kind, SizeModel>> = {
      ratio: { slope: xs.reduce((s, r) => s + r.after / r.before, 0) / n, intercept: 0 },
      absolute: { slope: 0, intercept: y },
    };
    if (
      n >= 3 &&
      Math.max(...xs.map((r) => r.before)) / Math.min(...xs.map((r) => r.before)) >= 1.2
    ) {
      const variance = xs.reduce((s, r) => s + (r.before - x) ** 2, 0);
      const slope = Math.max(
        0,
        Math.min(0.95, xs.reduce((s, r) => s + (r.before - x) * (r.after - y), 0) / variance),
      );
      result.affine = { slope, intercept: Math.max(0, y - slope * x) };
    }
    return result;
  }
  snapshot() {
    const models = this.models();
    const kinds = (Object.keys(models) as Kind[]).filter(
      (k) => k !== "affine" || this.errors.filter((e) => e[k] !== undefined).length >= 2,
    );
    const common = this.errors.filter((e) => kinds.every((k) => e[k] !== undefined));
    let selected: Kind = "ratio",
      score = Infinity;
    const scores: Partial<Record<Kind, number>> = {};
    for (const kind of kinds)
      if (common.length) {
        const error = common.reduce((s, e) => s + (e[kind] ?? 0), 0) / common.length;
        scores[kind] = error;
        if (error < score) {
          score = error;
          selected = kind;
        }
      }
    return {
      samples: this.count,
      kind: this.count === 0 ? ("prior" as const) : selected,
      model: models[selected] ?? { slope: 0.1, intercept: 0 },
      scores,
      scoredCommonSamples: common.length,
      observedRange: this.observations.length
        ? [
            Math.min(...this.observations.map((r) => r.before)),
            Math.max(...this.observations.map((r) => r.before)),
          ]
        : null,
    };
  }
  observe(before: number, after: number) {
    if (
      !Number.isSafeInteger(before) ||
      !Number.isSafeInteger(after) ||
      after <= 0 ||
      after >= before
    )
      throw new Error("invalid retained observation");
    const errors: Partial<Record<Kind, number>> = {};
    for (const [kind, model] of Object.entries(this.models()))
      errors[kind as Kind] = Math.abs(predictSize(model, before) / after - 1);
    this.errors.push(errors);
    this.observations.push({ before, after });
    this.count++;
    if (this.errors.length > 8) this.errors.shift();
    if (this.observations.length > 8) this.observations.shift();
  }
}
