/** Strict task scoring for the staged Pi trial; never part of FoldPoint's decision algorithm. */
export interface StageExpectation {
  expectedContains?: string;
  /** Exact JSON object fields expected from the assistant. Answers are never sent to Pi. */
  expectedAnswers?: Record<string, string>;
}

export function gradeStageResponse(
  answer: string,
  stopReason: string | undefined,
  expectation: StageExpectation,
): boolean {
  if (stopReason !== "stop") return false;
  if (expectation.expectedAnswers !== undefined) {
    const expected = expectation.expectedAnswers;
    const trimmed = answer
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const actual = parsed as Record<string, unknown>;
    const keys = Object.keys(expected).sort();
    if (keys.length === 0 || JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(keys))
      return false;
    return keys.every((key) => actual[key] === expected[key]);
  }
  return (
    expectation.expectedContains === undefined || answer.includes(expectation.expectedContains)
  );
}
