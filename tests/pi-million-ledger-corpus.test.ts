import { describe, expect, it } from "vitest";
import { buildLedgerCorpus } from "../tools/pi-million-ledger-corpus";
import { gradeStageResponse } from "../tools/pi-million-oracle";

describe("controlled 1M project-ledger corpus", () => {
  it("requires earlier stages for the current state and keeps answers outside the prompt", () => {
    const stages = buildLedgerCorpus(12, 5_000);
    expect(stages).toHaveLength(12);
    for (const stage of stages) {
      expect(stage.prompt.length).toBeGreaterThanOrEqual(5_000);
      expect(stage.prompt).not.toContain(JSON.stringify(stage.expectedAnswers));
      expect(
        gradeStageResponse(JSON.stringify(stage.expectedAnswers), "stop", {
          expectedAnswers: stage.expectedAnswers,
        }),
      ).toBe(true);
    }
    expect(stages[0]?.expectedAnswers.aurora_owner).not.toBe(
      stages.at(-1)?.expectedAnswers.aurora_owner,
    );
    expect(stages[0]?.expectedAnswers.cedar_deadline).not.toBe(
      stages.at(-1)?.expectedAnswers.cedar_deadline,
    );
  });
});
