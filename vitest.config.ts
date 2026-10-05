import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test files share one database and recreate its schema.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
      PUBLIC_URL: "http://localhost:8787",
      REQUIRE_PASSKEY: "true",
      ALLOW_DEV_CREDIT: "true",
    },
  },
});
