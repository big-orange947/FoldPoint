import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const candidate = process.env.FOLDPOINT_PRICING_BUILD;
if (!candidate) throw new Error("FOLDPOINT_PRICING_BUILD is required");
const { costOfCall, resolveUnitPrices } = await import(pathToFileURL(candidate).href);
const prices = resolveUnitPrices({
  currency: "USD",
  inputPerMillion: 3,
  outputPerMillion: 9,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
});

test("an expired cache writes the whole prompt and still bills output", () => {
  for (const [prompt, prefix, output] of [
    [100_000, 80_000, 1_000],
    [17_321, 4_700, 31],
    [9_000, 0, 400],
  ]) {
    const actual = costOfCall(
      prices,
      prompt,
      {
        prefixTokens: prefix,
        aliveProbability: 0,
        cachingInPlay: true,
      },
      output,
    );
    assert.ok(Math.abs(actual - (prompt * 3.75 + output * 9) / 1_000_000) < 1e-12);
  }
});

test("a live cache bills cached prefix, new tail and output", () => {
  for (const [prompt, prefix, output] of [
    [100_000, 80_000, 1_000],
    [17_321, 4_700, 31],
    [9_000, 9_000, 400],
  ]) {
    const actual = costOfCall(
      prices,
      prompt,
      {
        prefixTokens: prefix,
        aliveProbability: 1,
        cachingInPlay: true,
      },
      output,
    );
    assert.ok(
      Math.abs(actual - (prefix * 0.3 + (prompt - prefix) * 3 + output * 9) / 1_000_000) < 1e-12,
    );
  }
});

test("partial survival probability blends the two complete costs", () => {
  const prompt = 22_000;
  const prefix = 11_000;
  const output = 70;
  const live = (prefix * 0.3 + (prompt - prefix) * 3 + output * 9) / 1_000_000;
  const cold = (prompt * 3.75 + output * 9) / 1_000_000;
  const actual = costOfCall(
    prices,
    prompt,
    {
      prefixTokens: prefix,
      aliveProbability: 0.4,
      cachingInPlay: true,
    },
    output,
  );
  assert.ok(Math.abs(actual - (0.4 * live + 0.6 * cold)) < 1e-12);
});
