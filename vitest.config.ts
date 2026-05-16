import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 30000,
    // Run test files sequentially to avoid config file collisions
    // (settings tests share ~/.pi/agent/decorated-pi.json)
    fileParallelism: false,
  },
});
