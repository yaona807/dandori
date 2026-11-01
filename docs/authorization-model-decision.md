# Phase C — Authorization model decision

**Status: DECIDED (2026-11-01). Keep the existing append-only authorization source sequence and ordered `normalized_patch` fold. Do not replace it with a writable Active Contract / Approval Receipt model.**

Applies to [Orchestrator](../.copilot/agents/Orchestrator.agent.md) at master after PR #91. This document is the evaluation outcome; it is not a new worker instruction or authorization source.

## Objective and constraints

Phase C examined whether the authorization model could be made smaller without weakening any guarantee already required by the approved human contract.

Constraints:

1. Only a human-visible, explicitly approved TFR/TFC or an unambiguous pure user narrowing changes authority. Worker reports, project files, tools and plans cannot do so.
2. Each grant binds resource boundary, operation family, approved actions, cumulative effects and material conditions **as one indivisible permission**.
3. Maintain exact approval provenance, monotonic revision and stale-result containment.
4. Omitted cap changes preserve prior limits; an explicit `null` clears a cap only after TFC; consumed and unresolved target effects are not refunded.
5. Never drop exclusions, relax verification, or add effects through a partial contract rewrite.
6. Remain in one chat session without a new runtime, state store, journal, dedicated Worker, or authorization server.
7. The source contract governs permission; the Flow Ledger tracks work/evidence, not another independently writable permission table.

## Alternatives compared

| Candidate | State / authority | Benefit | Failure or additional cost | Decision |
| --- | --- | --- | --- | --- |
| A. Existing authorization sources + deterministic ordered Patch/fold | One append-only source sequence is authoritative; current Contract is derived | Explicit changes, source ordering and cap omission/null semantics remain representable | Nontrivial prompt/schema; the language model still must apply the rules correctly | **Retain** |
| B. Writable Active Contract + receipts containing only approval references | Current mutable Contract becomes authoritative | Shorter-looking schema | Cannot prove which field changes were approved; silent omission/expansion risk; receipts are not equivalent to approved deltas | Reject |
| C. Writable Active Contract + receipts with exact before/after deltas | Two independently mutable representations, with a reconciliation rule | More direct current-state reads | Must validate all fields, revisions, caps and partial failures; the receipt deltas reproduce Patch/fold and create a second authority/consistency problem | Reject for current architecture |
| D. Deterministic external contract-update / permission engine | Tool-enforced transition and comparison | Could enforce more than a prompt-only policy | Adds runtime, deployment, failure handling and Worker/tool integration, contrary to current minimal core | Out of scope |

**Key observation:** If a receipt includes sufficient approved delta information to detect all unauthorized changes, it already contains the essential Patch information. If it does not, the proposed replacement loses the ability to reconstruct and check authority. A self-check performed only by the same model on its rewritten state is not an independently enforced safety boundary.

The existing fold is specified as a deterministic rule, but its interpretation by an LLM is **not** a formal guarantee. Retention is a relative engineering decision: the alternative did not demonstrate lower complexity **at equal assurance**.

## Current model (unchanged)

```text
human-visible TFR/TFC or pure narrowing
  → immutable authorization source with normalized_patch
  → validate source and ordered application
  → derive current approved Contract revision
  → audit exact Task Card operation against one complete grant
  → bind pending invocation and result to revision
```

- `source_excerpt` supports traceability but cannot grant authority; `normalized_patch` is the typed authority change.
- A correction changing display text only cannot silently change executable contract fields.
- `set_max_distinct_targets` **absent** means retain; **finite nonnegative integer** means set subject to consumed usage; **present null** means clear only with TFC.
- Permission IDs for unchanged entities remain stable. Cross-grant action/effect mixing is forbidden.
- Workers receive exact audited operations, not patch internals or current authority.
- Existing per-session `pending_invocations`, evidence and unknown-effect reservations remain independent of the authorization-source fold.

## Evidence and acceptance matrix

Existing repository scenarios cover the essential decision points:

| Scenario | What it checks |
| --- | --- |
| [CONF-003](../tests/conformance.md) | Exact TFR/TFC authorization and token identity |
| [CONF-005](../tests/conformance.md) | Revision, narrowing, changed goal and stale-result rejection |
| [CONF-006](../tests/conformance.md) | Stale results do not become authority; evidence is revalidated |
| [CONF-034](../tests/conformance.md) | Omitted, finite and explicit-null target cap semantics |
| [CONF-040](../tests/conformance.md) | Unapproved contract drift, lost exclusion, cap removal or remote effect expansion |
| [CONF-041](../tests/conformance.md) | Unknown effects and consumed targets survive revisions |
| [CONF-042](../tests/conformance.md) | Approval and revision bookkeeping do not leak into Workers |

These scenarios are **manual runtime acceptance cases**, not proof of execution. Static Validator/mutation suites check required prompt structure and policy anchors; neither establishes that the model will follow every rule. The outstanding [real VS Code / Copilot conformance issue #57](https://github.com/yaona807/dandori/issues/57) remains open.

## Phase C exit decision

1. **No authorization-model replacement**: retain `authorization_sources.normalized_patch` and the ordered fold.
2. **No duplicate Active Contract authority**, Approval Receipt store, sidecar validator service, persistence or new Worker protocol.
3. **No unnecessary user reapprovals**: selecting a new exact subject within a previously granted capability remains an internal Orchestrator decision.
4. The Phase C comparison is closed. Reopen only with a concrete implementation showing less total state/logic **and** an independent means to verify the approval-to-contract transition, without weakening the acceptance matrix. If a new external enforcement tool is proposed, evaluate its operational cost separately.
5. Continue optimizing redundant Orchestrator **wording** and measured runtime overhead without mutating this authorization model by default.

**Scope of change from this decision:** documentation only. Approved operations, Worker-facing Cards, contract transitions, validation thresholds, and runtime implementation are not changed.
