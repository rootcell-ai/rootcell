import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const port = Number(process.env.SPY_UI_E2E_PORT ?? "4674");
const uiRoot = import.meta.dirname;
const staticDir = resolve(uiRoot, "../../../dist/spy-ui");
const testServer = resolve(uiRoot, "test-server.ts");

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["*.playwright.ts"],
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${String(port)}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bun run ${shellQuote(testServer)} --port ${String(port)} --static ${shellQuote(staticDir)}`,
    url: `http://127.0.0.1:${String(port)}/api/health`,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
