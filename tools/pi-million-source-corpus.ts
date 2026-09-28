/**
 * Freeze a staged, answerable reading task from a clean open-source TypeScript checkout.
 *
 * Stages are cut on file boundaries only - source text is never rewritten - and each stage is
 * small enough that one user message cannot walk a request across the provider's request
 * ceiling between Pi's threshold checks. See `SAFE_STAGE_CHARS` below.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SourceFile {
  path: string;
  content: string;
  exports: string[];
}

interface GeneratedStage {
  file: string;
  expectedAnswers: Record<string, string>;
  /** Stage length in UTF-16 code units, matching `prompt.length` below. */
  chars: number;
  /** SHA-256 of the stage text as written to disk, so a run can prove which bytes it read. */
  sha256: string;
}

/**
 * Default material per stage.
 *
 * A single user message is the unit Pi cannot interrupt: it only checks the compaction
 * threshold after a reply and before the next request. The first paid attempt staged ~950k
 * characters per message and the stage-4 request reached 1,114,489 tokens, over DeepSeek's
 * 1,048,576 ceiling (HTTP 400). ~100k characters is ~25k tokens on Pi's chars/4 estimate and
 * ~29k on DeepSeek's real tokenizer, so even with the ~13% underestimate a stage cannot walk
 * the request across the ceiling between two checks.
 */
export const SAFE_STAGE_CHARS = 100_000;
/** Refuse to build a corpus whose stages are known to be able to overshoot the request ceiling. */
export const MAX_TARGET_STAGE_CHARS = 200_000;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function buildSourceCorpus(
  sourceRoot: string,
  targetChars = SAFE_STAGE_CHARS,
): {
  commit: string;
  stages: Array<{ prompt: string; expectedAnswers: Record<string, string>; paths: string[] }>;
  sourceHash: string;
} {
  if (!Number.isSafeInteger(targetChars) || targetChars < 20_000)
    throw new Error("targetChars must be at least 20000");
  if (targetChars > MAX_TARGET_STAGE_CHARS)
    throw new Error(
      `targetChars ${targetChars} exceeds ${MAX_TARGET_STAGE_CHARS}: a stage that large can push a request past the 1,048,576-token ceiling between Pi's threshold checks`,
    );
  const root = resolve(sourceRoot);
  const dirty = git(root, "status", "--porcelain", "--", "packages").trim();
  if (dirty) throw new Error("Source packages are dirty; freeze a clean checkout first");
  const commit = git(root, "rev-parse", "HEAD").trim();
  const paths = git(root, "ls-files", "-z", "packages")
    .split("\0")
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".d.ts") &&
        !path.includes("/dist/") &&
        !path.includes("/node_modules/"),
    )
    .sort();
  if (paths.length < 20) throw new Error("Too few tracked TypeScript source files");
  const sourceHash = createHash("sha256");
  const files: SourceFile[] = paths.map((path) => {
    const content = readFileSync(join(root, path), "utf8");
    sourceHash.update(path).update("\0").update(content).update("\0");
    const exports = Array.from(
      content.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z_0-9]*)\b/g),
      (match) => match[1],
    ).filter((name): name is string => name !== undefined);
    return { path, content, exports };
  });
  const nameCounts = new Map<string, number>();
  for (const file of files) {
    for (const name of new Set(file.exports)) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const groups: SourceFile[][] = [];
  const skipped: Array<{ path: string; chars: number }> = [];
  let current: SourceFile[] = [];
  let size = 0;
  for (const file of files) {
    // A file bigger than the cap would become a stage on its own, and a stage that big can walk
    // a single request past DeepSeek's 1,048,576-token ceiling between two of Pi's threshold
    // checks - the failure that lost the first paid attempt (1,114,489 tokens, HTTP 400). Stage
    // size is the only safety valve, so an oversized file is left out rather than trimmed: the
    // oracle's answers come from the files that remain, so the task stays self-consistent.
    if (file.content.length > SAFE_STAGE_CHARS) {
      skipped.push({ path: file.path, chars: file.content.length });
      continue;
    }
    if (current.length > 0 && size + file.content.length > targetChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.content.length;
  }
  if (current.length > 0) groups.push(current);
  if (skipped.length > 0) {
    const detail = skipped.map((entry) => `${entry.path} (${entry.chars} chars)`).join(", ");
    console.error(`[corpus] excluded ${skipped.length} file(s) over the cap: ${detail}`);
  }
  if (groups.length < 6)
    throw new Error("Need at least six distinct stages for a multi-compaction trial");
  const candidates = groups.map((group) =>
    group
      .flatMap((file) =>
        file.exports
          .filter((name) => nameCounts.get(name) === 1)
          .map((name) => ({ name, path: file.path })),
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const pick = (
    groupIndex: number,
    offset: number,
    excludePath?: string,
  ): { name: string; path: string } => {
    for (let i = groupIndex; i >= 0; i -= 1) {
      const available = candidates[i];
      if (available && available.length > 0) {
        const distinct = available.filter((item) => item.path !== excludePath);
        const pool = distinct.length > 0 ? distinct : available;
        const selected = pool[offset % pool.length];
        if (selected !== undefined) return selected;
      }
    }
    throw new Error("No unique exported functions available for the oracle");
  };
  const stages = groups.map((group, index) => {
    const older = pick(Math.max(0, index - 4), index * 13 + 7);
    const recent = pick(Math.max(0, index - 1), index * 17 + 3, older.path);
    const expectedAnswers = { q1: older.path, q2: recent.path };
    const material = group
      .map(
        (file) =>
          `\n===== FILE ${file.path} BEGIN =====\n${file.content}\n===== FILE ${file.path} END =====\n`,
      )
      .join("");
    const prompt = [
      "你在持续阅读一个开源 TypeScript 项目的真实源码。这是本轮新增文件；之前轮次的资料仍在同一会话中。",
      "不要运行工具、不要猜测仓库路径。只根据本会话已提供的源码，回答最后两个定位问题。",
      material,
      "请找出下列两个导出函数分别定义在哪个仓库相对路径。只输出一个 JSON 对象，恰好包含 q1 和 q2 两个字符串字段，不要解释。",
      `q1: ${older.name}`,
      `q2: ${recent.name}`,
    ].join("\n");
    return { prompt, expectedAnswers, paths: group.map((file) => file.path) };
  });
  return { commit, stages, sourceHash: sourceHash.digest("hex") };
}

function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const source = value("--source");
  const output = value("--out");
  if (!source || !output)
    throw new Error(
      "Usage: tsx tools/pi-million-source-corpus.ts --source <clean Pi repo> --out <new directory> [--stage-chars N]",
    );
  const out = resolve(output);
  if (existsSync(out)) throw new Error("Refusing to overwrite an existing corpus directory");
  const targetChars = Number(value("--stage-chars") ?? SAFE_STAGE_CHARS);
  const corpus = buildSourceCorpus(source, targetChars);
  mkdirSync(out, { recursive: true });
  let totalChars = 0;
  const manifestStages: GeneratedStage[] = corpus.stages.map((stage, index) => {
    const file = `stage-${String(index + 1).padStart(2, "0")}.txt`;
    writeFileSync(join(out, file), stage.prompt, "utf8");
    totalChars += stage.prompt.length;
    return {
      file,
      expectedAnswers: stage.expectedAnswers,
      chars: stage.prompt.length,
      sha256: createHash("sha256").update(stage.prompt).digest("hex"),
    };
  });
  const largest = Math.max(...manifestStages.map((stage) => stage.chars));
  const manifest = {
    id: `pi-source-${corpus.commit.slice(0, 12)}`,
    stageCharsTarget: targetChars,
    stages: manifestStages,
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    join(out, "source-lock.json"),
    `${JSON.stringify({ sourceCommit: corpus.commit, sourceHash: corpus.sourceHash, stageCharsTarget: targetChars, totalChars, largestStageChars: largest, stages: corpus.stages.map((stage) => ({ sourceFiles: stage.paths.length, promptChars: stage.prompt.length, sha256: createHash("sha256").update(stage.prompt).digest("hex") })) }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `source commit: ${corpus.commit}\nstages: ${corpus.stages.length}\nstage chars: total ${totalChars}, largest ${largest}\nmanifest: ${join(out, "manifest.json")}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Corpus generation failed"}\n`,
    );
    process.exitCode = 1;
  }
}
