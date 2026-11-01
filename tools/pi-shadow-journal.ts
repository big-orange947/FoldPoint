/** Single-writer research journal for the opt-in Pi shadow. No policy control. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import type { RetentionAssumptions, RetentionBinding } from "./pi-retention-learner";
import type { ImmediateSummaryFeedback } from "./pi-summary-feedback";

const MAX_BYTES = 8 * 1024 * 1024;

export function openPiShadowJournal(
  path: string,
  binding: RetentionBinding,
  assumptions: RetentionAssumptions,
) {
  // Bind the full learning configuration, including the estimator and uncertainty assumptions.
  const basis = createHash("sha256")
    .update(
      JSON.stringify([
        binding.profileBinding,
        binding.compactorBinding,
        binding.estimatorId,
        assumptions.beforeErrorTokens,
        assumptions.afterErrorTokens,
        assumptions.driftToleranceRatio,
      ]),
    )
    .digest("hex");
  const header = JSON.stringify({ v: 1, type: "pi-shadow-feedback", basis });
  let fd: number;
  let created = false;
  try {
    fd = openSync(path, "wx+", 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = openSync(path, "r+");
  }
  let blocked = false;
  let closed = false;
  try {
    if (created) {
      const bytes = Buffer.from(`${header}\n`);
      if (writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("short write");
      fsyncSync(fd);
    }
    const initialSize = fstatSync(fd).size;
    if (initialSize > MAX_BYTES) throw new Error("journal too large");
    const bytes = readFileSync(fd);
    if (bytes.length !== initialSize) throw new Error("journal changed");
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!contents.endsWith("\n")) throw new Error("incomplete journal");
    const lines = contents.slice(0, -1).split("\n");
    if (lines.shift() !== header || lines.length > 4096) throw new Error("incompatible journal");
    const history: unknown[] = lines.map((line) => JSON.parse(line));
    let size = initialSize;
    return {
      loadHistory: () => history.slice(),
      appendFeedback(sample: ImmediateSummaryFeedback) {
        if (blocked || closed || fstatSync(fd).size !== size)
          throw new Error("journal unavailable");
        // Rebuild the record from the supported fields; never persist extra host fields.
        const safe = {
          v: sample.v,
          source: sample.source,
          sequence: sample.sequence,
          stage: sample.stage,
          binding: sample.binding,
          compactorBinding: sample.compactorBinding,
          beforeTokens: sample.beforeTokens,
          afterTokens: sample.afterTokens,
          estimatedOnly: sample.estimatedOnly,
          canDrivePolicy: sample.canDrivePolicy,
          usage:
            sample.usage === null
              ? null
              : {
                  promptTokens: sample.usage.promptTokens,
                  cachedInputTokens: sample.usage.cachedInputTokens,
                  cacheWriteTokens: sample.usage.cacheWriteTokens,
                  outputTokens: sample.usage.outputTokens,
                },
        };
        const row = Buffer.from(`${JSON.stringify(safe)}\n`);
        try {
          if (size + row.length > MAX_BYTES) throw new Error("journal too large");
          if (writeSync(fd, row, 0, row.length, size) !== row.length)
            throw new Error("short write");
          fsyncSync(fd);
          size += row.length;
          history.push(safe);
        } catch {
          blocked = true;
          throw new Error("journal write failed");
        }
      },
      close() {
        if (!closed) closeSync(fd);
        closed = true;
      },
    };
  } catch {
    closeSync(fd);
    throw new Error("shadow journal unavailable or incompatible");
  }
}
