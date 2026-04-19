import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    daemon: "src/daemon.ts",
  },
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  external: ["better-sqlite3"],
});
