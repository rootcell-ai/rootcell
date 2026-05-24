import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: [
            "src/rootcell/integration/**/*.integration.test.ts",
            "src/spy/**/*.test.ts",
          ],
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/rootcell/integration/**/*.integration.test.ts"],
          fileParallelism: false,
          isolate: false,
          testTimeout: 1_800_000,
          hookTimeout: 1_800_000,
        },
      },
    ],
  },
});
