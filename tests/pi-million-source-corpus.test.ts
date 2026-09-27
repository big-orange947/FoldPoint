import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSourceCorpus } from "../tools/pi-million-source-corpus";

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "foldpoint-source-corpus-"));
  const sourceDir = join(root, "packages", "sample", "src");
  mkdirSync(sourceDir, { recursive: true });
  for (let index = 0; index < 24; index += 1) {
    const name = `answerFunction${String(index).padStart(2, "0")}`;
    writeFileSync(
      join(sourceDir, `file-${String(index).padStart(2, "0")}.ts`),
      `export function ${name}(): number { return ${index}; }\n` +
        "// Real source-sized content.\n".repeat(1200),
    );
  }
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "-c", "core.autocrlf=false", "add", "packages"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  return root;
}

describe("frozen Pi source reading corpus", () => {
  it("builds deterministic answerable stages and rejects dirty source", () => {
    const repo = fixtureRepo();
    const first = buildSourceCorpus(repo, 100_000);
    const second = buildSourceCorpus(repo, 100_000);
    expect(first.sourceHash).toBe(second.sourceHash);
    expect(first.stages).toEqual(second.stages);
    expect(first.stages.length).toBeGreaterThanOrEqual(6);
    for (const [index, stage] of first.stages.entries()) {
      const available = first.stages.slice(0, index + 1).flatMap((item) => item.paths);
      expect(available).toContain(stage.expectedAnswers.q1);
      expect(available).toContain(stage.expectedAnswers.q2);
      const question = stage.prompt.slice(stage.prompt.lastIndexOf("请找出下列"));
      expect(question).not.toContain(stage.expectedAnswers.q1 ?? "impossible");
    }
    writeFileSync(join(repo, "packages", "sample", "src", "file-00.ts"), "changed\n");
    expect(() => buildSourceCorpus(repo, 100_000)).toThrow(/dirty/);
  });
});
