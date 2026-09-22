import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // Declarations are emitted by `tsc -p tsconfig.build.json`: the bundled declaration
  // plugin in tsup does not yet work with the installed TypeScript version.
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  platform: "neutral",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
