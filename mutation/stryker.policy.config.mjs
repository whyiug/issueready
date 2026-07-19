import { createMutationConfig } from "./base-config.mjs";

export default createMutationConfig({
  mutate: "packages/policy/src/index.ts",
  testCommand:
    "corepack pnpm exec vitest run packages/policy/test/policy.test.ts",
  reportFile: "runs/mutation/policy.json",
});
