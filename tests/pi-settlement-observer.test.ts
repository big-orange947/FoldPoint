import { expect, it } from "vitest";
import {
  attachPiSettlementObserver,
  createPiSettlementObserver,
} from "../adapters/pi/settlement-observer";

it("groups retries until settled and never turns an absent outcome into completion", () => {
  const records: unknown[] = [],
    observer = createPiSettlementObserver((r) => {
      records.push(r);
    });
  observer.observe({ type: "agent_start" });
  observer.observe({ type: "agent_before_settle", outcome: "completed" });
  observer.observe({ type: "agent_start" }); // A later continuation invalidates the previous outcome.
  observer.observe({ type: "agent_end" });
  observer.observe({ type: "agent_settled" });
  observer.observe({ type: "agent_settled" });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    attempts: 2,
    reportedOutcome: "unknown",
    settled: true,
    canDrivePolicy: false,
  });
});
it("keeps body and raw errors out of records and stops recording after storage failure", () => {
  const records: unknown[] = [],
    observer = createPiSettlementObserver((r) => {
      records.push(r);
      throw new Error("private-error");
    });
  observer.observe({ type: "agent_start" });
  const event = {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: "private-body" },
  };
  observer.observe(event);
  observer.observe({ type: "agent_before_settle", outcome: "completed" });
  observer.observe({ type: "agent_settled" });
  expect(observer.snapshot().blocked).toBe(true);
  observer.observe({ type: "agent_start" });
  observer.observe({ type: "agent_settled" });
  expect(records).toHaveLength(1);
  expect(JSON.stringify([records, observer.snapshot()])).not.toMatch(/private-body|private-error/);
});

it("does not treat a fire-and-forget persistence callback as a successful write", async () => {
  const observer = createPiSettlementObserver(async () => {
    throw new Error("private-async-error");
  });
  observer.observe({ type: "agent_start" });
  observer.observe({ type: "agent_settled" });
  expect(observer.snapshot().blocked).toBe(true);
  await Promise.resolve();
  expect(JSON.stringify(observer.snapshot())).not.toContain("private-async-error");
});

it("registers only observational lifecycle hooks and never returns a control instruction", () => {
  const handlers = new Map<string, (event: { type: string; outcome?: unknown }) => void>();
  const records: unknown[] = [];
  attachPiSettlementObserver(
    (name, handler) => {
      handlers.set(name, handler);
    },
    (record) => {
      records.push(record);
    },
  );
  expect([...handlers.keys()]).toEqual([
    "agent_start",
    "agent_end",
    "agent_before_settle",
    "agent_settled",
    "message_end",
  ]);
  expect(handlers.get("agent_start")?.({ type: "agent_start" })).toBeUndefined();
  expect(handlers.get("agent_end")?.({ type: "agent_end" })).toBeUndefined();
  expect(
    handlers.get("agent_before_settle")?.({ type: "agent_before_settle", outcome: "completed" }),
  ).toBeUndefined();
  expect(handlers.get("agent_settled")?.({ type: "agent_settled" })).toBeUndefined();
  expect(records).toHaveLength(1);
});
