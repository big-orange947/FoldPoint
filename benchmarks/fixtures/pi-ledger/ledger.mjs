/**
 * Return per-user net cents for a selected UTC time range.
 * This implementation deliberately contains mistakes for the Pi repair task.
 */
export function summarizeLedger(rows, { from, to }) {
  const perUser = new Map();
  for (const row of rows) {
    if (row.occurredAt < from || row.occurredAt > to) continue;
    const current = perUser.get(row.userId) ?? {
      userId: row.userId,
      netCents: 0,
      transactionCount: 0,
    };
    current.netCents += row.amountCents;
    current.transactionCount += 1;
    perUser.set(row.userId, current);
  }
  return [...perUser.values()];
}
