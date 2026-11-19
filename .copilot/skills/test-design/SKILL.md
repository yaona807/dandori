---
name: test-design
description: >-
  Choose proportionate, behavior-focused tests without brittle assertions,
  redundant cases or test-only production complexity.
user-invocable: false
---

# Test Design

Use when writing or changing tests, or selecting verification for a meaningful behavior change. This Skill guides judgment, not a test quota. It grants no tools, scope or permissions; follow existing project requirements and the approved CommandRunner boundary.

## Decide whether a new test adds value

- Identify requirements, externally observable contracts, plausible regressions and important failure modes before selecting cases. Do not treat the current implementation output as an authoritative test oracle; flag uncertain or undocumented behavior.
- Inspect relevant existing tests and their coverage. Add a case only when it catches a distinct, credible failure or protects an important contract. Avoid duplicate cases and targets for test counts or coverage percentages.
- Prefer high-impact boundaries, errors, state changes and invariants. A justified decision to reuse an existing check or add no test is acceptable; disclose material residual verification gaps.

## Keep tests resilient

- Assert observable results and effects, not private implementation, incidental DOM shape, internal call counts/order or wholesale snapshots, unless those details are part of the contract.
- Prefer deterministic data, realistic boundary fakes and minimal mocking. Do not mirror production logic in expectations or change fixtures/baselines merely to make checks pass.
- Follow established test tools and conventions; avoid adding a new framework or dependency just for a test without a justified, approved need.

## Choose a proportionate test level

- If legacy code or an uncommon framework requires extensive internal simulation to unit-test, prefer a viable behavior-level or integration check rather than forcing a unit test.
- Refactor production code only when the change is independently justified by design or maintainability, safely preserves behavior and stays within the approved scope. Avoid test-only APIs, accessors, wrappers and abstractions.
- If reliable automated testing is disproportionate or unavailable, report meaningful untested risk and a practical alternative rather than manufacturing a fragile test.

## Verify credible results

- For bug fixes, when feasible verify the test fails against the buggy behavior and passes after the fix. Check assertion strength, determinism and the actual behavior exercised; green status alone does not prove quality.
- Run only authorized, registered checks through CommandRunner. Never bypass permission boundaries or weaken assertions, fixtures or validation criteria to get a passing result.
