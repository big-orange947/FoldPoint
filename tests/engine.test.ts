import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  decideFoldPoint,
  FoldPoint,
  type FoldPointProfile,
  type FoldPointState,
  profileKey,
  resolveDefaults,
  sessionKey,
} from "../src/index";
import {
  BASE_TIMESTAMP,
  HISTORY,
  makeInput,
  makeLearning,
  makeProfile,
  makeSession,
  SESSION_A,
  SESSION_B,
} from "./helpers";

function seeded(profile: FoldPointProfile, learning: Record<string, unknown> = {}): FoldPoint {
  return new FoldPoint({
    state: {
      version: 2,
      profiles: { [profileKey(profile)]: { ...makeLearning(HISTORY), ...learning } },
      sessions: {},
    },
  });
}

describe("FoldPoint engine", () => {
  it("keeps decide read-only with respect to learned state", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 100_000,
      cachedInputTokens: 80_000,
    });

    const before = foldPoint.exportState();
    foldPoint.decide(makeInput({ sessionId: SESSION_A, profile, contextTokens: 150_000 }));
    foldPoint.decide(makeInput({ sessionId: SESSION_A, profile, contextTokens: 150_000 }));

    expect(foldPoint.exportState()).toEqual(before);
  });

  it("isolates learning state per profile", () => {
    const first = makeProfile({ compactorId: "compactor-a" });
    const second = makeProfile({ compactorId: "compactor-b" });
    const otherModel = makeProfile({ model: "other-model" });
    const otherWindow = makeProfile({ contextWindowTokens: 128_000 });

    const foldPoint = new FoldPoint();
    foldPoint.recordCompaction(SESSION_A, first, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      success: true,
    });

    expect(foldPoint.getProfileState(first).retentionSamples).toBe(1);
    expect(foldPoint.getProfileState(second).retentionSamples).toBe(0);
    expect(foldPoint.getProfileState(otherModel).retentionSamples).toBe(0);
    expect(foldPoint.getProfileState(otherWindow).retentionSamples).toBe(0);
    expect(profileKey(first)).not.toBe(profileKey(second));
  });

  it("returns copies of state, never live references", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    const learning = foldPoint.getProfileState(profile);
    const session = foldPoint.getSessionState(SESSION_A, profile);
    learning.retentionSamples = 99;
    session.requestCount = 99;

    expect(foldPoint.getProfileState(profile).retentionSamples).toBe(0);
    expect(foldPoint.getSessionState(SESSION_A, profile).requestCount).toBe(0);
  });

  it("resets a profile and a session independently", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 1_000,
    });

    foldPoint.resetSession(SESSION_A, profile);
    expect(foldPoint.getSessionState(SESSION_A, profile).requestCount).toBe(0);

    foldPoint.recordCompaction(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 1_000,
      afterTokens: 500,
      success: true,
    });
    foldPoint.resetProfile(profile);
    expect(foldPoint.getProfileState(profile).retentionSamples).toBe(0);
  });

  it("validates profiles and session ids", () => {
    const foldPoint = new FoldPoint();

    expect(() => foldPoint.getProfileState(makeProfile({ model: "" }))).toThrow(RangeError);
    expect(() => foldPoint.getSessionState("", makeProfile())).toThrow(RangeError);
    expect(() =>
      foldPoint.observeRequest("", makeProfile(), { timestamp: 0, promptTokens: 0 }),
    ).toThrow(RangeError);
  });

  it("keeps the pure function and the engine in agreement", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    for (let index = 0; index < 4; index += 1) {
      foldPoint.observeRequest(SESSION_A, profile, {
        timestamp: BASE_TIMESTAMP + index,
        promptTokens: 100_000,
        cachedInputTokens: 70_000,
      });
    }

    const input = makeInput({
      sessionId: SESSION_A,
      profile,
      contextTokens: 150_000,
      cachedTokens: 90_000,
    });
    expect(foldPoint.decide(input)).toEqual(
      decideFoldPoint(
        input,
        foldPoint.getProfileState(profile),
        foldPoint.getSessionState(SESSION_A, profile),
        { defaults: foldPoint.getDefaults() },
      ),
    );
  });

  it("does not share state between engine instances", () => {
    const profile = makeProfile();
    const first = new FoldPoint();
    const second = new FoldPoint();
    first.observeRequest(SESSION_A, profile, { timestamp: BASE_TIMESTAMP, promptTokens: 1_000 });

    expect(first.getSessionState(SESSION_A, profile).requestCount).toBe(1);
    expect(second.getSessionState(SESSION_A, profile).requestCount).toBe(0);
  });

  it("exposes the resolved defaults", () => {
    expect(resolveDefaults({ emaAlpha: 0.5 }).emaAlpha).toBe(0.5);
    expect(resolveDefaults().retentionRatio).toBe(DEFAULTS.retentionRatio);
    expect(
      new FoldPoint({ defaults: { expectedFutureCalls: 9 } }).getDefaults().expectedFutureCalls,
    ).toBe(9);
  });
});

describe("12. session isolation", () => {
  it("12.1 one session's cooldown does not block another session", () => {
    const profile = makeProfile();
    const foldPoint = seeded(profile);

    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 100_000,
    });
    foldPoint.recordCompaction(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP + 1,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      success: true,
    });

    const decisionA = foldPoint.decide({
      sessionId: SESSION_A,
      profile,
      timestamp: BASE_TIMESTAMP + 2,
      contextTokens: 100_000,
    });
    const decisionB = foldPoint.decide({
      sessionId: SESSION_B,
      profile,
      timestamp: BASE_TIMESTAMP + 2,
      contextTokens: 100_000,
    });

    expect(decisionA.reasons).toContain("COOLDOWN_ACTIVE");
    expect(decisionB.reasons).not.toContain("COOLDOWN_ACTIVE");
  });

  it("12.2 one session's request time does not extend another session's cache", () => {
    const profile = makeProfile({ cachePolicy: { ttlMs: 300_000 } });
    const foldPoint = new FoldPoint();

    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 100_000,
      cachedInputTokens: 90_000,
    });
    foldPoint.observeRequest(SESSION_B, profile, {
      timestamp: BASE_TIMESTAMP - 10_000_000,
      promptTokens: 100_000,
      cachedInputTokens: 90_000,
    });

    const decisionB = foldPoint.decide({
      sessionId: SESSION_B,
      profile,
      timestamp: BASE_TIMESTAMP,
      contextTokens: 100_000,
      cachedTokens: 90_000,
    });
    const decisionA = foldPoint.decide({
      sessionId: SESSION_A,
      profile,
      timestamp: BASE_TIMESTAMP,
      contextTokens: 100_000,
      cachedTokens: 90_000,
    });

    expect(decisionB.metrics.estimatedCacheAliveProbability).toBe(0);
    expect(decisionA.metrics.estimatedCacheAliveProbability).toBe(1);
  });

  it("12.3 a finished session's learning is reusable, its runtime state is not", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.recordCompaction(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 25_000,
      success: true,
    });
    foldPoint.endSession(SESSION_A, profile, { timestamp: BASE_TIMESTAMP + 1 });

    const decision = foldPoint.decide({
      sessionId: SESSION_B,
      profile,
      timestamp: BASE_TIMESTAMP + 2,
      contextTokens: 150_000,
      cachedTokens: 0,
    });

    // retention 0.25 blended with the 0.4 prior = 0.3625
    expect(decision.metrics.estimatedPostCompactTokens).toBeCloseTo(150_000 * 0.3625, 6);
    expect(decision.reasons).not.toContain("COOLDOWN_ACTIVE");
    expect(decision.metrics.callsSinceLastAttempt).toBe(0);
  });

  it("12.5 interleaved sessions never touch each other's runtime state", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 10_000,
    });
    foldPoint.observeRequest(SESSION_B, profile, {
      timestamp: BASE_TIMESTAMP + 1,
      promptTokens: 10_000,
    });
    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP + 2,
      promptTokens: 10_000,
    });
    foldPoint.recordCompaction(SESSION_B, profile, {
      timestamp: BASE_TIMESTAMP + 3,
      beforeTokens: 10_000,
      afterTokens: 3_000,
      success: true,
    });
    foldPoint.decide({
      sessionId: SESSION_A,
      profile,
      timestamp: BASE_TIMESTAMP + 4,
      contextTokens: 30_000,
    });

    const sessionA = foldPoint.getSessionState(SESSION_A, profile);
    const sessionB = foldPoint.getSessionState(SESSION_B, profile);

    expect(sessionA.requestCount).toBe(2);
    expect(sessionA.callsSinceLastAttempt).toBe(2);
    expect(sessionA.compactionAttemptCount).toBe(0);
    expect(sessionB.requestCount).toBe(1);
    expect(sessionB.compactionAttemptCount).toBe(1);
    expect(sessionB.callsSinceLastAttempt).toBe(0);
  });
});

describe("17.13 / 17.14 key collisions", () => {
  it("17.13 profile keys cannot collide across a separator", () => {
    const a = { provider: "a|b", model: "c", contextWindowTokens: 100, compactorId: "d" };
    const b = { provider: "a", model: "b|c", contextWindowTokens: 100, compactorId: "d" };

    expect(profileKey(a)).not.toBe(profileKey(b));

    const foldPoint = new FoldPoint();
    foldPoint.recordCompaction(SESSION_A, a, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 1_000,
      afterTokens: 500,
      success: true,
    });
    expect(foldPoint.getProfileState(a).retentionSamples).toBe(1);
    expect(foldPoint.getProfileState(b).retentionSamples).toBe(0);
  });

  it("17.14 session keys cannot collide across a separator", () => {
    const a = { provider: "a", model: "b", contextWindowTokens: 100, compactorId: "c" };
    const b = { provider: "a", model: "b", contextWindowTokens: 100, compactorId: "c" };

    expect(sessionKey("x", a)).not.toBe(sessionKey("y", b));
    expect(sessionKey("a|b", a)).not.toBe(sessionKey("a", b));
    expect(sessionKey("s", a)).not.toBe(sessionKey("s", { ...a, model: "b|c" }));
  });
});

describe("state lifecycle", () => {
  it("endSession deletes the session runtime state and keeps profile learning", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 10_000,
    });
    foldPoint.recordCompaction(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP + 1,
      beforeTokens: 10_000,
      afterTokens: 3_000,
      success: true,
    });
    foldPoint.endSession(SESSION_A, profile, { timestamp: BASE_TIMESTAMP + 2 });

    const exported = foldPoint.exportState();
    expect(exported.version).toBe(2);
    expect(Object.keys(exported.sessions)).toHaveLength(0);
    expect(Object.keys(exported.profiles)).toHaveLength(1);
    expect(foldPoint.getProfileState(profile).retentionSamples).toBe(1);
    expect(foldPoint.getSessionState(SESSION_A, profile).requestCount).toBe(0);
  });

  it("endSession on an unknown session is a no-op", () => {
    const foldPoint = new FoldPoint();
    expect(() =>
      foldPoint.endSession(SESSION_A, makeProfile(), { timestamp: BASE_TIMESTAMP }),
    ).not.toThrow();
    expect(Object.keys(foldPoint.exportState().sessions)).toHaveLength(0);
  });

  it("rejects a pre-release version 1 snapshot with a clear message", () => {
    const foldPoint = new FoldPoint();

    expect(() =>
      foldPoint.importState({ version: 1, profiles: {} } as unknown as FoldPointState),
    ).toThrow(
      "Unsupported FoldPoint state version: 1. This pre-release snapshot must be reset before using state version 2.",
    );
    expect(() => foldPoint.importState({ version: 3 } as unknown as FoldPointState)).toThrow(
      RangeError,
    );
  });

  it("imports state through the constructor", () => {
    const profile = makeProfile();
    const source = new FoldPoint();
    source.observeRequest(SESSION_A, profile, { timestamp: BASE_TIMESTAMP, promptTokens: 1_000 });
    source.recordCompaction(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP + 1,
      beforeTokens: 1_000,
      afterTokens: 400,
      success: true,
    });

    const target = new FoldPoint({ state: source.exportState() });

    expect(target.exportState()).toEqual(source.exportState());
    expect(target.getSessionState(SESSION_A, profile)).toEqual(
      source.getSessionState(SESSION_A, profile),
    );
  });

  it("uses a fresh session state for an unknown session", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    expect(foldPoint.getSessionState("never-seen", profile)).toEqual(makeSession());
  });
});
