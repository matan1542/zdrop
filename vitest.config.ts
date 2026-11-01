import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["daemon/test/**/*.test.ts"],
    pool: "forks",
    setupFiles: ["daemon/test/setup.ts"],
    testTimeout: 30_000,
    // a few tests time real processes (timeouts, concurrency); give a loaded CI runner one retry
    retry: process.env.CI ? 1 : 0,
  },
});
