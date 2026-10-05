import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test files share one database and recreate its schema.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
