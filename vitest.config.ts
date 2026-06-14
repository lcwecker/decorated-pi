import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 30000,
    // Run test files sequentially to avoid config file collisions
    // (settings tests share ~/.pi/agent/decorated-pi.json)
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text"],
      // Source roots that ship with the extension. Adjust as the
      // tools/hooks/commands layout evolves.
      include: [
        "tools/**",
        "hooks/**",
        "commands/**",
        "ui/**",
      ],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.test.ts",
        "**/test/**",
        // Type-only / config files
        "**/types.ts",
      ],
    },
    // `vitest bench` should only pick up `*.bench.ts` files, not the
    // regular `*.test.ts` suite.
    bench: {
      include: ["**/*.bench.ts"],
    },
  },
});
