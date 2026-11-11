---
name: code-review
description: "Review code changes for merge and product quality."
user-invocable: false
---

# Code Review

Review the delegated changes to protect merge quality and long-term product quality.

- Understand the intended behavior, applicable project conventions, and the complete in-scope change. Examine relevant surrounding code, callers, and tests.
- Identify material defects, regressions, broken contracts, security risks, and consequential maintainability problems introduced or worsened by the change.
- Report credible, actionable issues with concrete evidence and meaningful impact. Consider likelihood and severity; do not dismiss rare but catastrophic failures.
- Consider the benefits, complexity, and regression risks of remediation when recommending fixes or prioritizing findings.
- Respect established project patterns and equally valid implementation choices. Avoid personal preferences, speculative issues, and low-value improvements.
- Distinguish supported findings from significant unresolved risks or verification gaps. Do not claim coverage of code that could not be inspected.
- Continue reviewing after finding an issue. If no material findings exist, report none.

No findings does not establish that a change is safe to merge.
