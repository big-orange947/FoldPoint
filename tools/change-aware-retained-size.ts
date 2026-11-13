/** Research only. Confirm two same-direction large residuals before discarding old history. */
import { predictSize, RetainedSizeChoice } from "./retained-size-choice";

type Sample = { before: number; after: number };
export class ChangeAwareRetainedSize extends RetainedSizeChoice {
  private live = new RetainedSizeChoice();
  private residuals: number[] = [];
  private pending: (Sample & { direction: number }) | undefined;
  private observed = 0;
  private resets: number[] = [];
  override snapshot() {
    return this.live.snapshot();
  }
  diagnostics() {
    return { observed: this.observed, resets: this.resets.slice() };
  }
  override observe(before: number, after: number) {
    if (
      !Number.isSafeInteger(before) ||
      !Number.isSafeInteger(after) ||
      after <= 0 ||
      after >= before
    )
      throw new Error("invalid retained observation");
    const snapshot = this.live.snapshot(),
      residual = Math.log(after / predictSize(snapshot.model, before));
    const sorted = [...this.residuals].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length
      ? sorted.length % 2
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : 0;
    const threshold = Math.max(Math.log(1.5), median * 3);
    const large = snapshot.samples >= 3 && Math.abs(residual) > threshold;
    this.observed++;
    if (large && this.pending && this.pending.direction === Math.sign(residual)) {
      this.live = new RetainedSizeChoice();
      this.live.observe(this.pending.before, this.pending.after);
      this.live.observe(before, after);
      this.resets.push(this.observed);
      this.residuals = [];
      this.pending = undefined;
      return;
    }
    this.pending = large ? { before, after, direction: Math.sign(residual) } : undefined;
    this.live.observe(before, after);
    if (snapshot.samples >= 3) {
      this.residuals.push(Math.abs(residual));
      if (this.residuals.length > 8) this.residuals.shift();
    }
  }
}
