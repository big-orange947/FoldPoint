import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const piCli = process.env.PI_CLI;

describe("persistent Pi 1M RPC runner", () => {
  it.skipIf(!piCli)(
    "completes all three arms against a local no-cost provider",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "foldpoint-1m-rpc-"));
      const base = join(temp, "base");
      mkdirSync(base);
      let calls = 0;
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
          // Drain the body; the local fixture never stores prompt text.
        }
        calls += 1;
        const answer = "STAGE_OK";
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
          usage: { prompt_tokens: 1200, completion_tokens: 12, total_tokens: 1212 },
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
        writeFileSync(join(temp, "stage1.txt"), "Reply exactly STAGE_OK. This is stage one.");
        writeFileSync(join(temp, "stage2.txt"), "Reply exactly STAGE_OK. This is stage two.");
        writeFileSync(join(temp, "stage3.txt"), "Reply exactly STAGE_OK. This is stage three.");
        writeFileSync(join(temp, "stage4.txt"), "Reply exactly STAGE_OK. This is stage four.");
        writeFileSync(
          join(temp, "manifest.json"),
          JSON.stringify({
            id: "local-loopback",
            stages: [
              { file: "stage1.txt", expectedContains: "STAGE_OK" },
              { file: "stage2.txt", expectedContains: "STAGE_OK" },
              { file: "stage3.txt", expectedContains: "STAGE_OK" },
              { file: "stage4.txt", expectedContains: "STAGE_OK" },
            ],
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
            "0",
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
            setTimeout(() => {
              child.kill();
              done(null);
            }, 90_000),
          ),
        ]);
        expect(exit, stderr).toBe(0);
        const report = JSON.parse(readFileSync(join(temp, "result-report.json"), "utf8"));
        expect(report.comparable).toBe(true);
        expect(report.arms).toHaveLength(3);
        expect(report.arms.map((arm: { completed: boolean }) => arm.completed)).toEqual([
          true,
          true,
          true,
        ]);
        expect(calls).toBeGreaterThanOrEqual(12);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
    100_000,
  );
});
