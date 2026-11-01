/** Offline, fail-closed join; output contains aggregate counts only. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceJsonl } from "../src/index";
import { joinSettledActivities, type SettledActivity } from "./settled-runtime-join";

export function auditSettledRuntime(trace: string, manifest: unknown) {
  const parsed = parseTraceJsonl(trace);
  if (parsed.errors.length || !parsed.events.length) throw new Error("invalid trace");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("invalid manifest");
  const m = manifest as Record<string, unknown>;
  if (
    Object.keys(m).some((k) => !["v", "traceSha256", "activities"].includes(k)) ||
    m.v !== 1 ||
    m.traceSha256 !== createHash("sha256").update(trace, "utf8").digest("hex") ||
    !Array.isArray(m.activities) ||
    m.activities.length > 10000
  )
    throw new Error("trace binding mismatch or invalid manifest");
  const label = (v: unknown): v is string =>
    typeof v === "string" && /^[A-Za-z0-9._@:/+#-]{1,128}$/.test(v);
  for (const entry of m.activities) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("invalid activity");
    const a = entry as Record<string, unknown>;
    if (
      Object.keys(a).some(
        (k) => !["sessionId", "runtimeIds", "reportedOutcome", "settled"].includes(k),
      ) ||
      !label(a.sessionId) ||
      !Array.isArray(a.runtimeIds) ||
      !a.runtimeIds.length ||
      a.runtimeIds.length > 128 ||
      !a.runtimeIds.every(label) ||
      a.settled !== true ||
      !["completed", "aborted", "error", "unknown"].includes(String(a.reportedOutcome))
    )
      throw new Error("invalid activity");
  }
  return {
    ...joinSettledActivities(parsed.events, m.activities as SettledActivity[]),
    traceSha256: m.traceSha256,
    source:
      "explicit manifest bound to exact completed trace; identity association is host-provided, not independently authenticated",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 6 ||
      args[0] !== "--trace" ||
      !args[1] ||
      args[2] !== "--manifest" ||
      !args[3] ||
      args[4] !== "--out" ||
      !args[5] ||
      existsSync(args[5])
    )
      throw new Error("invalid args");
    const bytes = readFileSync(args[1]);
    const trace = bytes.toString("utf8");
    // Reject lossy UTF-8 decoding: the manifest hash must identify the exact bytes on disk.
    if (!Buffer.from(trace, "utf8").equals(bytes)) throw new Error("invalid UTF-8 trace");
    const report = auditSettledRuntime(trace, JSON.parse(readFileSync(args[3], "utf8")));
    writeFileSync(args[5], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    process.stderr.write("Settled runtime audit failed validation; source files unchanged\n");
    process.exitCode = 1;
  }
}
