# Why issue readiness is not one score

Coding agents make issue quality an execution boundary. A vague task no longer
only costs a maintainer a clarification round; it can trigger an implementation
that is internally coherent, technically impressive, and still solves the wrong
problem.

Most readiness checks compress several different questions into one score.
IssueReady keeps them separate because they have different evidence and failure
modes.

## Evaluation completeness

Before judging an issue, the evaluator must know whether it saw enough trustworthy
input. A permission failure, rate limit, truncated body, unavailable reference, or
missing semantic profile is an evaluation limitation—not evidence that the issue
itself is incomplete.

IssueReady therefore reports `COMPLETE`, `DEGRADED`, or `ERROR` independently of
the issue verdict. When missing coverage could change the conclusion, the
specification verdict remains indeterminate.

## Specification readiness

Specification readiness asks whether implementation can begin without inventing
requirements. Versioned rule manifests cover definition, scope, acceptance,
validation, context, compatibility, and task-specific boundaries.

The outcomes deliberately avoid a numeric confidence score:

- `READY` means every applicable mandatory criterion has a supported conclusion.
- `NEEDS_INFO` means evidence proves that implementation-changing information is missing.
- `TOO_BROAD` requires mechanical evidence of independent goals with separate acceptance conditions.
- `null` means the available evaluation cannot support a verdict.

This makes a missing conclusion visible instead of quietly treating uncertainty
as failure.

## Delegation policy

A well-specified task is not automatically safe to delegate. Repository policy may
require supervision or human-only execution for sensitive paths, operations,
privileged issue types, or other local boundaries.

IssueReady models `CANDIDATE`, `SUPERVISED`, and `HUMAN_ONLY` separately from
specification readiness. A task can therefore be `READY` and still remain
`HUMAN_ONLY` without contradiction.

## Deterministic facts and semantic evidence

Some conditions are mechanically provable: a required field is empty, an input was
truncated, a code symbol is present, or two independently accepted goals exist.
Other conditions—such as whether acceptance criteria match the requested outcome—
need semantic judgment.

Semantic adapters may supply profile-locked evidence, but they cannot impersonate
deterministic sources or establish hard predicates. When no semantic adapter is
present, IssueReady preserves `UNKNOWN`; it does not infer readiness from body
length, heading count, or confident wording.

## Relationship to AI issue triage

GitHub documents an AI-powered issue intake Action that can suggest labels and ask
for more information. IssueReady addresses a narrower boundary: producing a local,
versioned, evidence-backed readiness report before a human or coding agent starts
implementation. The approaches can be complementary; one supports intake workflow,
while the other provides an auditable decision contract.

Recent research on issues assigned to Copilot similarly reports that merged results
are associated with well-scoped issues, implementation guidance, and relevant
artifact hints. IssueReady turns those concerns into explicit, testable contracts
without claiming that a static checklist can replace repository context or human
judgment.

## What IssueReady does not do

IssueReady does not execute agents, approve writes, derive authorization from
readiness, or turn incomplete analysis into a negative issue verdict. It is a gate
and evidence format, not an autonomous maintainer.

## Further reading

- [CLI reference](cli.md)
- [Architecture](architecture.md)
- [Core API](concepts/core-api.md)
- [GitHub: Triaging an issue with AI](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/triaging-an-issue-with-ai)
- [What Makes a GitHub Issue Ready for Copilot?](https://arxiv.org/abs/2512.21426)
