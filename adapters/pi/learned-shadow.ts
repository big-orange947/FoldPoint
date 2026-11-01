/** Host/RPC bridge only. Does not register Pi handlers, return cancel, or call compact(). */
import { chooseSupportedCycle, type LearnedCycleInput } from "../../tools/learned-cycle-choice";
import {
  PiImmediateRetentionLearner,
  type RetentionAssumptions,
  type RetentionBinding,
} from "../../tools/pi-retention-learner";
import {
  extractImmediateSummary,
  type ImmediateSummaryFeedback,
} from "../../tools/pi-summary-feedback";

export function createPiLearnedShadow(options: {
  binding: RetentionBinding;
  assumptions: RetentionAssumptions;
  /** Ordered journal; host owns storage/rotation. Do not silently truncate historical state. */
  loadHistory: () => readonly unknown[];
  appendFeedback: (sample: ImmediateSummaryFeedback) => void;
  writeEvaluation: (record: unknown) => void;
}) {
  const binding = { ...options.binding };
  const learner = new PiImmediateRetentionLearner(binding, options.assumptions);
  let blocked: string | null = null;
  let journalSize = 0;
  try {
    const history = options.loadHistory();
    if (!Array.isArray(history) || history.length > 4096) throw new Error("invalid journal");
    for (const row of history) {
      const result = learner.observe(row);
      if (result !== "accepted" && result !== "accepted-after-drift-reset")
        throw new Error("invalid history");
      journalSize++;
    }
  } catch {
    blocked = "history-unavailable-or-incompatible";
  }

  return {
    observeImmediate(result: unknown, order: { sequence: number; stage: number }) {
      if (blocked) return { accepted: false, reason: blocked };
      if (journalSize >= 4096) {
        blocked = "journal-limit";
        return { accepted: false, reason: blocked };
      }
      try {
        // Caller must provide successful, non-aborted RPC result. Native session_compact alone is insufficient.
        const sample = extractImmediateSummary(result, {
          sequence: order.sequence,
          stage: order.stage,
          binding: binding.profileBinding,
          compactorBinding: binding.compactorBinding,
        });
        if (!sample) return { accepted: false, reason: "missing-immediate-size" };
        const status = learner.observe(sample);
        if (status !== "accepted" && status !== "accepted-after-drift-reset")
          return { accepted: false, reason: status };
        // Failed persistence disables further evaluation; never pretend memory equals saved history.
        options.appendFeedback(sample);
        journalSize++;
        return { accepted: true, reason: status };
      } catch {
        blocked = "feedback-validation-or-storage-failed";
        return { accepted: false, reason: blocked };
      }
    },
    evaluate(input: Omit<LearnedCycleInput, "retention" | "expectedBasis">) {
      const common = {
        runner: "foldpoint.pi-learned-shadow.v1",
        applied: false,
        canDrivePolicy: false,
      };
      if (blocked) return { ...common, status: "blocked", reason: blocked };
      try {
        const state = learner.snapshot();
        const recommendation = chooseSupportedCycle({
          ...input,
          retention: state,
          expectedBasis: state.basis,
        });
        const record = {
          ...common,
          status: "evaluated",
          recommendation,
          support: {
            identifiable: state.identifiable,
            samples: state.retainedSamples,
            minBefore: state.minBefore,
            maxBefore: state.maxBefore,
            basis: state.basis,
          },
        };
        options.writeEvaluation(record);
        return record;
      } catch {
        blocked = "evaluation-or-storage-failed";
        return { ...common, status: "blocked", reason: blocked };
      }
    },
    snapshot() {
      return { ...learner.snapshot(), blocked, journalSize };
    },
  };
}
