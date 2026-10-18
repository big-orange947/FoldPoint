import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { estimateRuntimeSurvival } from "../src/index";
import type { runQualificationDivergence } from "../tools/qualification-divergence";
import { type CommitmentSnapshot, RenewalCommitment } from "../tools/renewal-commitment";

function fixture() {
  const r = JSON.parse(
    readFileSync("benchmarks/reports/qualification-divergence.json", "utf8"),
  ) as ReturnType<typeof runQualificationDivergence>;
  if (!r.selected.checkpoint) throw new Error("Missing fixture");
  const s = structuredClone(r.selected.checkpoint.snapshot);
  const e = estimateRuntimeSurvival(s.input, s.baseline, {
    ...s.options,
    futureQualification: undefined,
    renewalComparison: "shared-wait-continuation",
  });
  if (!e.commonContinuation) throw new Error("Missing common continuation");
  return { s, e, boundary: e.commonContinuation.repeatBoundaryTokens };
}
const compact = { action: "COMPACT" as const };
const keep = { action: "KEEP" as const };
function at(s: CommitmentSnapshot, context: number, calls = 3) {
  const c = structuredClone(s);
  c.input.contextTokens = context;
  c.baseline.action = "KEEP";
  c.baseline.metrics.callsSinceLastAttempt = calls;
  if (!c.options.executionConstraints) throw new Error("Missing constraints");
  c.options.executionConstraints.hasAttempt = true;
  return c;
}

it("does not lock on KEEP and starts only with a supplied approved economic action", () => {
  const { s, e } = fixture(),
    c = new RenewalCommitment();
  expect(c.decide(s, keep, e)).toBe(keep);
  expect(c.snapshot().plan).toBe(null);
  expect(c.decide(s, compact, e)).toBe(compact);
  expect(c.snapshot().plan?.phase).toBe("pending-root");
  c.observe(true);
  expect(c.snapshot().plan?.phase).toBe("committed");
});

it("suppresses renewed early COMPACT and retains the selected boundary despite a changed replan", () => {
  const { s, e, boundary } = fixture(),
    c = new RenewalCommitment();
  c.decide(s, compact, e);
  c.observe(true);
  const changed = structuredClone(e);
  if (!changed.commonContinuation) throw new Error("Missing boundary");
  changed.commonContinuation.repeatBoundaryTokens = boundary / 2;
  const state = at(s, boundary - 1),
    before = JSON.stringify(state);
  expect(c.decide(state, compact, changed).action).toBe("KEEP");
  expect(c.snapshot().plan?.boundary).toBe(boundary);
  expect(c.snapshot().stats.overrides).toBe(1);
  expect(JSON.stringify(state)).toBe(before);
  expect(c.decide(at(s, boundary), keep, changed).action).toBe("COMPACT");
  c.observe(true);
  expect(c.snapshot().plan).toBe(null);
  expect(c.snapshot().stats.released).toBe(1);
});

it("keeps pending root and committed retries after failures while respecting cooldown", () => {
  const { s, e, boundary } = fixture(),
    c = new RenewalCommitment();
  c.decide(s, compact, e);
  c.observe(false);
  expect(c.snapshot().plan?.phase).toBe("pending-root");
  expect(c.decide(at(s, s.input.contextTokens + 1, 0), keep, e).action).toBe("KEEP");
  expect(c.decide(at(s, s.input.contextTokens + 1), keep, e).action).toBe("COMPACT");
  c.observe(true);
  expect(c.snapshot().plan?.phase).toBe("committed");
  expect(c.decide(at(s, boundary), keep, e).action).toBe("COMPACT");
  c.observe(false);
  expect(c.snapshot().plan?.phase).toBe("committed");
  expect(c.decide(at(s, boundary, 0), keep, e).action).toBe("KEEP");
  expect(c.decide(at(s, boundary), keep, e).action).toBe("COMPACT");
  c.observe(true);
  expect(c.snapshot().plan).toBe(null);
  expect(c.snapshot().stats.failed).toBe(2);
});

it("preserves host FORCE and blocks ordinary committed dispatch at unsafe, disabled and idle boundaries", () => {
  const { s, e, boundary } = fixture(),
    c = new RenewalCommitment();
  c.decide(s, compact, e);
  c.observe(true);
  for (const patch of [
    { safeBoundary: false },
    { compactionAllowed: false },
    { runtimeStatus: "idle" as const },
  ]) {
    const v = at(s, boundary);
    Object.assign(v.input, patch);
    expect(c.decide(v, compact, e).action).toBe("KEEP");
  }
  const forced = at(s, s.baseline.metrics.guardedForceBoundaryTokens);
  forced.baseline.action = "FORCE";
  expect(c.decide(forced, keep, e).action).toBe("FORCE");
  c.observe(true);
  expect(c.snapshot().plan).toBe(null);
});

it("retains reclaim and soft-window gates and returns defensive snapshots", () => {
  const { s, e, boundary } = fixture(),
    c = new RenewalCommitment();
  c.decide(s, compact, e);
  c.observe(true);
  for (const patch of [
    { minReclaimTokens: 1e9 },
    { minReclaimRatio: 1 },
    { softWindowTokens: 1e9 },
  ]) {
    const v = at(s, boundary);
    Object.assign(v.options.executionConstraints ?? {}, patch);
    expect(c.decide(v, compact, e).action).toBe("KEEP");
  }
  const copy = c.snapshot();
  if (!copy.plan) throw new Error("Missing defensive plan");
  copy.plan.boundary = 1;
  copy.stats.started = 900;
  expect(c.snapshot().plan?.boundary).toBe(boundary);
  expect(c.snapshot().stats.started).toBe(1);
});

it("refuses missing or non-executable plan boundaries rather than inventing thresholds", () => {
  const { s, e } = fixture();
  for (const boundary of [
    0,
    -1,
    NaN,
    Infinity,
    s.baseline.metrics.guardedForceBoundaryTokens + 1,
  ]) {
    const v = structuredClone(e);
    if (!v.commonContinuation) throw new Error("Missing model");
    v.commonContinuation.repeatBoundaryTokens = boundary;
    expect(() => new RenewalCommitment().decide(s, compact, v)).toThrow(/boundary/);
  }
  expect(() =>
    new RenewalCommitment().decide(s, compact, { ...e, commonContinuation: undefined }),
  ).toThrow(/boundary/);
});
