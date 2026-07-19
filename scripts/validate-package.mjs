import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "packages/cli");

const { stdout } = await execFileAsync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  },
);
const result = JSON.parse(stdout);
const manifest = Array.isArray(result) ? result[0] : undefined;
if (manifest === undefined || !Array.isArray(manifest.files)) {
  throw new Error("npm pack returned an unsupported manifest");
}
const files = new Set(manifest.files.map((file) => file.path));
const required = [
  "LICENSE",
  "README.md",
  "dist/cli.js",
  "dist/assets/fixtures/issues/curated-semantic.v1alpha1.json",
  "dist/assets/fixtures/policies/default.json",
  "dist/assets/locales/en/v1alpha1.json",
  "package.json",
];
for (const path of required) {
  if (!files.has(path)) throw new Error(`npm package is missing ${path}`);
}
for (const path of files) {
  if (path.startsWith("src/") || path.startsWith("test/")) {
    throw new Error(`npm package contains development source: ${path}`);
  }
}
if (
  typeof manifest.unpackedSize !== "number" ||
  manifest.unpackedSize > 5_000_000
) {
  throw new Error("npm package exceeds the 5 MB unpacked size budget");
}
process.stdout.write(
  `npm package contains ${files.size} files (${manifest.unpackedSize} unpacked bytes)\n`,
);
