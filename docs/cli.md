# Command-line interface

The `issueready` CLI evaluates local Markdown drafts and GitHub issues without
writing to GitHub or executing coding agents.

## Install

The current alpha is published on npm and mirrored in the versioned GitHub
release:

Node.js 22.12 or later is required.

```bash
npm install --global issueready@0.1.1
issueready --version
```

## Commands

```text
issueready <issue.md|github-issue-url|owner/repo#number> [options]
issueready demo <ready|needs-info> [options]
```

| Option               | Behavior                                                      |
| -------------------- | ------------------------------------------------------------- |
| `--format summary`   | Compact terminal result; this is the default                  |
| `--format markdown`  | Full evidence-backed Markdown report                          |
| `--format json`      | Versioned machine-readable report                             |
| `--task-type <type>` | Override task classification with a registered task type      |
| `--include-quotes`   | Include redacted evidence excerpts in Markdown or JSON output |
| `--help`             | Print command help                                            |
| `--version`          | Print the CLI version                                         |

Registered task types are `generic`, `bug`, `feature`, `docs`, `dependency`,
`refactor`, `test-ci`, and `operations`.

## Local input

Local input is limited to 128 KiB. The first level-one Markdown heading becomes
the issue title; if none is present, the title is `Local issue`. Local evaluation
performs no network request.

```bash
issueready ./proposal.md --format markdown
```

## GitHub input

Only `https://github.com/<owner>/<repository>/issues/<number>` and the equivalent
`owner/repository#number` shorthand are accepted. Pull request URLs and alternate
hosts are rejected.

The CLI performs one bounded, read-only request to `api.github.com`. Responses
are limited to 1 MiB and requests time out after 15 seconds. Public issues work
without credentials. Set `GITHUB_TOKEN` or `GH_TOKEN` in the environment for a
private issue or a higher API rate limit. `GITHUB_TOKEN` takes precedence when
both exist.

The alpha CLI reads the issue title, body, labels, update time, and author
association. It does not fetch comments, linked documents, or repository source.

## Semantic coverage

The CLI runs deterministic checks for arbitrary inputs. Semantic criteria remain
unknown because `v0.1.1` does not bundle a model provider or send issue content
to an external service. Consequently, an arbitrary input may have an
`INDETERMINATE` specification verdict even when deterministic findings are useful.

The `demo` command uses immutable, reviewed semantic signals attached to
project-authored synthetic fixtures. These signals demonstrate the complete
evaluation contract; they are not a calibration or accuracy claim.

## Exit codes

`0` means the requested evaluation completed and a report was written. `1` means
the command could not evaluate its input, such as an invalid argument, unreadable
file, denied GitHub request, malformed response, or internal contract failure.

Readiness does not change the process exit code. Automation should inspect
`specVerdict`, `evaluationStatus`, and `delegationDisposition` in JSON output
instead of treating every non-ready result as a command failure.
