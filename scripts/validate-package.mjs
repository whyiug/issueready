import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "packages/cli");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "issueready-package-"));

let summary = "";
try {
  const { stdout } = await execFileAsync(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporaryDirectory,
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  const manifest = Array.isArray(result) ? result[0] : undefined;
  if (
    manifest === undefined ||
    !Array.isArray(manifest.files) ||
    typeof manifest.filename !== "string" ||
    typeof manifest.version !== "string"
  ) {
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
    "dist/assets/rules/catalog/v1alpha1/IR-ACC-001.json",
    "dist/assets/rules/task-packs/v1alpha1/generic.json",
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

  const consumerDirectory = resolve(temporaryDirectory, "consumer");
  await mkdir(consumerDirectory);
  await writeFile(
    resolve(consumerDirectory, "package.json"),
    '{"name":"issueready-package-smoke","private":true}\n',
  );
  const tarball = resolve(temporaryDirectory, manifest.filename);
  const install = await execFileAsync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarball,
    ],
    {
      cwd: consumerDirectory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (install.stderr.includes("EBADENGINE")) {
    throw new Error("npm package rejects the validation Node.js runtime");
  }
  const installedCli = resolve(
    consumerDirectory,
    "node_modules/issueready/dist/cli.js",
  );
  const smoke = await execFileAsync(
    process.execPath,
    [installedCli, "demo", "ready"],
    {
      cwd: consumerDirectory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (
    !smoke.stdout.includes(`IssueReady ${manifest.version}`) ||
    !smoke.stdout.includes("Specification: READY")
  ) {
    throw new Error(
      "installed npm package did not complete the READY smoke test",
    );
  }
  summary = `npm package contains ${files.size} files (${manifest.unpackedSize} unpacked bytes); installed smoke test passed\n`;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write(summary);
