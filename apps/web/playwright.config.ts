import { defineConfig } from "@playwright/test";

// Uses the locally installed Google Chrome, so no browser download is needed.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: "http://localhost:5198", channel: "chrome", viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "pnpm exec vite --port 5198 --strictPort",
    url: "http://localhost:5198",
    reuseExistingServer: true,
  },
});
