import { createMutationConfig } from "./base-config.mjs";

export default createMutationConfig({
  mutate: "packages/report/src/redaction.ts",
  testCommand:
    "corepack pnpm exec vitest run packages/report/test/redaction.test.ts",
  reportFile: "runs/mutation/redaction.json",
});
