import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = new URL("../", import.meta.url);
const ignored = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".git",
  ".stryker-tmp",
  "cache",
  "coverage",
  "dist",
  "execution",
  "node_modules",
  "release",
  "research",
  "runs",
]);
const failures = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".json") {
      try {
        JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        failures.push(`${relative(root.pathname, path)}: ${error.message}`);
      }
    }
  }
}

await visit(root.pathname);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("All JSON files parsed successfully.");
}
