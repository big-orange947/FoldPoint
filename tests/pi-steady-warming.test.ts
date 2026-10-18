import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const cli = join(
  resolve(process.env.FOLDPOINT_PI_ROOT ?? "D:/pi"),
  "packages/coding-agent/dist/bundle/cli.js",
);

it.skipIf(!existsSync(cli))(
  "keeps real Pi prewarm bills separate from ordinary runtime age using a loopback provider",
  () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "tools/pi-cache-warming-smoke.ts"],
      {
        encoding: "utf8",
        timeout: 55_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PI_CLI: cli,
        },
      },
    );
    const r = JSON.parse(output);
    expect(r.paidApiCalls).toBe(0);
    expect(r.off.steady).toEqual({
      ordinaryAgeBeforeSecondCall: 1,
      observedWarmsBeforeSecondCall: 0,
    });
    expect(r.streaming.oneTokenHttpRequests).toBeGreaterThan(0);
    expect(r.streaming.cacheWarms).toBe(r.streaming.oneTokenHttpRequests);
    expect(r.streaming.steady).toEqual({
      ordinaryAgeBeforeSecondCall: 1,
      observedWarmsBeforeSecondCall: r.streaming.oneTokenHttpRequests,
    });
    expect(r.streaming.totalCost).toBeCloseTo(r.streaming.callCost + r.streaming.cacheWarmCost, 12);
  },
  60_000,
);
