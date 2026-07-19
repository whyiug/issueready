# Changelog

All notable changes to IssueReady are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-19

### Added

- The `issueready` CLI for local Markdown drafts and bounded, read-only GitHub Issue URLs.
- Compact summary, Markdown, and versioned JSON output formats.
- Reviewed `READY` and `NEEDS_INFO` synthetic demonstrations.
- Evidence-backed tri-axis evaluation, policy loading, report rendering, schemas, rules, fixtures, and GitHub read boundaries.

### Security

- Credentials are accepted only through environment variables at the final GitHub request boundary.
- Evidence quotes are omitted by default and credential-shaped values are redacted.

[0.1.0]: https://github.com/whyiug/issueready/releases/tag/v0.1.0
