import { access, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const roots = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "docs",
  "examples",
  "fixtures",
  "mutation",
  ".github",
];
const markdownFiles = [];
const failures = [];

async function collect(path) {
  const absolutePath = resolve(repositoryRoot, path);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(
    () => null,
  );
  if (entries === null) {
    if (path.endsWith(".md")) markdownFiles.push(absolutePath);
    return;
  }
  for (const entry of entries) {
    const child = resolve(absolutePath, entry.name);
    if (entry.isDirectory()) await collect(relative(repositoryRoot, child));
    else if (entry.isFile() && entry.name.endsWith(".md"))
      markdownFiles.push(child);
  }
}

for (const root of roots) await collect(root);

for (const file of markdownFiles.sort()) {
  const markdown = await readFile(file, "utf8");
  const links = markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu);
  for (const match of links) {
    const rawTarget = match[1];
    if (
      rawTarget === undefined ||
      rawTarget.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)
    ) {
      continue;
    }
    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(rawTarget).split("#", 1)[0];
    } catch {
      failures.push(`${relative(repositoryRoot, file)}: ${rawTarget}`);
      continue;
    }
    if (decodedTarget === undefined || decodedTarget.length === 0) continue;
    const target = decodedTarget.startsWith("/")
      ? resolve(repositoryRoot, `.${decodedTarget}`)
      : resolve(dirname(file), decodedTarget);
    if (
      target !== repositoryRoot &&
      !target.startsWith(`${repositoryRoot}${sep}`)
    ) {
      failures.push(`${relative(repositoryRoot, file)}: ${rawTarget}`);
      continue;
    }
    try {
      await access(target);
    } catch {
      failures.push(`${relative(repositoryRoot, file)}: ${rawTarget}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Broken local Markdown links:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Local Markdown links are valid (${markdownFiles.length} files).`,
  );
}
