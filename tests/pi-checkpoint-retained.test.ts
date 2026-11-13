import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const archive = resolve(
  "traces/pi-million-base/foldpoint-1m-JquDjY/sessions/2026-09-29T10-57-29-684Z_01a0ecd0-0054-7661-94c4-095dd42755b0.jsonl",
);
const clean = () => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
});
it("rejects unknown options and live runs without a key before opening an archive", () => {
  const out = join(mkdtempSync(join(tmpdir(), "foldpoint-checkpoint-guard-")), "capture");
  for (const args of [["--unexpected"], ["--session", "missing.jsonl", "--out", out, "--live"]]) {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "tools/pi-checkpoint-retained.mjs", ...args],
      { encoding: "utf8", env: clean(), timeout: 10000 },
    );
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  }
});
it.skipIf(!existsSync(archive) || !existsSync("D:/pi/packages/coding-agent/src/core/sdk.ts"))(
  "restores only the prefix into real Pi with no HTTP and preserves the source archive",
  () => {
    const out = join(mkdtempSync(join(tmpdir(), "foldpoint-checkpoint-restore-")), "capture");
    execFileSync(
      process.execPath,
      ["--import", "tsx", "tools/pi-checkpoint-retained.mjs", "--session", archive, "--out", out],
      {
        encoding: "utf8",
        env: { ...clean(), DEEPSEEK_API_KEY: "sentinel-key-never-persist" },
        timeout: 30000,
      },
    );
    const text = readFileSync(join(out, "report.json"), "utf8"),
      r = JSON.parse(text);
    expect(text).not.toContain("sentinel-key-never-persist");
    expect(r.completed).toBe(true);
    expect(r.mode).toBe("offline-fake");
    expect(r.httpCalls).toBe(0);
    expect(r.networkAttempts).toBe(0);
    expect(r.archiveUnchanged).toBe(true);
    expect(r.preparedBefore).toBe(609860);
    expect(r.historicalBefore).toBe(r.preparedBefore);
    expect(r.ledger.map((x: { stage: string }) => x.stage)).toEqual([
      "summary",
      "first-post",
      "second-post",
    ]);
    expect(r.shadow).toMatchObject({
      samples: 1,
      pendingRequests: 0,
      pendingSummary: false,
      applied: false,
    });
    const events = r.shadow.events as Array<Record<string, unknown>>;
    for (const e of events.filter((x) => x.predictionSeq !== undefined))
      expect(Number(e.seq)).toBeGreaterThan(Number(e.predictionSeq));
  },
  40000,
);
