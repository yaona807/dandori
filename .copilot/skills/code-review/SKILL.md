---
name: code-review
description: "Review code changes using selected perspectives: correctness, maintainability, testability, security, and performance. Used by Reviewer only."
user-invocable: false
---

This is the single shared review skill for implementation changes.
Do not create separate skills for each perspective. Select the necessary perspectives and use the corresponding Markdown-linked reference files.

## Core rules

- Do not modify files.
- Do not call another agent.
- Do not decide who should perform follow-up work.
- Make findings concrete and actionable.
- Prioritize requirement alignment, correctness, maintainability, and testability by default.
- Load additional perspectives only when relevant.
- Perspective names such as `correctness`, `maintainability`, `testability`, `security`, and `performance` are internal labels.
- Ignore style-only issues unless they materially affect correctness, consistency, or maintainability.
- Return concrete findings at a granularity that the caller can act on directly.

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

## Output

Follow the output format explicitly requested in the current task.

Otherwise, return a compact review containing:

- `review_scope`
- `perspectives_used`
- `verdict`: approve | request_changes | comment_only
- `blocking_issues`
- `non_blocking_suggestions`
- `missing_tests`
- `questions`
- `unresolved_requirements`

Use `unresolved_requirements` to report missing context or verification capabilities. Do not name or select who should perform follow-up work.
