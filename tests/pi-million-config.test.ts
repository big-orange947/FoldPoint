import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_REQUEST_CEILING_TOKENS,
  MILLION_ARMS,
  MILLION_KEEP_RECENT_TOKENS,
  MILLION_MODEL_WINDOW_TOKENS,
  MILLION_RUN_WINDOW_TOKENS,
  MILLION_SUMMARY_MAX_TOKENS,
  millionSystemPrompt,
  millionSystemPromptMarker,
  millionUserId,
  prepareMillionAgentDir,
} from "../tools/pi-million-config";

/** Length of the shared opening of two strings; the point at which their prefixes diverge. */
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
      expect(model.contextWindow).toBe(MILLION_RUN_WINDOW_TOKENS);
      expect(model.maxTokens).toBe(MILLION_SUMMARY_MAX_TOKENS);
      // The window is a run budget under the provider's ceiling, not the model's full 1M.
      expect(MILLION_RUN_WINDOW_TOKENS).toBeLessThan(MILLION_MODEL_WINDOW_TOKENS);
      expect(MILLION_RUN_WINDOW_TOKENS).toBeLessThan(DEEPSEEK_REQUEST_CEILING_TOKENS);
      expect(model.samplingParams).toEqual({ temperature: 0, user_id: millionUserId(id) });
      expect(model.cost).toBeUndefined();
      expect(settings.cacheWarming).toBe("off");
      expect(settings.defaultTools).toEqual([]);
      expect(settings.compaction).toEqual({
        enabled: true,
        reserveTokens: MILLION_ARMS[id].reserveTokens,
        keepRecentTokens: MILLION_KEEP_RECENT_TOKENS,
        modelOverrides: {},
      });
      // fixed60 compacts at 60% of the run budget; the others at Pi's own default threshold.
      // With the run budget at 800k: 800,000 - 16,384 = 783,616 and 800,000 - 0.4*800,000 = 480,000.
      expect(MILLION_RUN_WINDOW_TOKENS).toBe(800_000);
      expect(MILLION_RUN_WINDOW_TOKENS - settings.compaction.reserveTokens).toBe(
        id === "fixed60" ? 480_000 : 783_616,
      );
      expect(env.FOLDPOINT_MODE).toBe(MILLION_ARMS[id].foldPointMode);
      expect(env.FOLDPOINT_COMPACTION).toBe(MILLION_ARMS[id].foldPointCompaction);
      expect(env.FOLDPOINT_PRICE_SCENARIO).toBeUndefined();
    }
    expect(readFileSync(join(base, "models.json"), "utf8")).toBe(originalModels);
    expect(readFileSync(join(base, "settings.json"), "utf8")).toBe(originalSettings);
  });

  it("pins every arm's summary output budget to the same value, as high as the default arm allows", () => {
    // Pi budgets a compaction/overflow summary as min(floor(0.8 * reserveTokens), model.maxTokens)
    // (`D:\pi/packages/coding-agent/src/core/compaction/compaction.ts:734-737`). `reserveTokens`
    // differs by arm - 16,384 for default/dynamic, 320,000 for fixed60 - so the shared
    // `model.maxTokens` is the only thing that keeps the three summary budgets equal: uncapped,
    // fixed60's reserve would buy it a 256,000-token summary while the others got 13,107.
    const summaryBudget = (
      id: "default" | "fixed60" | "dynamic",
      cap = MILLION_SUMMARY_MAX_TOKENS,
    ) => Math.min(Math.floor(0.8 * MILLION_ARMS[id].reserveTokens), cap);
    const ids = ["default", "fixed60", "dynamic"] as const;
    const budgets = ids.map((id) => summaryBudget(id));
    expect(new Set(budgets).size).toBe(1);
    // The shared value is exactly the default arm's own ceiling, floor(0.8 * 16,384) = 13,107.
    expect(MILLION_SUMMARY_MAX_TOKENS).toBe(13_107);
    expect(budgets[0]).toBe(MILLION_SUMMARY_MAX_TOKENS);
    // It is the *largest* value that keeps the budgets equal: one token more and the default arm's
    // own reserve binds first, so fixed60 climbs above the other two and the arms stop being
    // summarized under the same budget. "Just raise the cap" is therefore not available here.
    const diverged = ids.map((id) => summaryBudget(id, MILLION_SUMMARY_MAX_TOKENS + 1));
    const [defaultBudget, fixedBudget] = diverged;
    expect(new Set(diverged).size).toBe(2);
    expect(fixedBudget).toBeGreaterThan(defaultBudget ?? 0);
    // Regression guard for the paid failures: the old 4,096 cap equalized the arms the same way
    // but truncated a summary of ~800k tokens of context, which Pi rejects as incomplete
    // (`compaction.ts:607-615`) and which killed both paid pilots on the overflow summary call
    // (`traces/pi-million-paid-pilot-02-report.json`: {stop: 101, length: 2}).
    expect(MILLION_SUMMARY_MAX_TOKENS).toBeGreaterThan(4_096);
  });

  it("gives every arm its own cache namespace, and never shares one between arms", () => {
    const ids = ["default", "fixed60", "dynamic"] as const;
    const namespaces = ids.map((id) => millionUserId(id));
    expect(new Set(namespaces).size).toBe(ids.length);
    // An arm's namespace must not move between runs: that is what makes its own cache
    // behaviour measurable. The cost is that re-running one arm can hit its own warm cache,
    // which the report has to say out loud.
    expect(millionUserId("dynamic")).toBe(millionUserId("dynamic"));
  });

  it("gives every arm a system-prompt preamble that diverges at the start of the prompt", () => {
    const ids = ["default", "fixed60", "dynamic"] as const;
    for (const id of ids) {
      // The arm marker is the preamble's first line, so the wire prefix of the three arms
      // diverges at the very start of the prompt instead of somewhere inside the conversation.
      expect(millionSystemPrompt(id).split("\n")[0]).toBe(millionSystemPromptMarker(id));
      expect(millionSystemPrompt(id).startsWith(millionSystemPromptMarker(id))).toBe(true);
      // The marker opens with an arm-specific letter, not with the arm's own name: "default"
      // and "dynamic" share a first letter, and a shared first character can be a shared first
      // token, which is the one thing this is supposed to rule out.
      expect(millionSystemPromptMarker(id)).toContain(id);
    }
    const markers = ids.map((id) => millionSystemPromptMarker(id));
    expect(new Set(markers).size).toBe(ids.length);
    // A cache hit requires matching a persisted prefix unit from token 0, so the strongest
    // claim the corpus can make is that no two arms share a first character at all. Assert the
    // strong version rather than the "diverges within the first couple of characters" version.
    const firstCharacters = new Set(markers.map((marker) => marker.slice(0, 1)));
    expect(firstCharacters.size).toBe(ids.length);
    // Everything after the marker is shared verbatim, so the arms stay comparable.
    const bodies = ids.map((id) =>
      millionSystemPrompt(id).slice(millionSystemPromptMarker(id).length),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it("writes the arm preamble to SYSTEM.md in the arm's own agent directory", () => {
    const base = baseDir();
    const seen = new Set<string>();
    for (const id of ["default", "fixed60", "dynamic"] as const) {
      const { agentDir, systemPrompt } = prepareMillionAgentDir(base, id);
      // Pi reads an agent-directory SYSTEM.md without a project-trust requirement and uses it as
      // the system prompt's preamble (`core/resource-loader.ts:1027-1039`).
      expect(readFileSync(join(agentDir, "SYSTEM.md"), "utf8")).toBe(`${systemPrompt}\n`);
      seen.add(systemPrompt);
    }
    expect(seen.size).toBe(3);
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
