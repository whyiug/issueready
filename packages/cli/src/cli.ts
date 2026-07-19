import { main } from "./index.js";

process.exitCode = await main(
  process.argv.slice(2),
  { stdout: process.stdout, stderr: process.stderr },
  {
    cwd: process.cwd(),
    environment: process.env,
    fetch: globalThis.fetch,
  },
);
