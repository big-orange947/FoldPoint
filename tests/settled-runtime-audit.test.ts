import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TraceRecorder } from "../src/index";
import { auditSettledRuntime } from "../tools/settled-runtime-audit";

function fixture() {
  const t = new TraceRecorder({ producer: "test", now: () => 0 });
  const rows = [
    t.header(),
    t.request(
      "session-a",
      "call-a",
      { timestamp: 1, promptTokens: 100 },
      { outcome: "ok", runtimeId: "run-a" },
    ),
    t.runtimeEnd("session-a", "run-a", 2),
  ];
  const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const manifest = {
    v: 1,
    traceSha256: createHash("sha256").update(text).digest("hex"),
    activities: [
      {
        sessionId: "session-a",
        runtimeIds: ["run-a"],
        reportedOutcome: "completed",
        settled: true,
      },
    ],
  };
  return { text, manifest };
}

it("joins an exact trace-bound manifest without outputting identity or claiming calibration", () => {
  const { text, manifest } = fixture();
  const r = auditSettledRuntime(text, manifest);
  expect(r).toMatchObject({
    valid: 1,
    incomplete: 0,
    ordinaryCalls: 1,
    usableForCalibration: false,
  });
  expect(JSON.stringify(r)).not.toMatch(/session-a|run-a/);
  expect(() => auditSettledRuntime(`${text} `, manifest)).toThrow();
  expect(() =>
    auditSettledRuntime(text, {
      ...manifest,
      activities: [{ ...manifest.activities[0], body: "private data" }],
    }),
  ).toThrow();
});

it("reopens persisted files in fresh processes and refuses truncated or mismatched input", () => {
  const dir = mkdtempSync(join(tmpdir(), "settled-audit-")),
    tracePath = join(dir, "trace.jsonl"),
    manifestPath = join(dir, "manifest.json");
  const { text, manifest } = fixture();
  writeFileSync(tracePath, text);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const run = (out: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "tools/settled-runtime-audit.ts",
        "--trace",
        tracePath,
        "--manifest",
        manifestPath,
        "--out",
        out,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
  const first = join(dir, "first.json"),
    second = join(dir, "second.json"),
    invalid = join(dir, "invalid.json");
  expect(run(first).status).toBe(0);
  expect(run(second).status).toBe(0);
  expect(readFileSync(first, "utf8")).toBe(readFileSync(second, "utf8"));
  writeFileSync(tracePath, text.slice(0, -8));
  expect(run(invalid).status).toBe(1);
  expect(existsSync(invalid)).toBe(false);
  expect(run(first).status).toBe(1);
});

it("rejects invalid UTF-8 bytes instead of hashing a silently repaired string", () => {
  const dir = mkdtempSync(join(tmpdir(), "settled-utf8-"));
  const tracePath = join(dir, "trace.jsonl"),
    manifestPath = join(dir, "manifest.json"),
    out = join(dir, "report.json");
  const { text, manifest } = fixture();
  const bytes = Buffer.from(
    text.replace('"producer":"test"', '"producer":"test","extra":"badX"'),
    "utf8",
  );
  const index = bytes.indexOf(Buffer.from("badX"));
  expect(index).toBeGreaterThanOrEqual(0);
  bytes[index + 3] = 0xff;
  const decoded = bytes.toString("utf8");
  const altered = { ...manifest, traceSha256: createHash("sha256").update(decoded).digest("hex") };
  expect(auditSettledRuntime(decoded, altered).valid).toBe(1);
  writeFileSync(tracePath, bytes);
  writeFileSync(manifestPath, JSON.stringify(altered));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "tools/settled-runtime-audit.ts",
      "--trace",
      tracePath,
      "--manifest",
      manifestPath,
      "--out",
      out,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(1);
  expect(existsSync(out)).toBe(false);
});
