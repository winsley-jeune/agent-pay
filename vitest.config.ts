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
      // Off by default in tests so helpers can create a key and pay at once; tests that need them set them per key.
      COOLING_OFF_HOURS: "0",
      DRAIN_GUARD: "false",
    },
  },
});
