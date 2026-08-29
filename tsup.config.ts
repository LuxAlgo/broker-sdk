import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/index": "src/adapters/index.ts",
    stats: "src/stats.ts",
    csv: "src/csv.ts",
    orders: "src/orders.ts",
    fx: "src/fx.ts",
    "connect/index": "src/connect/index.tsx",
    "connect/core": "src/connect/core.ts",
    "sync/index": "src/sync/index.ts",
    "sync/cli": "src/sync/cli.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  external: ["react", "react/jsx-runtime"],
});
