# Ledger summary contract

Implement `summarizeLedger(rows, { from, to })` in `ledger.mjs`.

- Each row has `id`, `userId`, `kind` (`"charge"` or `"refund"`), `amountCents`, and `occurredAt` (ISO timestamp).
- Ignore repeat transaction IDs after the first occurrence, even when the later row disagrees with the first.
- Include rows in the half-open UTC interval `[from, to)`.
- Charges add `amountCents`; refunds subtract it.
- Return one object per user with `userId`, `netCents` and `transactionCount`. The count includes both charges and refunds that survived deduplication and date filtering.
- Sort the result by `userId` using ordinary JavaScript string comparison.
- Do not mutate the input rows. An empty eligible set returns `[]`.

The benchmark runner will apply a separate oracle after the agent finishes. Do not rely on editing a local test file to make a failing implementation appear correct.
