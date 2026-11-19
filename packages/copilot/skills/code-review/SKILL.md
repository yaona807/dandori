---
name: code-review
description: "Review code changes for merge and product quality."
user-invocable: false
---

# Code Review

Review the delegated changes to protect merge quality and long-term product quality.

- Understand the intended behavior, applicable project conventions, and the **complete in-scope diff** before narrowing the investigation.
- For each material changed behavior, form concrete review questions about plausible failures, contracts, invariants or regressions.
- Use targeted search to locate relevant callers, dependencies and tests; read the source needed to resolve each question. Reuse evidence instead of broad, repeated exploration without a review question.
- Expand the investigation beyond the diff and initial search results whenever security, impact, indirect dependencies or unresolved uncertainty warrant it. A narrow search does not prove an issue is absent.
- Identify material defects, regressions, broken contracts, security risks, and consequential maintainability problems introduced or worsened by the change.
- Report credible, actionable issues with concrete evidence and meaningful impact. Consider likelihood and severity; do not dismiss rare but catastrophic failures.
- Consider the benefits, complexity, and regression risks of remediation when recommending fixes or prioritizing findings.
- Respect established project patterns and equally valid implementation choices. Avoid personal preferences, speculative issues, and low-value improvements.
- Distinguish supported findings from significant unresolved risks or verification gaps. Do not claim coverage of code that could not be inspected.
- Assess verification credibility when tests, expected outputs, fixtures, baselines, validators or review gates change. Compare weakened verification criteria with requirements and prior behavior; passing results under modified criteria alone do not establish correctness. Legitimate test updates remain allowed.
- When tests change, assess whether assertions reflect independent contracts, cover credible failures, survive behavior-preserving refactors, avoid redundant cases and excessive test-only mocking or production changes, and use an appropriate test level. Do not demand a test for every change or enforce arbitrary test-count or coverage quotas.
- Continue reviewing after finding an issue. If no material findings exist, report none.

No findings does not establish that a change is safe to merge.
