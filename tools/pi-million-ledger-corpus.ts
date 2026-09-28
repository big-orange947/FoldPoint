/** A frozen, controlled long-running task for the real 1M Pi trial. Synthetic, not a user trace. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECTS = ["Aurora", "Boreal", "Cedar", "Delta"] as const;
const OWNERS = ["Amina", "Basil", "Clara", "Dario", "Elena", "Farah"] as const;
const TARGET_CHARS = 90_000;
const STAGE_COUNT = 140;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Invalid project-ledger fixture state");
  return value;
}

export function buildLedgerCorpus(stageCount = STAGE_COUNT, targetChars = TARGET_CHARS) {
  if (!Number.isSafeInteger(stageCount) || stageCount < 3) throw new Error("Invalid stage count");
  if (!Number.isSafeInteger(targetChars) || targetChars < 4_000 || targetChars > 100_000)
    throw new Error("Stage size must be between 4000 and 100000 characters");
  const owner = new Map<string, string>(
    PROJECTS.map((project, index) => [project, required(OWNERS[index])]),
  );
  const deadline = new Map<string, string>(
    PROJECTS.map((project, index) => [project, `2027-0${index + 3}-15`]),
  );
  const stages: Array<{ prompt: string; expectedAnswers: Record<string, string> }> = [];
  for (let step = 1; step <= stageCount; step += 1) {
    let update: string;
    if (step === 1) {
      update = PROJECTS.map(
        (project) => `${project}: owner ${owner.get(project)}, deadline ${deadline.get(project)}.`,
      ).join("\n");
    } else {
      const project = required(PROJECTS[Math.floor((step - 2) / 2) % PROJECTS.length]);
      if (step % 2 === 0) {
        const next = required(
          OWNERS[(Math.floor(step / 2) + PROJECTS.indexOf(project)) % OWNERS.length],
        );
        owner.set(project, next);
        update = `Confirmed owner change for ${project}: ${next} replaces the prior owner.`;
      } else {
        const month = ((step % 9) + 1).toString().padStart(2, "0");
        const date = `2028-${month}-${((step % 19) + 1).toString().padStart(2, "0")}`;
        deadline.set(project, date);
        update = `Confirmed deadline change for ${project}: ${date} replaces the prior deadline.`;
      }
    }
    let prompt = `Ongoing task: maintain the latest owner and deadline for Aurora, Boreal, Cedar and Delta. Apply only confirmed changes; the appendix is routine operational chatter and makes no change to these fields. At the end answer the six requested fields as a JSON object, with no extra text.\nStage ${step} confirmed update:\n${update}\n\nRoutine operations appendix (background only):\n`;
    for (let item = 0; prompt.length < targetChars; item += 1) {
      const serial = String(step * 10_000 + item).padStart(8, "0");
      prompt += `Daily note ${serial}: the office reviewed queue intake, acknowledged routine handoffs, checked the shared calendar, and closed this operational item without changing any tracked project owner or deadline.\n`;
    }
    prompt += `\nQuestion: Return exactly JSON keys aurora_owner, boreal_owner, cedar_owner, delta_owner, aurora_deadline, cedar_deadline. Use the latest confirmed values across all stages; do not use the appendix as updates.\n`;
    stages.push({
      prompt,
      expectedAnswers: {
        aurora_owner: required(owner.get("Aurora")),
        boreal_owner: required(owner.get("Boreal")),
        cedar_owner: required(owner.get("Cedar")),
        delta_owner: required(owner.get("Delta")),
        aurora_deadline: required(deadline.get("Aurora")),
        cedar_deadline: required(deadline.get("Cedar")),
      },
    });
  }
  return stages;
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const output = flag("--out");
  if (!output) throw new Error("Usage: tsx tools/pi-million-ledger-corpus.ts --out <new dir>");
  const out = resolve(output);
  if (existsSync(out)) throw new Error("Refusing to overwrite an existing corpus directory");
  const stages = buildLedgerCorpus();
  mkdirSync(out, { recursive: true });
  const manifestStages = stages.map((stage, index) => {
    const file = `stage-${String(index + 1).padStart(3, "0")}.txt`;
    writeFileSync(join(out, file), stage.prompt, "utf8");
    return {
      file,
      expectedAnswers: stage.expectedAnswers,
      chars: stage.prompt.length,
      sha256: createHash("sha256").update(stage.prompt).digest("hex"),
    };
  });
  const manifest = {
    id: "controlled-project-ledger-1m-v2",
    taskType: "synthetic-project-ledger",
    externalValidity: "controlled stress test, not a representative daily-task trace",
    stages: manifestStages,
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(
    `stages=${stages.length}, chars=${stages.reduce((n, x) => n + x.prompt.length, 0)}, manifest=${join(out, "manifest.json")}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
