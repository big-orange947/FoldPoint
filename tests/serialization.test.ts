import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { decideFoldPoint, FoldPoint, type FoldPointState } from "../src/index";
import { BASE_TIMESTAMP, HISTORY, makeInput, makeProfile, makeState } from "./helpers";

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

describe("state serialization", () => {
  it("round-trips through JSON and keeps producing identical decisions", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    for (let index = 0; index < 5; index += 1) {
      foldPoint.observeRequest(profile, {
        timestamp: BASE_TIMESTAMP + index * 1_000,
        promptTokens: 100_000,
        cachedInputTokens: 80_000,
        outputTokens: 400,
      });
    }
    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP + 6_000,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      promptTokens: 100_000,
      outputTokens: 6_000,
      success: true,
    });
    for (let index = 0; index < 4; index += 1) {
      foldPoint.observeRequest(profile, {
        timestamp: BASE_TIMESTAMP + 7_000 + index * 1_000,
        promptTokens: 120_000,
        cachedInputTokens: 100_000,
      });
    }
    foldPoint.endSession(profile, { timestamp: BASE_TIMESTAMP + 20_000 });

    const exported = foldPoint.exportState();
    const restored = new FoldPoint({
      state: JSON.parse(JSON.stringify(exported)) as FoldPointState,
    });

    expect(restored.exportState()).toEqual(exported);
    expect(restored.getProfileState(profile)).toEqual(foldPoint.getProfileState(profile));

    const input = makeInput({ contextTokens: 150_000, cachedTokens: 100_000, profile });
    expect(restored.decide(input)).toEqual(foldPoint.decide(input));
  });

  it("exports plain JSON with a version and no undefined placeholders", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 1_000,
      cachedInputTokens: 500,
    });

    const exported = foldPoint.exportState();
    expect(exported.version).toBe(1);
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);

    const state = foldPoint.getProfileState(profile);
    expect(state.version).toBe(1);
    for (const value of Object.values(state)) {
      expect(value === undefined || typeof value === "number" || typeof value === "string").toBe(
        true,
      );
    }
  });

  it("fills missing fields with defaults and ignores unknown fields", () => {
    const profile = makeProfile();
    const partial = {
      version: 1,
      profiles: {
        [foldPointKey(profile)]: {
          retentionSamples: 2,
          retentionRatioEma: 0.3,
          somethingFromTheFuture: { nested: true },
        },
      },
    } as unknown as FoldPointState;

    const foldPoint = new FoldPoint({ state: partial });
    const state = foldPoint.getProfileState(profile);

    expect(state.retentionSamples).toBe(2);
    expect(state.retentionRatioEma).toBeCloseTo(0.3, 12);
    expect(state.requestCount).toBe(0);
    expect(state.cacheHitRatioEma).toBe(0);
    expect(state.reuseHorizonEma).toBe(3);
    expect("somethingFromTheFuture" in state).toBe(false);
  });

  it("rejects an unsupported state version", () => {
    const foldPoint = new FoldPoint();
    expect(() =>
      foldPoint.importState({ version: 2, profiles: {} } as unknown as FoldPointState),
    ).toThrow(RangeError);
  });
});

function foldPointKey(profile: ReturnType<typeof makeProfile>): string {
  return [
    profile.provider ?? "",
    profile.model,
    String(profile.contextWindowTokens),
    profile.compactorId,
  ].join("|");
}

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
    foldPoint.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 10_000,
      cachedInputTokens: 5_000,
    });
    const decision = decideFoldPoint(
      makeInput({ profile, contextTokens: 50_000 }),
      makeState(HISTORY),
    );

    const keys = new Set([...collectKeys(decision), ...collectKeys(foldPoint.exportState())]);
    for (const key of FORBIDDEN_CONTENT_KEYS) {
      expect(keys.has(key), `payload exposes "${key}"`).toBe(false);
    }
  });

  it("43. no API key or secret can reach exported state", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 10_000,
      cachedInputTokens: 5_000,
    });
    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP + 1,
      beforeTokens: 10_000,
      afterTokens: 4_000,
      success: true,
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
      foldPoint.observeRequest(profile, {
        timestamp: BASE_TIMESTAMP,
        promptTokens: 10_000,
        cachedInputTokens: 5_000,
      });
      foldPoint.decide({
        profile,
        timestamp: BASE_TIMESTAMP + 1,
        contextTokens: 150_000,
        safeBoundary: true,
      });
      foldPoint.recordCompaction(profile, {
        timestamp: BASE_TIMESTAMP + 2,
        beforeTokens: 150_000,
        afterTokens: 60_000,
        success: true,
      });
      foldPoint.endSession(profile, { timestamp: BASE_TIMESTAMP + 3 });
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

    const decision = decideFoldPoint(makeInput({ contextTokens: 50_000 }), makeState(HISTORY));
    expect(decision).not.toBeInstanceOf(Promise);
    expect(typeof decision.action).toBe("string");
  });
});
