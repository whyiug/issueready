# Curated Issue behavior fixtures

`curated-semantic.v1alpha1.json` contains project-authored synthetic Issue examples for end-to-end core behavior regression. Each example binds explicit semantic rule signals to exact title/body substrings and records the expected evaluation, specification, and delegation axes.

These fixtures are developer-reviewed examples, not blind human annotations, calibration data, a held-out set, or evidence of product accuracy. The catalog carries its rights and provenance fields explicitly. No GitHub Issue text or external repository content is copied into it; reuse is covered by the repository's MIT License.

The current catalog covers all eight task packs plus focused Chinese/emoji, rendered Issue Form prompt-injection, and native reference access-state cases. The adversarial text is inert test input: the core performs no provider, URL, tool, or GitHub write operation.

Native reference fixtures distinguish a confirmed permission failure from a transient provider failure. An unavailable essential reference can prove a context boundary and produce `NEEDS_INFO`; a transient or partial response remains `DEGRADED` with a null specification verdict. This prevents infrastructure availability from being misreported as missing issue content.
