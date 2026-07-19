# Rule execution fixtures

`four-state.v1alpha1.json` is generated mechanically from the versioned rule manifests and task packs by `scripts/generate-rule-fixtures.mjs`. It contains PASS, FAIL, UNKNOWN, and NOT_APPLICABLE scenarios for every registered evidence source, plus same-source conflicts, unregistered-source rejection, policy-effect injection rejection, legal hard-predicate precedence, and illegal hard-predicate proof rejection.

The catalog protects executor plumbing, registered signal sources, rule/task-pack revision binding, schema compatibility, and four-state outcome propagation. `corepack pnpm generate:rule-fixtures:check` rejects missing or stale bytes in the main validation chain.

These 303 scenarios satisfy the numeric synthetic executor-contract fixture subgate and every core rule's four-state requirement. They are not human-labeled Issue examples and do not establish semantic accuracy or calibration. Semantic or realistic Issue fixtures still require explicit provenance and review rather than bulk generation from desired labels.
