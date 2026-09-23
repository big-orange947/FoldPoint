import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  decideFoldPoint,
  FoldPoint,
  type FoldPointState,
  profileKey,
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

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const FORBIDDEN_CONTENT_KEYS = [
  "messages",
  "content",
  "promptText",
  "systemPrompt",
  "conversationText",
];

/** Source with comments removed, so documentation prose cannot trip the boundary checks. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSources(): Array<{ name: string; text: string }> {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: stripComments(readFileSync(join(SRC_DIR, name), "utf8")) }));
}

function collectKeys(value: unknown, keys: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKeys(entry, keys);
    }
    return keys;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

describe("17.16 state v2 serialization", () => {
  it("round-trips profiles and sessions through JSON and keeps producing identical decisions", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    for (let index = 0; index < 5; index += 1) {
      foldPoint.observeRequest(SESSION_A, profile, {
        timestamp: BASE_TIMESTAMP + index * 1_000,
        promptTokens: 100_000,
        cachedInputTokens: 80_000,
        outputTokens: 400,
      });
    }
    foldPoint.recordCompaction(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP + 6_000,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      promptTokens: 100_000,
      outputTokens: 6_000,
      success: true,
    });
    for (let index = 0; index < 4; index += 1) {
      foldPoint.observeRequest(SESSION_A, profile, {
        timestamp: BASE_TIMESTAMP + 7_000 + index * 1_000,
        promptTokens: 120_000,
        cachedInputTokens: 100_000,
      });
    }
    foldPoint.observeRequest(SESSION_B, profile, {
      timestamp: BASE_TIMESTAMP + 20_000,
      promptTokens: 50_000,
      cachedInputTokens: 10_000,
    });

    const exported = foldPoint.exportState();
    const restored = new FoldPoint({
      state: JSON.parse(JSON.stringify(exported)) as FoldPointState,
    });

    expect(exported.version).toBe(2);
    expect(Object.keys(exported.profiles)).toHaveLength(1);
    expect(Object.keys(exported.sessions)).toHaveLength(2);
    expect(restored.exportState()).toEqual(exported);

    const inputA = makeInput({
      sessionId: SESSION_A,
      profile,
      contextTokens: 150_000,
      cachedTokens: 100_000,
    });
    const inputB = makeInput({
      sessionId: SESSION_B,
      profile,
      contextTokens: 60_000,
      cachedTokens: 10_000,
    });
    expect(restored.decide(inputA)).toEqual(foldPoint.decide(inputA));
    expect(restored.decide(inputB)).toEqual(foldPoint.decide(inputB));
  });

  it("removes the session on endSession and keeps the profile learning", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.recordCompaction(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      success: true,
    });

    expect(Object.keys(foldPoint.exportState().sessions)).toHaveLength(1);

    foldPoint.endSession(SESSION_A, profile, { timestamp: BASE_TIMESTAMP + 1 });

    const exported = foldPoint.exportState();
    expect(Object.keys(exported.sessions)).toHaveLength(0);
    expect(exported.profiles[profileKey(profile)]?.retentionSamples).toBe(1);

    const restored = new FoldPoint({
      state: JSON.parse(JSON.stringify(exported)) as FoldPointState,
    });
    expect(restored.getProfileState(profile).retentionSamples).toBe(1);
    expect(restored.getSessionState(SESSION_A, profile)).toEqual(makeSession());
  });

  it("fills missing fields with defaults and ignores unknown fields", () => {
    const profile = makeProfile();
    const partial = {
      version: 2,
      profiles: {
        [profileKey(profile)]: {
          retentionSamples: 2,
          retentionRatioEma: 0.3,
          somethingFromTheFuture: { nested: true },
        },
      },
      sessions: {
        [sessionKey(SESSION_A, profile)]: {
          requestCount: 7,
          anotherUnknownField: 42,
        },
      },
    } as unknown as FoldPointState;

    const foldPoint = new FoldPoint({ state: partial });
    const learning = foldPoint.getProfileState(profile);
    const session = foldPoint.getSessionState(SESSION_A, profile);

    expect(learning.retentionSamples).toBe(2);
    expect(learning.retentionRatioEma).toBeCloseTo(0.3, 12);
    expect(learning.cacheCoverageRatioEma).toBe(0);
    expect(learning.compactCostScaleEma).toBe(1);
    expect(learning.reuseHorizonEma).toBe(3);
    expect("somethingFromTheFuture" in learning).toBe(false);

    expect(session.requestCount).toBe(7);
    expect(session.compactionAttemptCount).toBe(0);
    expect("anotherUnknownField" in session).toBe(false);
  });

  it("normalizes illegal numbers instead of throwing", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint({
      state: {
        version: 2,
        profiles: {
          [profileKey(profile)]: {
            ...makeLearning(HISTORY),
            retentionRatioEma: Number.NaN,
            compactCostScaleEma: 1_000,
            retentionSamples: -5,
          },
        },
        sessions: {
          [sessionKey(SESSION_A, profile)]: { requestCount: Number.POSITIVE_INFINITY },
        },
      } as unknown as FoldPointState,
    });

    const learning = foldPoint.getProfileState(profile);
    expect(learning.retentionRatioEma).toBe(0.4);
    expect(learning.retentionSamples).toBe(0);
    expect(learning.compactCostScaleEma).toBe(10);
    expect(foldPoint.getSessionState(SESSION_A, profile).requestCount).toBe(0);
  });

  it("rejects the pre-release version 1 snapshot", () => {
    const foldPoint = new FoldPoint();
    expect(() =>
      foldPoint.importState({ version: 1, profiles: {} } as unknown as FoldPointState),
    ).toThrow(/Unsupported FoldPoint state version: 1/);
  });

  it("contains no absolute currency amount in exported state", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.recordCompaction(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      promptTokens: 100_000,
      outputTokens: 5_000,
      actualCost: 0.75,
      success: true,
    });

    const keys = collectKeys(foldPoint.exportState());
    for (const forbidden of [
      "compactionCostEma",
      "compactionCostSamples",
      "costEma",
      "currencyAmount",
    ]) {
      expect(keys.has(forbidden), `state exposes ${forbidden}`).toBe(false);
    }
  });
});

describe("17.7 privacy and boundary checks", () => {
  it("42. public types and payloads carry no message content", () => {
    for (const source of readSources()) {
      for (const key of FORBIDDEN_CONTENT_KEYS) {
        const declaration = new RegExp(`\\b${key}\\s*\\??\\s*:`);
        expect(declaration.test(source.text), `${source.name} declares "${key}"`).toBe(false);
      }
    }

    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 10_000,
      cachedInputTokens: 5_000,
    });
    const decision = decideFoldPoint(
      makeInput({ sessionId: SESSION_A, profile, contextTokens: 50_000 }),
      makeLearning(HISTORY),
      makeSession(),
    );

    const keys = new Set([...collectKeys(decision), ...collectKeys(foldPoint.exportState())]);
    for (const key of FORBIDDEN_CONTENT_KEYS) {
      expect(keys.has(key), `payload exposes "${key}"`).toBe(false);
    }
  });

  it("43. no API key or secret can reach exported state", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.observeRequest(SESSION_A, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 10_000,
      cachedInputTokens: 5_000,
    });

    const serialized = JSON.stringify(foldPoint.exportState());
    expect(/api[_-]?key|secret|bearer|authorization|password|sk-[a-z0-9]/i.test(serialized)).toBe(
      false,
    );

    for (const source of readSources()) {
      expect(/process\s*\.\s*env/.test(source.text), `${source.name} reads process.env`).toBe(
        false,
      );
    }
  });

  it("44. performs no network access while deciding", async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      const foldPoint = new FoldPoint();
      const profile = makeProfile();
      foldPoint.observeRequest(SESSION_A, profile, {
        timestamp: BASE_TIMESTAMP,
        promptTokens: 10_000,
        cachedInputTokens: 5_000,
      });
      foldPoint.decide({
        sessionId: SESSION_A,
        profile,
        timestamp: BASE_TIMESTAMP + 1,
        contextTokens: 150_000,
        safeBoundary: true,
      });
      foldPoint.recordCompaction(SESSION_A, profile, {
        timestamp: BASE_TIMESTAMP + 2,
        beforeTokens: 150_000,
        afterTokens: 60_000,
        success: true,
      });
      foldPoint.endSession(SESSION_A, profile, { timestamp: BASE_TIMESTAMP + 3 });
      await Promise.resolve();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();

    for (const source of readSources()) {
      expect(
        /\bfetch\s*\(|XMLHttpRequest|https?:\/\//.test(source.text),
        `${source.name} references the network`,
      ).toBe(false);
    }
  });

  it("45. never calls a model: core is synchronous, dependency-free and has no async work", () => {
    for (const source of readSources()) {
      const imports = [...source.text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      for (const specifier of imports) {
        expect(specifier?.startsWith("."), `${source.name} imports "${specifier}"`).toBe(true);
      }
      expect(/\basync\b|\bawait\b/.test(source.text), `${source.name} contains async work`).toBe(
        false,
      );
      expect(
        /\bopenai\b|\banthropic\b|\bchat\.completions\b/i.test(source.text),
        `${source.name} mentions a model API`,
      ).toBe(false);
    }

    const decision = decideFoldPoint(
      makeInput({ sessionId: SESSION_A, contextTokens: 50_000 }),
      makeLearning(HISTORY),
      makeSession(),
    );
    expect(decision).not.toBeInstanceOf(Promise);
    expect(typeof decision.action).toBe("string");
  });
});
