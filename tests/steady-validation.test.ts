import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { affineCostCases } from "../tools/affine-cost";
import { sourceHash } from "../tools/affine-holdout";
import { captureSteadyBranch, type runSteadyPolicy } from "../tools/steady-policy";
import {
  freshPilotGate,
  renderFreshSteadyValidation,
  type runFreshSteadyValidation,
  safeValidationRun,
  summarizeFreshSteady,
  VALIDATION_PLAN,
  validationCases,
} from "../tools/steady-validation";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const report = () =>
  JSON.parse(read("benchmarks/reports/steady-validation.json")) as ReturnType<
    typeof runFreshSteadyValidation
  >;

it("builds exactly the preregistered crossed matrix with new seeds and no host horizon", () => {
  const cases = validationCases();
  expect(cases).toHaveLength(42);
  for (const [suite, count] of [
    ["main", 24],
    ["short", 6],
    ["failure", 6],
    ["prewarm", 6],
  ] as const)
    expect(cases.filter((c) => c.suite === suite)).toHaveLength(count);
  const keys = cases.map((c) => [c.profile, c.family, c.suite, c.seed, c.scenario.steps].join("/"));
  expect(new Set(keys).size).toBe(42);
  for (const c of cases) {
    expect(c.scenario.hostHorizon).toBeUndefined();
    expect(VALIDATION_PLAN.seeds).toContain(c.seed);
    expect(c.seed).not.toBe(104729);
    expect(c.scenario.compactor.successRate).toBe(c.suite === "failure" ? 0.85 : 1);
    if (c.suite === "prewarm") expect(c.scenario.cycleBilling).toEqual(VALIDATION_PLAN.prewarm);
  }
  for (const profile of VALIDATION_PLAN.profiles)
    expect(cases.filter((c) => c.profile === profile && c.suite === "main")).toHaveLength(8);
});

it("retains only declared scenario changes and the same truth across price profiles", () => {
  const cases = validationCases(),
    old = affineCostCases()[0];
  if (!old) throw new Error("Missing baseline");
  for (const family of VALIDATION_PLAN.families) {
    const siblings = cases.filter(
      (c) =>
        c.family === family.id &&
        c.suite === "main" &&
        c.seed === 196613 &&
        c.scenario.steps === 144,
    );
    expect(siblings).toHaveLength(3);
    expect(new Set(siblings.map((c) => JSON.stringify(c.scenario.compactor))).size).toBe(1);
    for (const c of siblings) {
      expect(c.scenario.contextWindowTokens).toBe(old.scenario.contextWindowTokens);
      expect(c.scenario.startTokens).toBe(old.scenario.startTokens);
      expect(c.scenario.idleMs).toBe(old.scenario.idleMs);
      expect(c.scenario.growthPerStep).toBe(family.growth);
      expect(c.scenario.compactor.retainedFloorTokens).toBe(family.afterFloor);
    }
  }
});

it("keeps candidate decisions prefix-identical when only the new task endpoint changes", () => {
  const c = validationCases()[0];
  if (!c) throw new Error("Missing new case");
  for (const fitted of [false, true]) {
    const a = captureSteadyBranch({ ...c.scenario, steps: 12 }, fitted);
    const b = captureSteadyBranch({ ...c.scenario, steps: 24 }, fitted);
    expect(a.actions).toEqual(b.actions.slice(0, 12));
    expect(a.snapshots).toEqual(b.snapshots.slice(0, 12));
  }
});

it("preserves canary identities and every fresh row instead of retaining successful profiles only", () => {
  const r = report(),
    old = JSON.parse(read("benchmarks/reports/steady-policy.json")) as ReturnType<
      typeof runSteadyPolicy
    >;
  expect(r.rows).toHaveLength(42);
  expect(r.canary.matched).toBe(true);
  const control = old.rows.find(
    (c) =>
      c.profile === r.canary.profile &&
      c.fixture === r.canary.fixture &&
      c.steps === 240 &&
      c.suite === "main",
  );
  expect(r.canary.arms).toEqual(control?.arms);
  for (const row of r.rows) {
    const fingerprints = Object.values(row.arms).flatMap((a) =>
      a.bill ? [a.bill.fingerprint] : [],
    );
    expect(new Set(fingerprints).size).toBeLessThanOrEqual(1);
    for (const arm of Object.values(row.arms)) {
      if (arm.status === "invalid") {
        expect(arm.errorCode).not.toBe(null);
        continue;
      }
      if (!arm.bill) throw new Error("Valid arm without bill");
      expect(arm.bill.cost).toBeCloseTo(
        arm.bill.ordinary + arm.bill.summary + arm.bill.prewarm,
        10,
      );
      expect(arm.bill.inputWithinWindow).toBe(true);
      expect(arm.bill.overflow).toBe(0);
    }
  }
});

it("rejects cherry-picked partial means and does not hide unexpected program errors", () => {
  const r = report(),
    rows = structuredClone(r.rows);
  const first = rows.find((v) => v.suite === "main");
  if (!first) throw new Error("Missing main");
  first.arms.steadyOutput.status = "invalid";
  first.arms.steadyOutput.errorCode = "UNACCOUNTED_BILL_OR_RECOVERY";
  first.arms.steadyOutput.bill = null;
  const groups = summarizeFreshSteady(rows),
    g = groups.find((g) => g.key === `${first.profile}/main`);
  expect(g?.outputVsFixed60.mean).toBe(null);
  expect(g?.outputVsFixed60.comparable).toBe(7);
  expect(freshPilotGate(rows, groups).passed).toBe(false);
  expect(
    safeValidationRun(() => {
      throw new Error("Full bill does not reconcile or overflow recovery is unaccounted");
    }),
  ).toEqual({ status: "invalid", errorCode: "UNACCOUNTED_BILL_OR_RECOVERY", bill: null });
  expect(() =>
    safeValidationRun(() => {
      throw new Error("unexpected bug");
    }),
  ).toThrow("unexpected bug");
});

it("requires per-price majority as well as mean gains, rather than rewarding a pooled outlier", () => {
  const data = report(),
    rows = structuredClone(data.rows);
  for (const row of rows) {
    // Synthetic arithmetic fixture independent of whether an observed arm failed.
    const reference = row.arms.fixed60.bill ?? data.canary.arms.fixed60;
    for (const key of ["fixed60", "incumbent", "steadyRatio", "steadyOutput"] as const)
      row.arms[key] = { status: "ok", errorCode: null, bill: structuredClone(reference) };
    if (!row.arms.incumbent.bill || !row.arms.steadyOutput.bill) throw new Error("Missing fixture");
    row.arms.incumbent.bill.cost = reference.cost * 1.05;
    row.arms.steadyOutput.bill.cost = reference.cost * 0.9;
  }
  expect(freshPilotGate(rows, summarizeFreshSteady(rows)).passed).toBe(true);
  const flash = rows.filter((r) => r.profile === "deepseek-flash-peak" && r.suite === "main");
  for (const [i, row] of flash.entries()) {
    const reference = row.arms.fixed60.bill,
      candidate = row.arms.steadyOutput.bill;
    if (!reference || !candidate) throw new Error("Missing bill");
    candidate.cost = reference.cost * (i === 0 ? 0.2 : i < 3 ? 0.9 : 1.01);
  }
  const groups = summarizeFreshSteady(rows);
  expect(
    groups.find((g) => g.key === "deepseek-flash-peak/main")?.outputVsFixed60.mean,
  ).toBeLessThan(0);
  const gate = freshPilotGate(rows, groups);
  expect(gate.passed).toBe(false);
  expect(gate.perProfile.find((p) => p.profile === "deepseek-flash-peak")?.majorityVsFixed60).toBe(
    false,
  );
  expect(gate.defaultPromotion).toBe(false);
});

it("computes all group denominators and the gate from the retained rows", () => {
  const r = report();
  expect(summarizeFreshSteady(r.rows)).toEqual(r.groups);
  expect(freshPilotGate(r.rows, r.groups)).toEqual(r.gate);
  expect(r.groups.filter((g) => g.key.endsWith("/main")).every((g) => g.cases === 8)).toBe(true);
  expect(r.groups.filter((g) => !g.key.endsWith("/main")).every((g) => g.cases === 2)).toBe(true);
  // No aggregate sensitivity win is allowed to alter the primary main gate.
  expect(r.gate.perProfile).toHaveLength(3);
});

it("pins candidate dependencies, the preregistration and the report's synthetic limitations", () => {
  const r = report();
  expect(r.paidCalls).toBe(0);
  expect(r.planCommit).toBe("f14e82d");
  expect(r.candidateCommit).toBe("86bde86");
  expect(r.planHash).toBe("ce3d4fea6354997e95164db4d73107a9e0b12dff7cc35cabead83eb1c40aacef");
  expect(r.planHash).toBe(sourceHash(read("benchmarks/steady-validation-plan.json")));
  expect(r.sourceHash).toBe(sourceHash(read("tools/steady-validation.ts")));
  for (const [p, h] of Object.entries(r.candidateHashes)) expect(sourceHash(read(p))).toBe(h);
  expect(renderFreshSteadyValidation(r)).toBe(read("benchmarks/steady-validation.md"));
  expect(renderFreshSteadyValidation(r)).toContain("不构成统计优势证明");
  expect(renderFreshSteadyValidation(r)).toContain("没有SDK/Pi默认变化");
});

it("refuses unknown CLI flags before running validation or replacing any saved report", () => {
  const path = "benchmarks/reports/steady-validation.json";
  const before = existsSync(path) ? read(path) : null;
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/steady-validation.ts", "--unknown"],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("usage: tsx tools/steady-validation.ts");
  expect(existsSync(path) ? read(path) : null).toBe(before);
});
