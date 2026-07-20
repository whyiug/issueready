import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import gifenc from "gifenc";

const { GIFEncoder, applyPalette, quantize } = gifenc;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function terminalFrame(lines) {
  const content = lines
    .map((line, index) => {
      const fill = line.startsWith("$")
        ? "#6ee7d8"
        : line.includes("READY") && !line.includes("NEEDS_INFO")
          ? "#8df0a8"
          : line.includes("NEEDS_INFO")
            ? "#f8c96b"
            : line.includes("Blocking checks:")
              ? "#f19a9a"
              : "#d9def0";
      return `<text x="54" y="${105 + index * 42}" fill="${fill}">${escapeXml(line)}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="560" viewBox="0 0 1000 560">
    <rect width="1000" height="560" rx="20" fill="#090d18" />
    <rect x="1" y="1" width="998" height="558" rx="19" fill="none" stroke="#313b58" stroke-width="2" />
    <rect width="1000" height="54" rx="20" fill="#141b2d" />
    <rect y="34" width="1000" height="20" fill="#141b2d" />
    <circle cx="28" cy="27" r="7" fill="#ff6b6b" />
    <circle cx="52" cy="27" r="7" fill="#f8c96b" />
    <circle cx="76" cy="27" r="7" fill="#6ee7a8" />
    <text x="500" y="34" text-anchor="middle" fill="#8f9ab8" font-family="DejaVu Sans Mono, monospace" font-size="15">IssueReady demo</text>
    <g font-family="DejaVu Sans Mono, monospace" font-size="23">${content}</g>
  </svg>`;
}

async function writeOrCheck(path, value) {
  if (!checkOnly) {
    await writeFile(path, value);
    return;
  }
  const current = await readFile(path).catch(() => null);
  if (current === null || !Buffer.from(current).equals(Buffer.from(value))) {
    throw new Error(`${path} is not current; run corepack pnpm assets`);
  }
}

const socialSvg = await readFile(
  resolve(repositoryRoot, "assets/social-preview.svg"),
);
const socialPng = new Resvg(socialSvg, {
  fitTo: { mode: "width", value: 1280 },
})
  .render()
  .asPng();
await writeOrCheck(
  resolve(repositoryRoot, "assets/social-preview.png"),
  socialPng,
);

const frames = [
  ["$ npx issueready demo ready"],
  ["$ npx issueready demo ready", "IssueReady 0.1.1", "Task:          bug"],
  [
    "$ npx issueready demo ready",
    "IssueReady 0.1.1",
    "Task:          bug",
    "Evaluation:    COMPLETE",
    "Specification: READY",
    "Delegation:    CANDIDATE",
    "Blocking checks: none",
  ],
  [],
  ["$ npx issueready demo needs-info"],
  [
    "$ npx issueready demo needs-info",
    "IssueReady 0.1.1",
    "Task:          feature",
    "Evaluation:    COMPLETE",
    "Specification: NEEDS_INFO",
    "Delegation:    CANDIDATE",
  ],
  [
    "$ npx issueready demo needs-info",
    "IssueReady 0.1.1",
    "Task:          feature",
    "Evaluation:    COMPLETE",
    "Specification: NEEDS_INFO",
    "Delegation:    CANDIDATE",
    "Blocking checks: IR-ACC-002, IR-DEF-003, IR-EDG-001",
  ],
];
const delays = [700, 650, 1800, 400, 700, 650, 2200];
const rendered = frames.map((lines) =>
  new Resvg(terminalFrame(lines), {
    fitTo: { mode: "width", value: 1000 },
  }).render(),
);
const palette = quantize(
  Buffer.concat(rendered.map((frame) => frame.pixels)),
  128,
);
const gif = GIFEncoder();
for (let index = 0; index < rendered.length; index += 1) {
  const frame = rendered[index];
  if (frame === undefined) continue;
  gif.writeFrame(
    applyPalette(frame.pixels, palette),
    frame.width,
    frame.height,
    {
      ...(index === 0 ? { palette } : {}),
      delay: delays[index] ?? 700,
      repeat: 0,
      dispose: 1,
    },
  );
}
gif.finish();
await writeOrCheck(
  resolve(repositoryRoot, "assets/terminal-demo.gif"),
  gif.bytes(),
);
