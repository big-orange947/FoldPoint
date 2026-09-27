import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const piCli = process.env.PI_CLI;
const largeLoopback = process.env.PI_MILLION_LARGE_LOOPBACK === "1";
const sourceManifest = process.env.PI_MILLION_SOURCE_MANIFEST;
const preflightOnly = process.env.PI_MILLION_PREFLIGHT === "1";
const fakeOverflow = process.env.PI_MILLION_FAKE_OVERFLOW === "1";
const fakeInsufficientBalance = process.env.PI_MILLION_FAKE_402 === "1";

describe("persistent Pi 1M RPC runner", () => {
  it.skipIf(!piCli)(
    "completes all three arms against a local no-cost provider",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "foldpoint-1m-rpc-"));
      const base = join(temp, "base");
      mkdirSync(base);
      let calls = 0;
      let sawDeterministicRequest = false;
      let currentStageMarker = "STAGE_OK";
      const server = createServer(async (request, response) => {
        let requestChars = 0;
        let requestHead = "";
        let requestTail = "";
        let latestStageMarker: string | undefined;
        for await (const chunk of request) {
          const part = Buffer.from(chunk).toString("utf8");
          requestChars += part.length;
          if (requestHead.length < 40_000)
            requestHead += part.slice(0, 40_000 - requestHead.length);
          const matches = (requestTail + part).match(/Reply exactly STAGE_\d+/g);
          if (matches?.length) latestStageMarker = matches.at(-1)?.slice(14);
          requestTail = (requestTail + part).slice(-8_000);
        }
        if (
          requestHead.includes('"temperature":0') &&
          requestHead.includes('"thinking":{"type":"disabled"}')
        ) {
          sawDeterministicRequest = true;
        }
        const isSummary =
          largeLoopback && requestHead.includes("You are a context summarization assistant");
        if (!isSummary && latestStageMarker) currentStageMarker = latestStageMarker;
        calls += 1;
        if (fakeInsufficientBalance && calls >= 2) {
          response.writeHead(402, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Insufficient Balance",
                type: "unknown_error",
                code: "invalid_request_error",
              },
            }),
          );
          return;
        }
        if (fakeOverflow && !isSummary && Math.ceil(requestChars / 4) > 1_048_576) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: `This model's maximum context length is 1048576 tokens. However, you requested ${Math.ceil(requestChars / 4)} tokens. Please reduce the length of the messages or completion.`,
                type: "invalid_request_error",
                code: "invalid_request_error",
              },
            }),
          );
          return;
        }
        const answer = isSummary
          ? `## Goal\n- Continue the staged task.\n## Progress\n- Prior stages were received.\n## Next Steps\n- Reply exactly ${currentStageMarker}.`
          : (latestStageMarker ?? currentStageMarker);
        const promptTokens = largeLoopback ? Math.ceil(requestChars / 4) : 1200;
        const body = {
          id: `local-${calls}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "deepseek-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: answer },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 12,
            total_tokens: promptTokens + 12,
          },
        };
        const chunk = (choice: unknown, usage?: unknown): string =>
          `data: ${JSON.stringify({
            id: body.id,
            object: "chat.completion.chunk",
            created: body.created,
            model: body.model,
            choices: choice === null ? [] : [choice],
            ...(usage === undefined ? {} : { usage }),
          })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(chunk({ index: 0, delta: { role: "assistant", content: answer } }));
        response.write(chunk({ index: 0, delta: {}, finish_reason: "stop" }));
        response.write(chunk(null, body.usage));
        response.end("data: [DONE]\n\n");
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No loopback port");
        writeFileSync(
          join(base, "models.json"),
          JSON.stringify({
            providers: {
              deepseek: {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "local-test-only",
                modelOverrides: { "deepseek-flash": {} },
              },
            },
          }),
        );
        writeFileSync(
          join(base, "settings.json"),
          JSON.stringify({ defaultProjectTrust: "never" }),
        );
        const sourceStages = sourceManifest
          ? (JSON.parse(readFileSync(sourceManifest, "utf8")).stages as Array<{ file: string }>)
          : null;
        const stageCount = sourceStages?.length ?? (largeLoopback ? 8 : 4);
        const longMaterial = largeLoopback
          ? "项目记录：本周核对交付清单与责任人；请仅在问题出现时回答。\n".repeat(45_000)
          : "";
        const stages = Array.from({ length: stageCount }, (_, index) => {
          const file = `stage${index + 1}.txt`;
          const material = sourceStages?.[index]
            ? readFileSync(join(dirname(sourceManifest ?? ""), sourceStages[index].file), "utf8")
            : longMaterial;
          writeFileSync(
            join(temp, file),
            `${material}\nReply exactly ${fakeOverflow ? `STAGE_${index + 1}` : "STAGE_OK"}. This is stage ${index + 1}.`,
          );
          return { file, expectedContains: fakeOverflow ? `STAGE_${index + 1}` : "STAGE_OK" };
        });
        writeFileSync(
          join(temp, "manifest.json"),
          JSON.stringify({
            id: "local-loopback",
            stages,
          }),
        );
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
          if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
        }
        Object.assign(env, {
          PI_CLI: piCli,
          PI_NODE: process.env.PI_NODE ?? process.execPath,
        });
        delete env.PI_OFFLINE;
        const runner = fileURLToPath(new URL("../tools/pi-million-rpc.ts", import.meta.url));
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            runner,
            "--manifest",
            join(temp, "manifest.json"),
            "--agent-base",
            base,
            "--out",
            join(temp, "result"),
            "--min-compactions",
            preflightOnly ? "0" : largeLoopback ? "2" : "0",
            ...(preflightOnly ? ["--max-stages", "1"] : []),
          ],
          { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8").slice(0, 500);
        });
        const exit = await Promise.race([
          new Promise<number | null>((done) => child.once("exit", (code) => done(code))),
          new Promise<null>((done) =>
            setTimeout(
              () => {
                child.kill();
                done(null);
              },
              sourceManifest ? 420_000 : largeLoopback ? 240_000 : 90_000,
            ),
          ),
        ]);
        expect(exit, stderr).toBe(fakeInsufficientBalance ? 1 : 0);
        const report = JSON.parse(readFileSync(join(temp, "result-report.json"), "utf8"));
        if (fakeInsufficientBalance) {
          expect(report.arms).toHaveLength(1);
          expect(report.arms[0].reason).toMatch(/^stage-2-no-successful-response$/);
          return;
        }
        expect(report.comparable).toBe(!preflightOnly);
        expect(report.preflightPassed).toBe(preflightOnly);
        expect(report.arms).toHaveLength(3);
        expect(report.arms.map((arm: { completed: boolean }) => arm.completed)).toEqual([
          true,
          true,
          true,
        ]);
        if (fakeOverflow)
          expect(
            report.arms.every((arm: { qualityFailed: number }) => arm.qualityFailed === 0),
          ).toBe(true);
        expect(calls).toBeGreaterThanOrEqual(preflightOnly ? 3 : 12);
        if (!largeLoopback && !sourceManifest) expect(sawDeterministicRequest).toBe(true);
        if (largeLoopback && !preflightOnly) {
          expect(report.arms.every((arm: { compactions: number }) => arm.compactions >= 2)).toBe(
            true,
          );
        }
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
    sourceManifest ? 430_000 : largeLoopback ? 250_000 : 100_000,
  );
});
