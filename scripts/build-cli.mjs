import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "packages/cli");
const outputDirectory = resolve(packageRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await Promise.all([
  mkdir(resolve(outputDirectory, "assets/fixtures/issues"), {
    recursive: true,
  }),
  mkdir(resolve(outputDirectory, "assets/fixtures/policies"), {
    recursive: true,
  }),
]);

await build({
  entryPoints: [resolve(packageRoot, "src/cli.ts")],
  outfile: resolve(outputDirectory, "cli.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  legalComments: "external",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});

await Promise.all([
  cp(
    resolve(repositoryRoot, "rules"),
    resolve(outputDirectory, "assets/rules"),
    {
      recursive: true,
    },
  ),
  cp(
    resolve(repositoryRoot, "locales"),
    resolve(outputDirectory, "assets/locales"),
    { recursive: true },
  ),
  cp(
    resolve(repositoryRoot, "fixtures/policies/default.json"),
    resolve(outputDirectory, "assets/fixtures/policies/default.json"),
    { recursive: true },
  ),
  cp(
    resolve(repositoryRoot, "fixtures/issues/curated-semantic.v1alpha1.json"),
    resolve(
      outputDirectory,
      "assets/fixtures/issues/curated-semantic.v1alpha1.json",
    ),
    { recursive: true },
  ),
]);

await chmod(resolve(outputDirectory, "cli.js"), 0o755);
