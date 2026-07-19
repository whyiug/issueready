# Contributing to IssueReady

Thank you for helping make issue handoffs clearer and safer. Contributions of code, tests, documentation, rule definitions, and reproducible fixtures are welcome.

## Before you start

- Search existing issues before opening a new one.
- Keep security reports out of public issues; follow [SECURITY.md](SECURITY.md).
- For a substantial behavior or contract change, open an issue first so the scope can be agreed before implementation.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

IssueReady requires Node.js 24 and uses the Corepack-pinned pnpm version.

```bash
git clone https://github.com/whyiug/issueready.git
cd issueready
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm validate
```

Useful commands:

| Command                   | Purpose                                   |
| ------------------------- | ----------------------------------------- |
| `corepack pnpm example`   | Run the local, credential-free example    |
| `corepack pnpm format`    | Format supported source and documentation |
| `corepack pnpm lint`      | Run static lint checks                    |
| `corepack pnpm typecheck` | Type-check every workspace package        |
| `corepack pnpm test`      | Run the Vitest suite                      |
| `corepack pnpm build`     | Build ESM output and declarations         |
| `corepack pnpm validate`  | Run the same quality gates used by CI     |
| `corepack pnpm mutation`  | Run the slower mutation-test scopes       |

## Design invariants

Changes must preserve these product boundaries:

- `evaluationStatus`, `specVerdict`, and `delegationDisposition` are independent axes.
- Infrastructure uncertainty never becomes a specification failure.
- `TOO_BROAD` requires an explicit hard predicate; length and formatting heuristics are insufficient.
- The deterministic core performs no network access, credential discovery, process execution, or GitHub writes.
- Optional semantic signals are auxiliary, profile-bound evidence and cannot override deterministic hard facts.
- Reports do not include raw issue bodies, and evidence quotes remain opt-in and redacted.

See [docs/architecture.md](docs/architecture.md) for package responsibilities and dependency direction.

## Making a change

1. Keep the change focused and add tests for observable behavior.
2. Update JSON Schemas before their generated TypeScript projections.
3. Run the matching generator when changing schemas, rules, or fixtures:

   ```bash
   corepack pnpm generate:schema-types
   corepack pnpm generate:rule-catalog
   corepack pnpm generate:rule-fixtures
   ```

4. Add regression fixtures for compatibility or boundary changes.
5. Run `corepack pnpm validate` before opening a pull request.

Generated files include a banner and must not be edited by hand. Synthetic fixtures must not contain copied private issues, credentials, production data, or third-party text without clear reuse rights.

## Pull requests

- Use a concise title that describes the user-visible outcome.
- Explain the problem, the chosen boundary, and how the change was verified.
- Keep unrelated refactors and formatting out of the same pull request.
- Link the related issue when one exists.
- Add or update documentation when a public contract changes.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
