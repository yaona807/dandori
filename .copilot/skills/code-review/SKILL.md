---
name: code-review
description: "Code review perspective guidance for correctness, maintainability, testability, security, and performance."
user-invocable: false
---

This is the shared perspective guide for implementation review. Select only the perspectives relevant to the delegated change and load the corresponding Markdown references.

## Core review principles

- Make findings concrete, evidence-based, and directly actionable.
- Prioritize requirement alignment, correctness, maintainability, and testability by default.
- Load additional perspectives only when the changed behavior warrants them.
- Ignore style-only issues unless they materially affect correctness, consistency, or maintainability.
- Distinguish confirmed defects, credible risks, missing verification, and unresolved context.
- Avoid duplicating one underlying issue across multiple perspectives.

## Perspective selection

Default perspectives:

- [correctness](./references/correctness.md)
- [maintainability](./references/maintainability.md)
- [testability](./references/testability.md)

Use [security](./references/security.md) when the change touches:

- authentication or authorization
- administrative capabilities
- personal or confidential data
- file upload or download
- external API calls
- logging, secrets, or environment variables
- payment or billing behavior

Use [performance](./references/performance.md) when the change touches:

- large-data loops
- database queries
- batch processing
- caching
- network calls
- rendering performance

## Finding quality

A useful finding identifies:

- the concrete location or behavior
- the violated requirement, invariant, or plausible failure mode
- why the issue matters
- the smallest defensible correction or verification needed

Use severity labels `high`, `medium`, and `low` only when the requested output format needs severity. Treat missing context or unavailable verification as unresolved rather than inventing certainty.
