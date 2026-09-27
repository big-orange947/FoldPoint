/** Isolated Pi settings for the 1M-window, three-arm compaction trial. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MILLION_WINDOW_TOKENS = 1_000_000;
export const MILLION_SUMMARY_MAX_TOKENS = 4_096;
export const MILLION_KEEP_RECENT_TOKENS = 20_000;

export type MillionArmId = "default" | "fixed60" | "dynamic";

export const MILLION_ARMS: Readonly<
  Record<
    MillionArmId,
    {
      reserveTokens: number;
      foldPointMode: "observe" | "act";
      foldPointCompaction: "off" | "auto";
    }
  >
> = {
  default: { reserveTokens: 16_384, foldPointMode: "observe", foldPointCompaction: "off" },
  fixed60: { reserveTokens: 400_000, foldPointMode: "observe", foldPointCompaction: "off" },
  dynamic: { reserveTokens: 16_384, foldPointMode: "act", foldPointCompaction: "auto" },
};

/** Create a fresh agent directory; never patch the caller's Pi configuration in place. */
export function prepareMillionAgentDir(
  base: string,
  arm: MillionArmId,
): {
  agentDir: string;
  env: {
    FOLDPOINT_MODE: "observe" | "act";
    FOLDPOINT_COMPACTION: "off" | "auto";
    FOLDPOINT_PRICE_SCENARIO: undefined;
  };
} {
  const armConfig = MILLION_ARMS[arm];
  if (armConfig === undefined) throw new Error(`Unknown 1M trial arm: ${arm}`);
  const baseModelsPath = join(base, "models.json");
  if (!existsSync(baseModelsPath)) {
    throw new Error(`The 1M trial requires an experiment models.json: ${baseModelsPath}`);
  }
  const models = JSON.parse(readFileSync(baseModelsPath, "utf8")) as {
    providers?: {
      deepseek?: { modelOverrides?: { "deepseek-flash"?: Record<string, unknown> } };
    };
  };
  const model = models.providers?.deepseek?.modelOverrides?.["deepseek-flash"];
  if (model === undefined) {
    throw new Error("The 1M trial requires deepseek/deepseek-flash modelOverrides");
  }
  if (model.cost !== undefined) {
    throw new Error(
      "The 1M trial requires native DeepSeek prices; remove the experiment cost override",
    );
  }
  // Pi uses reserveTokens for both its threshold and its summary budget. Capping model
  // output identically prevents fixed60's 400K reserve from changing *how* Pi summarizes.
  model.contextWindow = MILLION_WINDOW_TOKENS;
  model.maxTokens = MILLION_SUMMARY_MAX_TOKENS;
  model.samplingParams = { temperature: 0 };

  const settingsPath = join(base, "settings.json");
  const settings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Invalid Pi settings object: ${settingsPath}`);
  }
  settings.compaction = {
    enabled: true,
    reserveTokens: armConfig.reserveTokens,
    keepRecentTokens: MILLION_KEEP_RECENT_TOKENS,
    modelOverrides: {},
  };
  settings.cacheWarming = "off";
  // Source-reading trial: answer only from staged material, not by reading the local Pi checkout.
  settings.defaultTools = [];

  const agentDir = mkdtempSync(join(base, "foldpoint-1m-"));
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(sessionDir);
  settings.sessionDir = sessionDir;
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return {
    agentDir,
    env: {
      FOLDPOINT_MODE: armConfig.foldPointMode,
      FOLDPOINT_COMPACTION: armConfig.foldPointCompaction,
      FOLDPOINT_PRICE_SCENARIO: undefined,
    },
  };
}
