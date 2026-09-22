import { describe, expect, it } from "vitest";
import { DEFAULTS, decideFoldPoint, FoldPoint, profileKey, resolveDefaults } from "../src/index";
import { BASE_TIMESTAMP, HISTORY, makeInput, makeProfile } from "./helpers";

describe("FoldPoint engine", () => {
  it("keeps decide read-only with respect to learned state", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();
    foldPoint.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 100_000,
      cachedInputTokens: 80_000,
    });

    const before = foldPoint.exportState();
    foldPoint.decide(makeInput({ profile, contextTokens: 150_000 }));
    foldPoint.decide(makeInput({ profile, contextTokens: 150_000 }));
    const after = foldPoint.exportState();

    expect(after).toEqual(before);
  });

  it("isolates state per profile", () => {
    const first = makeProfile({ compactorId: "compactor-a" });
    const second = makeProfile({ compactorId: "compactor-b" });
    const otherModel = makeProfile({ model: "other-model" });
    const otherWindow = makeProfile({ contextWindowTokens: 128_000 });

    const foldPoint = new FoldPoint();
    foldPoint.recordCompaction(first, {
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

  it("returns copies of profile state, never live references", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    const snapshot = foldPoint.getProfileState(profile);
    snapshot.retentionSamples = 99;

    expect(foldPoint.getProfileState(profile).retentionSamples).toBe(0);
  });

  it("forgets one profile on reset", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.observeRequest(profile, { timestamp: BASE_TIMESTAMP, promptTokens: 1_000 });
    expect(foldPoint.getProfileState(profile).requestCount).toBe(1);

    foldPoint.resetProfile(profile);
    expect(foldPoint.getProfileState(profile).requestCount).toBe(0);
  });

  it("imports state through the constructor and through importState", () => {
    const profile = makeProfile();
    const source = new FoldPoint();
    source.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 1_000,
      cachedInputTokens: 200,
    });

    const target = new FoldPoint();
    target.importState(source.exportState());
    expect(target.getProfileState(profile)).toEqual(source.getProfileState(profile));

    const viaConstructor = new FoldPoint({ state: source.exportState() });
    expect(viaConstructor.getProfileState(profile)).toEqual(source.getProfileState(profile));
  });

  it("replaces the whole state on import", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.observeRequest(profile, { timestamp: BASE_TIMESTAMP, promptTokens: 1_000 });
    foldPoint.importState({ version: 1, profiles: {} });

    expect(foldPoint.exportState().profiles).toEqual({});
  });

  it("applies default overrides", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint({ defaults: { minReclaimTokens: 0, softWindowRatio: 0.5 } });
    const defaults = foldPoint.getDefaults();

    expect(defaults.minReclaimTokens).toBe(0);
    expect(defaults.softWindowRatio).toBe(0.5);
    expect(defaults.hardWindowRatio).toBe(DEFAULTS.hardWindowRatio);

    const decision = foldPoint.decide(makeInput({ profile, contextTokens: 50_000 }));
    expect(decision.metrics.utilization).toBeCloseTo(0.25, 10);
  });

  it("validates profiles before touching state", () => {
    const foldPoint = new FoldPoint();

    expect(() => foldPoint.getProfileState(makeProfile({ model: "" }))).toThrow(RangeError);
    expect(() => foldPoint.getProfileState(makeProfile({ contextWindowTokens: -1 }))).toThrow(
      RangeError,
    );
    expect(() =>
      foldPoint.observeRequest(makeProfile({ compactorId: "" }), { timestamp: 0, promptTokens: 0 }),
    ).toThrow(RangeError);
  });

  it("ignores endSession for an unknown profile", () => {
    const foldPoint = new FoldPoint();
    expect(() => foldPoint.endSession(makeProfile(), { timestamp: BASE_TIMESTAMP })).not.toThrow();
    expect(foldPoint.exportState().profiles).toEqual({});
  });

  it("keeps learned state consistent with the pure function", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    for (let index = 0; index < 4; index += 1) {
      foldPoint.observeRequest(profile, {
        timestamp: BASE_TIMESTAMP + index,
        promptTokens: 100_000,
        cachedInputTokens: 70_000,
      });
    }

    const state = foldPoint.getProfileState(profile);
    const input = makeInput({ profile, contextTokens: 150_000, cachedTokens: 90_000 });
    expect(foldPoint.decide(input)).toEqual(
      decideFoldPoint(input, state, { defaults: foldPoint.getDefaults() }),
    );
  });

  it("exposes the resolved defaults used for a decision", () => {
    expect(resolveDefaults({ emaAlpha: 0.5 }).emaAlpha).toBe(0.5);
    expect(resolveDefaults().retentionRatio).toBe(DEFAULTS.retentionRatio);
    expect(
      new FoldPoint({ defaults: { expectedFutureCalls: 9 } }).getDefaults().expectedFutureCalls,
    ).toBe(9);
  });

  it("does not share state between engine instances", () => {
    const profile = makeProfile();
    const first = new FoldPoint();
    const second = new FoldPoint();
    first.observeRequest(profile, { timestamp: BASE_TIMESTAMP, promptTokens: 1_000 });

    expect(first.getProfileState(profile).requestCount).toBe(1);
    expect(second.getProfileState(profile).requestCount).toBe(0);
  });

  it("carries learned history into decisions", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.importState({
      version: 1,
      profiles: { [profileKey(profile)]: { ...foldPoint.getProfileState(profile), ...HISTORY } },
    });

    const decision = foldPoint.decide(
      makeInput({ profile, contextTokens: 150_000, cachedTokens: 140_000 }),
    );
    expect(decision.metrics.compactionSamples).toBe(4);
    expect(decision.metrics.callsSinceLastCompaction).toBe(10);
  });
});
