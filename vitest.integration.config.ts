import { defineConfig } from "vitest/config";
import path from "path";

// Integration tier for tests needing real Docker (`npm run test:integration`), so `npm test` stays fast.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 60_000, // docker run is slow
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./") },
  },
});
