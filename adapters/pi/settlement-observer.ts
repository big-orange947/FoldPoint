/** Numeric-only experimental observer; one settled activity may contain multiple agent attempts. */
export function createPiSettlementObserver(write: (record: unknown) => void) {
  let active = false,
    attempts = 0,
    ends = 0,
    ok = 0,
    failed = 0;
  let outcome: "completed" | "aborted" | "error" | "unknown" = "unknown";
  let blocked = false;
  return {
    observe(event: {
      type: string;
      outcome?: unknown;
      message?: { role?: unknown; stopReason?: unknown };
    }) {
      if (blocked) return;
      if (event.type === "agent_start") {
        if (!active) {
          active = true;
          attempts = 0;
          ends = 0;
          ok = 0;
          failed = 0;
        }
        attempts++;
        outcome = "unknown";
      } else if (event.type === "message_end" && active && event.message?.role === "assistant") {
        if (event.message.stopReason === "stop" || event.message.stopReason === "toolUse") ok++;
        else failed++;
      } else if (event.type === "agent_end" && active) {
        ends++;
      } else if (event.type === "agent_before_settle" && active) {
        outcome =
          event.outcome === "completed" || event.outcome === "aborted" || event.outcome === "error"
            ? event.outcome
            : "unknown";
      } else if (event.type === "agent_settled" && active) {
        try {
          const result: unknown = write({
            runner: "foldpoint.pi-settled-activity.v1",
            attempts,
            agentEnds: ends,
            assistantStopOrToolUseMessages: ok,
            assistantOtherOrUnknownMessages: failed,
            reportedOutcome: outcome,
            settled: true,
            canDrivePolicy: false,
          });
          // Fire-and-forget persistence cannot establish whether the activity was saved.
          if (result && typeof (result as { then?: unknown }).then === "function") {
            Promise.resolve(result).catch(() => {});
            blocked = true;
          }
        } catch {
          blocked = true;
        }
        active = false;
      }
    },
    snapshot() {
      return {
        active,
        attempts,
        agentEnds: ends,
        assistantStopOrToolUseMessages: ok,
        assistantOtherOrUnknownMessages: failed,
        reportedOutcome: outcome,
        blocked,
        canDrivePolicy: false,
      };
    },
  };
}

/** Explicit opt-in registration. The host owns persistence and version compatibility. */
export function attachPiSettlementObserver(
  register: (
    event: "agent_start" | "agent_end" | "agent_before_settle" | "agent_settled" | "message_end",
    handler: (event: {
      type: string;
      outcome?: unknown;
      message?: { role?: unknown; stopReason?: unknown };
    }) => void,
  ) => void,
  write: (record: unknown) => void,
) {
  const observer = createPiSettlementObserver(write);
  for (const type of [
    "agent_start",
    "agent_end",
    "agent_before_settle",
    "agent_settled",
    "message_end",
  ] as const)
    register(type, (event) => observer.observe(event));
  return observer;
}
