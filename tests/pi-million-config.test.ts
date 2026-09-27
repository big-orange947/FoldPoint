import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MILLION_ARMS,
  MILLION_KEEP_RECENT_TOKENS,
  MILLION_SUMMARY_MAX_TOKENS,
  MILLION_WINDOW_TOKENS,
  prepareMillionAgentDir,
} from "../tools/pi-million-config";

function baseDir(): string {
  const base = mkdtempSync(join(tmpdir(), "foldpoint-million-config-"));
  writeFileSync(
    join(base, "models.json"),
    JSON.stringify({
      providers: { deepseek: { modelOverrides: { "deepseek-flash": { contextWindow: 26_000 } } } },
    }),
  );
  writeFileSync(join(base, "settings.json"), JSON.stringify({ cacheWarming: "streaming" }));
  return base;
}

describe("1M Pi trial arm isolation", () => {
  it("changes only the timing policy across the three arms", () => {
    const base = baseDir();
    const originalModels = readFileSync(join(base, "models.json"), "utf8");
    const originalSettings = readFileSync(join(base, "settings.json"), "utf8");

    for (const id of ["default", "fixed60", "dynamic"] as const) {
      const { agentDir, env } = prepareMillionAgentDir(base, id);
      const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
      const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      const model = models.providers.deepseek.modelOverrides["deepseek-flash"];
      expect(model.contextWindow).toBe(MILLION_WINDOW_TOKENS);
      expect(model.maxTokens).toBe(MILLION_SUMMARY_MAX_TOKENS);
      expect(model.samplingParams).toEqual({ temperature: 0 });
      expect(model.cost).toBeUndefined();
      expect(settings.cacheWarming).toBe("off");
      expect(settings.defaultTools).toEqual([]);
      expect(settings.compaction).toEqual({
        enabled: true,
        reserveTokens: MILLION_ARMS[id].reserveTokens,
        keepRecentTokens: MILLION_KEEP_RECENT_TOKENS,
        modelOverrides: {},
      });
      expect(MILLION_WINDOW_TOKENS - settings.compaction.reserveTokens).toBe(
        id === "fixed60" ? 600_000 : 983_616,
      );
      expect(env.FOLDPOINT_MODE).toBe(MILLION_ARMS[id].foldPointMode);
      expect(env.FOLDPOINT_COMPACTION).toBe(MILLION_ARMS[id].foldPointCompaction);
      expect(env.FOLDPOINT_PRICE_SCENARIO).toBeUndefined();
    }
    expect(readFileSync(join(base, "models.json"), "utf8")).toBe(originalModels);
    expect(readFileSync(join(base, "settings.json"), "utf8")).toBe(originalSettings);
  });

  it("refuses to treat a hypothetical price override as a native DeepSeek bill", () => {
    const base = baseDir();
    writeFileSync(
      join(base, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            modelOverrides: {
              "deepseek-flash": { cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 } },
            },
          },
        },
      }),
    );
    expect(() => prepareMillionAgentDir(base, "default")).toThrow(/native DeepSeek prices/);
  });
});
