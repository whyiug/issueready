# Add JSON output to the status command

## Context

Automation currently has to parse the human-readable status output. Add a `--json` option that emits the same status information as a stable JSON object.

## Acceptance criteria

- `status --json` writes one JSON object to standard output.
- The existing text output remains unchanged when the flag is absent.
- Unknown output fields may be added later without breaking consumers.
- The command exits non-zero when status collection fails.

## Validation

- Add unit tests for successful JSON output and collection failure.
- Run the existing status command tests.

## Out of scope

- Changing the text output.
- Adding remote network requests.
