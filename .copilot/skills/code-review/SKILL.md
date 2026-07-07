---
name: code-review
description: "Review code changes using selected perspectives: correctness, maintainability, testability, security, and performance. Used by Reviewer only; returns findings to Orchestrator for final routing."
user-invocable: false
---

This is the single shared review skill for implementation changes.
Do not create separate skills for each perspective. Select the necessary perspectives and use the corresponding Markdown-linked reference files.

## Core rules

- Do not modify files.
- Do not call another agent.
- Do not choose final routing.
- Make findings concrete and actionable.
- Prioritize requirement alignment, correctness, maintainability, and testability by default.
- Load additional perspectives only when relevant.
- Perspective names such as `correctness`, `maintainability`, `testability`, `security`, and `performance` are internal labels.
- Ignore style-only issues unless they materially affect correctness, consistency, or maintainability.
- Return findings at a granularity that Orchestrator and Writer can act on directly.

## Language policy

- Review handoff output should be compact English.
- Preserve file paths, code symbols, commands, APIs, identifiers, and exact quoted text.
- Use severity labels: high / medium / low.

## Perspective selection

Default perspectives:

- [correctness](./references/correctness.md)
- [maintainability](./references/maintainability.md)
- [testability](./references/testability.md)

Use [security](./references/security.md) when the change touches:

- authentication
- authorization
- admin features
- personal data
- file upload/download
- external API calls
- logging
- secrets or environment variables
- payment

Use [performance](./references/performance.md) when the change touches:

- large-data loops
- database queries
- batch jobs
- caching
- network calls
- rendering performance

## Output contract priority

When Reviewer is invoked through an Orchestrator Task Card, the Task Card `response` field is authoritative and overrides every example in this Skill. Return exactly the format requested by the Task Card, normally one fenced `yaml` block with top-level `worker_response`. Do not return Markdown frontmatter when a Task Card response field is present.

Use the review sections below only as content guidance to populate `worker_response.result`, `changes`, `risks`, `unknowns`, or optional Task Card-requested sections:

- `review_scope`
- `perspectives_used`
- `verdict`: approve | request_changes | comment_only
- `blocking_issues`
- `non_blocking_suggestions`
- `missing_tests`
- `questions`
- `suggested_next_capability`

If no Task Card response field is provided, still prefer the shared `worker_response` YAML shape used by Orchestrator.
