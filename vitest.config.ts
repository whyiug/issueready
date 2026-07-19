import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function workspaceSource(packageName: string): string {
  return fileURLToPath(
    new URL(`./packages/${packageName}/src/index.ts`, import.meta.url),
  );
}

export default defineConfig({
  resolve: {
    alias: {
      "@issueready/core": workspaceSource("core"),
      "@issueready/decision": workspaceSource("decision"),
      "@issueready/domain": workspaceSource("domain"),
      "@issueready/github": workspaceSource("github"),
      "@issueready/normalize": workspaceSource("normalize"),
      "@issueready/policy": workspaceSource("policy"),
      "@issueready/report": workspaceSource("report"),
      "@issueready/rules": workspaceSource("rules"),
      "@issueready/schema": workspaceSource("schema"),
      "@issueready/snapshot": workspaceSource("snapshot"),
      "@issueready/testkit": workspaceSource("testkit"),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    restoreMocks: true,
  },
});
