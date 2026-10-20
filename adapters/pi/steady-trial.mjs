// Isolated diagnostic only. No normal-user installation or environment-only activation.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULTS, parseTraceJsonl, profileKey } from "../../src/index.ts";
import { buildSteadyHistory } from "../../tools/pi-steady-history.ts";
import { createFoldPointObserver } from "./foldpoint-observe.ts";

const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const hash = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const readEvents = (path) => {
  const parsed = parseTraceJsonl(readFileSync(path, "utf8"));
  if (parsed.errors.length) throw new Error("Invalid metadata trace");
  return parsed.events;
};

export function createSteadyTrial({
  historyPath,
  tracePath,
  auditPath,
  prefixStorePath,
  keepRecentTokens = 20_000,
}) {
  const history = readEvents(historyPath);
  if (!history.some((e) => e.type === "compaction" && e.success))
    throw new Error("No successful historical summaries");
  return (pi) => {
    let previousWire,
      sentHostTokens,
      currentHostTokens,
      failedProof = false,
      summarizing = false,
      hasAttempt = false,
      callsSinceAttempt = 0;
    const clearPrefix = () => {
      previousWire = undefined;
      sentHostTokens = undefined;
    };
    pi.on("session_start", () => {
      clearPrefix();
      failedProof = false;
      summarizing = false;
      hasAttempt = false;
      callsSinceAttempt = 0;
    });
    pi.on("context", (_event, ctx) => {
      currentHostTokens = ctx.getContextUsage()?.tokens ?? undefined;
    });
    pi.on("message_end", (event) => {
      if (event.message?.role === "assistant" && event.message.stopReason === "stop")
        callsSinceAttempt++;
    });
    pi.on("session_compact", () => {
      summarizing = false;
      clearPrefix();
    });
    pi.on("session_compact_failed", () => {
      summarizing = false;
    });
    const observer = createFoldPointObserver({
      tracePath,
      prefixStorePath,
      mode: "act",
      compaction: "off",
      log: () => {},
      getReusablePrefixTokens: (input) =>
        failedProof || !previousWire || sentHostTokens === undefined
          ? undefined
          : Math.min(sentHostTokens, input.contextTokens),
      experimentalSteadyControl: {
        path: auditPath,
        getMetadata: (input, life) => {
          if (failedProof) return undefined;
          const learned = buildSteadyHistory(
            [...history, ...readEvents(tracePath)],
            input.profile,
            keepRecentTokens,
          );
          if (!learned) return undefined;
          return {
            profileKey: profileKey(input.profile),
            compactorTokenModel: learned.model,
            ordinaryCallsSinceLastAttempt: callsSinceAttempt,
            durationModel: {
              completedCalls: life.runtimeActive ? life.completedOrdinaryCalls : 0,
              components: [
                { weight: 0.8, continuationProbability: 0.8 },
                { weight: 0.2, continuationProbability: 0.98 },
              ],
            },
            executionConstraints: {
              hasAttempt,
              minCallsBetweenCompactions: DEFAULTS.minCallsBetweenCompactions,
              minReclaimTokens: DEFAULTS.minReclaimTokens,
              minReclaimRatio: DEFAULTS.minReclaimRatio,
              softWindowTokens: DEFAULTS.softWindowRatio * input.profile.contextWindowTokens,
            },
            cycleBilling: {},
          };
        },
      },
    });
    // Inspect our actual gate result, not another independently computed verdict. Only
    // a permitted compaction invalidates the old conversation; vetoes preserve it.
    observer({
      ...pi,
      on: (event, handler) =>
        pi.on(event, async (e, ctx) => {
          const result = await handler(e, ctx);
          if (event === "session_before_compact" && !result?.cancel) {
            clearPrefix();
            summarizing = true;
            hasAttempt = true;
            callsSinceAttempt = 0;
          }
          return result;
        }),
    });
    pi.on("before_provider_request", (event) => {
      if (summarizing) return;
      const body = event.payload;
      if (!body || !Array.isArray(body.messages)) throw new Error("Unverifiable trial request");
      const wire = {
        messages: body.messages.map(hash),
        fields: hash(
          Object.fromEntries(Object.entries(body).filter(([key]) => key !== "messages")),
        ),
      };
      if (
        previousWire &&
        (previousWire.fields !== wire.fields ||
          previousWire.messages.length > wire.messages.length ||
          !previousWire.messages.every((m, i) => m === wire.messages[i]))
      ) {
        failedProof = true;
        throw new Error("Trial request prefix changed unexpectedly");
      }
      previousWire = wire;
      sentHostTokens = currentHostTokens ?? 0; // Unknown estimate proves only an empty reusable prefix.
    });
  };
}

export default function steadyTrial(pi) {
  const historyPath = process.env.FOLDPOINT_STEADY_HISTORY,
    tracePath = process.env.FOLDPOINT_TRACE,
    auditPath = process.env.FOLDPOINT_STEADY_AUDIT;
  if (!historyPath || !tracePath || !auditPath)
    throw new Error("Use the dedicated steady trial runner");
  createSteadyTrial({
    historyPath,
    tracePath,
    auditPath,
    prefixStorePath: `${auditPath}.prefix.json`,
  })(pi);
}
