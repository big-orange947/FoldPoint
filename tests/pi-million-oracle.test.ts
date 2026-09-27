import { describe, expect, it } from "vitest";
import { gradeStageResponse } from "../tools/pi-million-oracle";

describe("staged trial answer oracle", () => {
  const expectedAnswers = {
    q1: "packages/ai/src/model.ts",
    q2: "packages/coding-agent/src/core/session.ts",
  };

  it("requires every exact field and allows a JSON code fence", () => {
    const value = JSON.stringify(expectedAnswers);
    expect(gradeStageResponse(value, "stop", { expectedAnswers })).toBe(true);
    expect(gradeStageResponse(`\`\`\`json\n${value}\n\`\`\``, "stop", { expectedAnswers })).toBe(
      true,
    );
    expect(gradeStageResponse(value, "error", { expectedAnswers })).toBe(false);
  });

  it("rejects omissions, extra fields and plausible but wrong paths", () => {
    expect(
      gradeStageResponse('{"q1":"packages/ai/src/model.ts"}', "stop", { expectedAnswers }),
    ).toBe(false);
    expect(
      gradeStageResponse(JSON.stringify({ ...expectedAnswers, q3: "other" }), "stop", {
        expectedAnswers,
      }),
    ).toBe(false);
    expect(
      gradeStageResponse(
        JSON.stringify({ ...expectedAnswers, q2: "packages/coding-agent/src/session.ts" }),
        "stop",
        { expectedAnswers },
      ),
    ).toBe(false);
  });

  it("keeps the older marker gate for loopback fixtures", () => {
    expect(gradeStageResponse("STAGE_OK", "stop", { expectedContains: "STAGE_OK" })).toBe(true);
    expect(gradeStageResponse("not yet", "stop", { expectedContains: "STAGE_OK" })).toBe(false);
  });
});
