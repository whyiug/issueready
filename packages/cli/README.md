# IssueReady CLI

IssueReady checks whether a GitHub issue or local Markdown draft is ready for
implementation. It keeps evaluation completeness, specification readiness, and
delegation policy separate and reports the evidence behind each result.

```bash
npx issueready demo ready
npx issueready path/to/issue.md
npx issueready https://github.com/owner/repository/issues/123
```

GitHub reads are bounded and read-only. Public issues work anonymously; set
`GITHUB_TOKEN` for private issues or higher API rate limits. Credentials are
never accepted as command arguments.

The default summary is concise. Use `--format markdown` for an evidence report
or `--format json` for automation. IssueReady does not invent semantic coverage:
without a configured semantic adapter, semantic criteria remain unknown and the
evaluation is reported as degraded.

See the [project documentation](https://github.com/whyiug/issueready) for the
full contract, safety boundaries, and source code.
