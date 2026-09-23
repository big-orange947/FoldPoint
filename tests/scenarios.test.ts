import { describe, expect, it } from "vitest";
import { FoldPoint, type FoldPointAction, type FoldPointReason } from "../src/index";
import { BASE_TIMESTAMP, makeProfile } from "./helpers";

interface SessionConfig {
  steps: number;
  startTokens: number;
  growthPerStep: number;
  /** Milliseconds between model calls. */
  idleMs: number;
  /** Ground-truth compactor behaviour, hidden from FoldPoint. */
  retentionRatio: number;
  outputRatio: number;
  outputTokens: number;
  expectedFutureCalls?: number;
  suddenGrowthAtStep?: { step: number; tokens: number };
}

interface StepView {
  step: number;
  timestamp: number;
  contextTokens: number;
  cachedTokens: number;
  utilization: number;
}

interface StrategyHooks {
  decide(view: StepView): { action: FoldPointAction; reasons: FoldPointReason[] };
  onCompaction?(
    view: StepView,
    afterTokens: number,
    outputTokens: number,
    action: FoldPointAction,
  ): void;
  onRequest?(view: StepView, cachedTokens: number): void;
  onSessionEnd?(timestamp: number): void;
}

interface SessionResult {
  decisions: Array<{
    step: number;
    contextTokens: number;
    utilization: number;
    action: FoldPointAction;
    reasons: FoldPointReason[];
  }>;
  compactions: Array<{
    step: number;
    action: FoldPointAction;
    beforeTokens: number;
    afterTokens: number;
  }>;
  maxUtilization: number;
}

const WINDOW = 200_000;
const CACHE_TTL_MS = 60_000;

const CACHE_ALIVE: SessionConfig = {
  steps: 60,
  startTokens: 5_000,
  growthPerStep: 4_000,
  idleMs: 10_000,
  retentionRatio: 0.3,
  outputRatio: 0.1,
  outputTokens: 300,
};

const CACHE_EXPIRED: SessionConfig = {
  ...CACHE_ALIVE,
  idleMs: 120_000,
  expectedFutureCalls: 20,
};

function runSession(config: SessionConfig, hooks: StrategyHooks): SessionResult {
  let contextTokens = config.startTokens;
  let lastPromptTokens = 0;
  let timestamp = BASE_TIMESTAMP;
  const decisions: SessionResult["decisions"] = [];
  const compactions: SessionResult["compactions"] = [];

  for (let step = 0; step < config.steps; step += 1) {
    timestamp += config.idleMs;
    const cachedTokens =
      lastPromptTokens > 0 && config.idleMs < CACHE_TTL_MS
        ? Math.min(lastPromptTokens, contextTokens)
        : 0;
    const view: StepView = {
      step,
      timestamp,
      contextTokens,
      cachedTokens,
      utilization: contextTokens / WINDOW,
    };

    const { action, reasons } = hooks.decide(view);
    decisions.push({ step, contextTokens, utilization: view.utilization, action, reasons });

    let callCachedTokens = cachedTokens;

    if (action !== "KEEP") {
      const beforeTokens = contextTokens;
      const afterTokens = Math.round(beforeTokens * config.retentionRatio);
      const compactionOutputTokens = Math.round(beforeTokens * config.outputRatio);
      hooks.onCompaction?.(view, afterTokens, compactionOutputTokens, action);
      compactions.push({ step, action, beforeTokens, afterTokens });
      contextTokens = afterTokens;
      lastPromptTokens = 0;
      callCachedTokens = 0;
    }

    hooks.onRequest?.(view, Math.min(callCachedTokens, contextTokens));
    lastPromptTokens = contextTokens;
    contextTokens += config.growthPerStep;
    if (config.suddenGrowthAtStep && config.suddenGrowthAtStep.step === step) {
      contextTokens += config.suddenGrowthAtStep.tokens;
    }
  }

  hooks.onSessionEnd?.(timestamp);
  return {
    decisions,
    compactions,
    maxUtilization: Math.max(...decisions.map((entry) => entry.utilization)),
  };
}

function foldPointHooks(
  config: SessionConfig,
  sessionId = "scenario-session",
): {
  hooks: StrategyHooks;
  foldPoint: FoldPoint;
  profile: ReturnType<typeof makeProfile>;
} {
  const foldPoint = new FoldPoint();
  const profile = makeProfile({ cachePolicy: { ttlMs: CACHE_TTL_MS } });

  const hooks: StrategyHooks = {
    decide(view) {
      const input = {
        sessionId,
        profile,
        timestamp: view.timestamp,
        contextTokens: view.contextTokens,
        cachedTokens: view.cachedTokens,
        idleMs: config.idleMs,
        safeBoundary: true,
        compactionAllowed: true,
        ...(config.expectedFutureCalls === undefined
          ? {}
          : { expectedFutureCalls: config.expectedFutureCalls }),
      };
      const decision = foldPoint.decide(input);
      return { action: decision.action, reasons: decision.reasons };
    },
    onCompaction(view, afterTokens, outputTokens) {
      foldPoint.recordCompaction(sessionId, profile, {
        timestamp: view.timestamp,
        beforeTokens: view.contextTokens,
        afterTokens,
        promptTokens: view.contextTokens,
        outputTokens,
        success: true,
      });
    },
    onRequest(view, cachedTokens) {
      foldPoint.observeRequest(sessionId, profile, {
        timestamp: view.timestamp,
        promptTokens: view.contextTokens,
        cachedInputTokens: cachedTokens,
        outputTokens: config.outputTokens,
      });
    },
    onSessionEnd(timestamp) {
      foldPoint.endSession(sessionId, profile, { timestamp });
    },
  };

  return { hooks, foldPoint, profile };
}

function fixedThresholdHooks(threshold: number): StrategyHooks {
  return {
    decide(view) {
      return { action: view.utilization >= threshold ? "COMPACT" : "KEEP", reasons: [] };
    },
  };
}

describe("simulated sessions", () => {
  it("keeps the context untouched in a short session", () => {
    const short: SessionConfig = { ...CACHE_ALIVE, steps: 8 };
    const { hooks } = foldPointHooks(short);
    const session = runSession(short, hooks);

    expect(session.compactions).toHaveLength(0);
    expect(session.decisions.every((entry) => entry.action === "KEEP")).toBe(true);
    expect(session.maxUtilization).toBeLessThan(0.65);
  });

  it("defers compaction while the cache keeps replay cheap, unlike a fixed 70% threshold", () => {
    const { hooks } = foldPointHooks(CACHE_ALIVE);
    const foldPointSession = runSession(CACHE_ALIVE, hooks);
    const fixedSession = runSession(CACHE_ALIVE, fixedThresholdHooks(0.7));

    expect(foldPointSession.compactions.length).toBeGreaterThan(0);
    expect(foldPointSession.compactions.length).toBeLessThan(fixedSession.compactions.length);
    for (const compaction of foldPointSession.compactions) {
      expect(compaction.action).toBe("FORCE");
    }
    expect(
      foldPointSession.decisions.some(
        (entry) => entry.action === "KEEP" && entry.reasons.includes("CACHE_STILL_VALUABLE"),
      ),
    ).toBe(true);
  });

  it("compacts economically before the hard window once the cache is gone", () => {
    const { hooks } = foldPointHooks(CACHE_EXPIRED);
    const session = runSession(CACHE_EXPIRED, hooks);

    const economic = session.compactions.filter((entry) => entry.action === "COMPACT");
    expect(economic.length).toBeGreaterThan(0);
    for (const compaction of economic) {
      expect(compaction.beforeTokens / WINDOW).toBeLessThan(0.9);
    }
    const firstEconomic = session.decisions.find((entry) => entry.action === "COMPACT");
    expect(firstEconomic?.reasons).toContain("ECONOMIC_TRIGGER");
    expect(firstEconomic?.reasons).toContain("CACHE_LIKELY_EXPIRED");
  });

  it("forces a compaction when a single step blows past the window", () => {
    const config: SessionConfig = {
      ...CACHE_ALIVE,
      steps: 20,
      suddenGrowthAtStep: { step: 10, tokens: 200_000 },
    };
    const { hooks } = foldPointHooks(config);
    const session = runSession(config, hooks);

    const forced = session.decisions.filter((entry) => entry.action === "FORCE");
    expect(forced).toHaveLength(1);
    expect(forced[0]?.reasons).toContain("HARD_WINDOW_RATIO");
    expect(session.compactions).toHaveLength(1);
  });

  it("stops compacting economically once it learns the compactor reclaims almost nothing", () => {
    const config: SessionConfig = { ...CACHE_EXPIRED, steps: 40, retentionRatio: 0.98 };
    const { hooks, foldPoint, profile } = foldPointHooks(config);
    const session = runSession(config, hooks);
    const fixed = runSession(config, fixedThresholdHooks(0.5));

    const learning = foldPoint.getProfileState(profile);
    // The EMA walks from the 0.4 cold-start prior towards the real 0.98.
    expect(learning.retentionRatioEma).toBeGreaterThan(0.7);
    expect(learning.retentionSamples).toBeGreaterThanOrEqual(3);

    const economic = session.compactions.filter((entry) => entry.action === "COMPACT");
    // The cold-start prior (retention 0.40) allows a few early economic compactions before
    // the EMA has seen enough real results; the observed number is 4, and every compaction
    // after them is a window-safety FORCE.
    expect(economic.length).toBeLessThanOrEqual(4);
    expect(session.compactions.length).toBeLessThan(fixed.compactions.length);
    expect(
      session.compactions.slice(economic.length).every((entry) => entry.action === "FORCE"),
    ).toBe(true);
  });

  it("never compacts twice inside the cooldown window", () => {
    const config: SessionConfig = { ...CACHE_EXPIRED, steps: 40, growthPerStep: 9_000 };
    const { hooks } = foldPointHooks(config);
    const session = runSession(config, hooks);

    for (let index = 1; index < session.compactions.length; index += 1) {
      const previous = session.compactions[index - 1];
      const current = session.compactions[index];
      if (!previous || !current) {
        throw new Error("missing compaction");
      }
      expect(current.step - previous.step).toBeGreaterThanOrEqual(3);
    }
  });

  it("a failed compaction keeps the session in cooldown but window safety still forces", () => {
    const profile = makeProfile({ cachePolicy: { ttlMs: CACHE_TTL_MS } });
    const foldPoint = new FoldPoint();
    const sessionId = "failure-session";
    const timestamp = BASE_TIMESTAMP;

    for (let index = 0; index < 6; index += 1) {
      foldPoint.observeRequest(sessionId, profile, {
        timestamp: timestamp + index,
        promptTokens: 150_000,
        cachedInputTokens: 0,
      });
    }

    foldPoint.recordCompaction(sessionId, profile, {
      timestamp: timestamp + 10,
      beforeTokens: 150_000,
      afterTokens: 40_000,
      success: false,
    });

    const blocked = foldPoint.decide({
      sessionId,
      profile,
      timestamp: timestamp + 11,
      contextTokens: 150_000,
      cachedTokens: 0,
      idleMs: 600_000,
    });
    const forced = foldPoint.decide({
      sessionId,
      profile,
      timestamp: timestamp + 12,
      contextTokens: 195_000,
      cachedTokens: 0,
      idleMs: 600_000,
    });

    expect(blocked.action).toBe("KEEP");
    expect(blocked.reasons).toContain("COOLDOWN_ACTIVE");
    expect(forced.action).toBe("FORCE");
  });

  it("keeps profile learning isolated between two compactors in the same session", () => {
    const foldPoint = new FoldPoint();
    const good = makeProfile({ compactorId: "good-compactor" });
    const bad = makeProfile({ compactorId: "bad-compactor" });

    foldPoint.recordCompaction("s", good, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      success: true,
    });
    foldPoint.recordCompaction("s", bad, {
      timestamp: BASE_TIMESTAMP + 1,
      beforeTokens: 100_000,
      afterTokens: 99_000,
      success: true,
    });

    expect(foldPoint.getProfileState(good).retentionRatioEma).toBeCloseTo(0.375, 12);
    expect(foldPoint.getProfileState(bad).retentionRatioEma).toBeCloseTo(0.5475, 12);
    expect(foldPoint.getProfileState(good).retentionSamples).toBe(1);
    expect(foldPoint.getProfileState(bad).retentionSamples).toBe(1);
  });
});
