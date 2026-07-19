# Mutation testing

Mutation testing measures `decision`, `policy`, and credential `redaction` independently. Each scope has an 85% breaking threshold; timeout, no-coverage, runner error, or an unreviewed survivor also fails the evidence gate.

## Run

```sh
corepack pnpm mutation
corepack pnpm mutation:evidence
corepack pnpm mutation:evidence:check
```

The three mutation commands are intentionally separate so a strong scope cannot hide a weak one. Stryker concurrency is fixed at two workers for shared-host safety.

Stryker uses its command runner to invoke the scope's Vitest file. During the compatibility spike, the direct Vitest runner reported coverage but allowed an empty redaction-rule array to survive. The command runner killed that sentinel and is slower but trustworthy for this workspace. Do not switch runners without repeating the sentinel check.

## Evidence

Raw Stryker JSON is written to gitignored `runs/mutation/`. `scripts/summarize-mutation.mjs` commits only deterministic counts, digests, survivor locations, and reviews to `mutation/summary.json`.

Every survivor is critical by default. An equivalent-mutant review must bind the exact source digest, location, mutator, and replacement in `equivalent-mutants.json`, explain why no observable result changes, and set `critical` to `false`. Source, test, config, lockfile, or review drift makes `mutation:evidence:check` fail.
