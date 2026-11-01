import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPiLearnedShadow } from "../adapters/pi/learned-shadow";
import { openPiShadowJournal } from "../tools/pi-shadow-journal";

const binding = {
  profileBinding: "a".repeat(64),
  compactorBinding: "b".repeat(64),
  estimatorId: "pi/v1",
};
const assumptions = { beforeErrorTokens: 0, afterErrorTokens: 0, driftToleranceRatio: 0.05 };
const path = () => join(mkdtempSync(join(tmpdir(), "fp-shadow-")), "feedback.jsonl");

it("reopens a synchronized journal and reconstructs shadow state without saving host content", () => {
  const file = path();
  const j = openPiShadowJournal(file, binding, assumptions);
  const make = (journal: ReturnType<typeof openPiShadowJournal>) =>
    createPiLearnedShadow({
      binding,
      assumptions,
      loadHistory: journal.loadHistory,
      appendFeedback: journal.appendFeedback,
      writeEvaluation: () => {},
    });
  const first = make(j);
  for (const [i, before] of [100000, 350000, 700000].entries()) {
    expect(
      first.observeImmediate(
        { tokensBefore: before, estimatedTokensAfter: 30000, summary: "secret-text" },
        { sequence: i + 1, stage: i + 1 },
      ).accepted,
    ).toBe(true);
  }
  const snapshot = first.snapshot();
  j.close();
  expect(readFileSync(file, "utf8")).not.toContain("secret-text");
  const reopened = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { openPiShadowJournal } from './tools/pi-shadow-journal.ts';
    import { createPiLearnedShadow } from './adapters/pi/learned-shadow.ts';
    const binding = ${JSON.stringify(binding)};
    const assumptions = ${JSON.stringify(assumptions)};
    const journal = openPiShadowJournal(process.argv[1], binding, assumptions);
    const shadow = createPiLearnedShadow({ binding, assumptions, loadHistory: journal.loadHistory,
      appendFeedback: journal.appendFeedback, writeEvaluation: () => {} });
    process.stdout.write(JSON.stringify(shadow.snapshot()));
    journal.close();
  `,
      file,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(reopened)).toEqual(snapshot);
  const reloaded = openPiShadowJournal(file, binding, assumptions);
  expect(make(reloaded).snapshot()).toEqual(snapshot);
  reloaded.close();
  expect(() =>
    openPiShadowJournal(file, binding, { ...assumptions, afterErrorTokens: 1 }),
  ).toThrow();
});

it("rejects interrupted records and detects an external change before appending", () => {
  const file = path();
  const journal = openPiShadowJournal(file, binding, assumptions);
  appendFileSync(file, "{");
  const shadow = createPiLearnedShadow({
    binding,
    assumptions,
    loadHistory: journal.loadHistory,
    appendFeedback: journal.appendFeedback,
    writeEvaluation: () => {},
  });
  expect(
    shadow.observeImmediate(
      { tokensBefore: 100, estimatedTokensAfter: 20 },
      { sequence: 1, stage: 1 },
    ),
  ).toMatchObject({ accepted: false, reason: "feedback-validation-or-storage-failed" });
  journal.close();
  expect(() => openPiShadowJournal(file, binding, assumptions)).toThrow();
  writeFileSync(file, Buffer.from([0xff]));
  expect(() => openPiShadowJournal(file, binding, assumptions)).toThrow();
});
