import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 30000,
    // Redirect the agent dir per spec file so the suite never reads or writes
    // the user's real ~/.pi/agent state. See test/setup-agent-dir.ts.
    setupFiles: ["./test/setup-agent-dir.ts"],
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
  },
});
