// Loaded only by the synthetic RPC probe. Fail closed if the expected loopback origin is absent.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const origin = process.env.FOLDPOINT_TEST_LOOPBACK_ORIGIN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? "")) throw new Error("Missing loopback origin");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== origin) throw new Error("External network denied");
  return originalFetch(input, { ...init, redirect: "error" });
};
http.request = https.request = () => {
  throw new Error("Unaccounted network denied");
};
syncBuiltinESMExports();
