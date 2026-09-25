import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const candidate = process.env.FOLDPOINT_LEDGER_CANDIDATE;
if (!candidate) throw new Error("FOLDPOINT_LEDGER_CANDIDATE is required");
const { summarizeLedger } = await import(pathToFileURL(candidate).href);
const range = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };
const row = (id, userId, kind, amountCents, occurredAt = "2026-01-15T12:00:00.000Z") => ({
  id,
  userId,
  kind,
  amountCents,
  occurredAt,
});

test("refunds are negative and both kinds contribute to counts", () => {
  assert.deepEqual(
    summarizeLedger(
      [row("a", "u1", "charge", 1200), row("b", "u1", "refund", 450), row("c", "u2", "refund", 99)],
      range,
    ),
    [
      { userId: "u1", netCents: 750, transactionCount: 2 },
      { userId: "u2", netCents: -99, transactionCount: 1 },
    ],
  );
});

test("first occurrence of an ID wins, including an out-of-range first row", () => {
  assert.deepEqual(
    summarizeLedger(
      [
        row("x", "u9", "charge", 900, "2025-12-31T23:59:59.999Z"),
        row("x", "u1", "charge", 100),
        row("y", "u1", "charge", 200),
        row("y", "u1", "refund", 200),
      ],
      range,
    ),
    [{ userId: "u1", netCents: 200, transactionCount: 1 }],
  );
});

test("time range is half-open and includes exactly its start", () => {
  assert.deepEqual(
    summarizeLedger(
      [
        row("pre", "u", "charge", 1, "2025-12-31T23:59:59.999Z"),
        row("start", "u", "charge", 2, range.from),
        row("end", "u", "charge", 4, range.to),
      ],
      range,
    ),
    [{ userId: "u", netCents: 2, transactionCount: 1 }],
  );
});

test("users are sorted and the input remains unchanged", () => {
  const rows = Object.freeze([
    Object.freeze(row("b", "zoe", "charge", 2)),
    Object.freeze(row("a", "amy", "charge", 1)),
  ]);
  assert.deepEqual(summarizeLedger(rows, range), [
    { userId: "amy", netCents: 1, transactionCount: 1 },
    { userId: "zoe", netCents: 2, transactionCount: 1 },
  ]);
  assert.equal(rows[0].id, "b");
});

test("no eligible transactions returns an empty array", () => {
  assert.deepEqual(summarizeLedger([], range), []);
  assert.deepEqual(summarizeLedger([row("x", "u", "charge", 1, range.to)], range), []);
});
