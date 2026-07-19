import { createMutationConfig } from "./base-config.mjs";

export default createMutationConfig({
  mutate: "packages/decision/src/index.ts",
  testCommand:
    "corepack pnpm exec vitest run packages/decision/test/decision.test.ts",
  reportFile: "runs/mutation/decision.json",
});
