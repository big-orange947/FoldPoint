import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FoldPoint,
  type FoldPointProfile,
  parseTraceJsonl,
  type TraceDecisionEvent,
} from "../src/index";

const input = process.argv[2];
if (input === undefined) {
  console.error("usage: npm run trace:shadow -- <trace.jsonl>");
  process.exitCode = 2;
} else {
  const path = resolve(input);
  const parsed = parseTraceJsonl(readFileSync(path, "utf8"));
  if (parsed.errors.length > 0) {
    console.error(`refusing incomplete trace: ${parsed.errors.length} unreadable line(s)`);
    process.exitCode = 1;
  } else {
    // The Pi adapter's calibrated cold-start summary-output ratio. Everything else comes from
    // the current core defaults. This is a shadow audit only: old compactions still determine
    // the later contexts, so the output is not a causal cost replay.
    const foldPoint = new FoldPoint({ defaults: { compactOutputRatio: 0.002 } });
    const pendingProfiles = new Map<string, FoldPointProfile>();
    const sessionProfiles = new Map<string, FoldPointProfile>();
    const shadowActionPending = new Set<string>();
    const shadowDecisions: Array<{
      seq: number;
      contextTokens: number;
      original: string;
      shadow: string;
      reasons: string[];
      expectedFutureCalls: number;
      callsUntilForce: number;
    }> = [];

    for (const event of parsed.events) {
      if (event.type === "decision") {
        const profile: FoldPointProfile = { ...event.profile };
        const decision = foldPoint.decide({
          sessionId: event.sessionId,
          profile,
          timestamp: event.timestamp,
          ...event.input,
        });
        pendingProfiles.set(event.callId, profile);
        sessionProfiles.set(event.sessionId, profile);
        if (
          !shadowActionPending.has(event.sessionId) &&
          (decision.action !== "KEEP" || event.decision.action !== "KEEP")
        ) {
          shadowDecisions.push({
            seq: event.seq,
            contextTokens: event.input.contextTokens,
            original: event.decision.action,
            shadow: decision.action,
            reasons: decision.reasons,
            expectedFutureCalls: decision.metrics.expectedFutureCalls,
            callsUntilForce: decision.metrics.callsUntilForce,
          });
          if (decision.action !== "KEEP") {
            shadowActionPending.add(event.sessionId);
          }
        }
        continue;
      }

      if (event.type === "request") {
        const profile = pendingProfiles.get(event.callId);
        pendingProfiles.delete(event.callId);
        if (profile !== undefined && (event.outcome ?? "ok") === "ok") {
          foldPoint.observeRequest(event.sessionId, profile, event.usage);
        }
        continue;
      }

      if (event.type === "compaction") {
        shadowActionPending.delete(event.sessionId);
        const profile = sessionProfiles.get(event.sessionId);
        if (profile !== undefined && event.afterTokens !== null) {
          foldPoint.recordCompaction(event.sessionId, profile, {
            timestamp: event.timestamp,
            beforeTokens: event.beforeTokens,
            afterTokens: event.afterTokens,
            success: event.success,
            ...event.usage,
          });
        }
        continue;
      }

      if (event.type === "session_end") {
        const profile = sessionProfiles.get(event.sessionId);
        if (profile !== undefined) {
          foldPoint.endSession(event.sessionId, profile, { timestamp: event.timestamp });
          sessionProfiles.delete(event.sessionId);
        }
      }
    }

    const counts = parsed.events
      .filter((event): event is TraceDecisionEvent => event.type === "decision")
      .reduce(
        (result, event) => {
          result[event.decision.action] += 1;
          return result;
        },
        { KEEP: 0, COMPACT: 0, FORCE: 0 },
      );
    const shadowCounts = shadowDecisions.reduce(
      (result, decision) => {
        result[decision.shadow as keyof typeof result] += 1;
        return result;
      },
      { KEEP: 0, COMPACT: 0, FORCE: 0 },
    );

    console.log(
      JSON.stringify(
        {
          input: path,
          limitation:
            "observational shadow only; original compactions still determine later contexts and costs",
          originalNonKeepCounts: { COMPACT: counts.COMPACT, FORCE: counts.FORCE },
          shadowNonKeepCounts: {
            COMPACT: shadowCounts.COMPACT,
            FORCE: shadowCounts.FORCE,
          },
          decisions: shadowDecisions,
        },
        null,
        2,
      ),
    );
  }
}
