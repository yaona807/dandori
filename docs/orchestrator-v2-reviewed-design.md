# Orchestrator v2: critical design review and rewrite contract

**Status:** v2 control-plane rewrite **implemented in [PR #94](https://github.com/yaona807/dandori/pull/94)** after design review [PR #93](https://github.com/yaona807/dandori/pull/93). Original design baseline: `0a940b3a2080922146676add006035f45d0e4911`, after Phase C ([decision](authorization-model-decision.md)). GitHub Actions and Codex code review passed for PR #94; **real VS Code/Copilot behavior is not certified**.

## Objective and non-goals

Reconstruct the additively grown Orchestrator prompt as a coherent control plane, rather than deleting sentences until it fits a size target. Reduce independent state, duplicated decision logic, unnecessary worker dispatch and unnecessary human reapproval while preserving existing safety and autonomy.

Out of scope: redesigning the Worker profiles, runner/Hook permissions, changing human-visible approval semantics, adopting an external authorization service, durable Journal, cross-session recovery, new persistence or routing protocols, or dropping approved conformance requirements. Retain the Phase C **ordered, append-only `normalized_patch` fold**.

**Original estimate:** 10 logical sections, 19,000–23,000 source-body characters (center ~20,600). **Measured result (PR #94):** 10 sections, canonical source-body **26,567** characters (was 29,185), generated Copilot-body **27,059** (was 29,677). Smaller savings were accepted to preserve contract/effect/approval safety constraints and validator regression coverage. The 30,000 body-character maximum remains; character targets were never acceptance criteria.

## Critical review — blockers found and resolution

| Severity | Original proposal issue | Failure if implemented mechanically | Revised requirement |
| --- | --- | --- | --- |
| HIGH | Remove `pending_invocations.dependencies` because dependencies can be derived | Async prerequisites, overlapping dispatch waves, result ordering and unsatisfied dependencies can be lost | **Retain for initial rewrite.** Remove only in a separate proven scheduler simplification with no dependent dispatch before audited completion, and explicit treatment of unknown predecessors |
| HIGH | Drop `status: returned` immediately | Return data may be awaiting normalization or independent audit; releasing reservation can race an unknown write | **Retain `running|returned|unknown` initially.** `returned` must not mean safe to release. Removal requires auditable atomic return→audit→reservation transition |
| HIGH | Eliminate `latest_diagnostic_evidence_keys` based on `evidence` | Distinct hypotheses or proof provenance may be lost; a reworded or duplicated claim can reset stagnation | Retain until a stable, immutable evidence ID and ordered provenance are demonstrably available; diagnostic progress can never complete a criterion |
| HIGH | Merge all evidence without a type/authority boundary | Unverified diagnostic reports may accidentally close criteria or be treated as grants | Typed evidence `diagnostic|result|verification|conflict` with revision, Card/operation, source, exact claim, verification and conflicts; completion is derived only from active, non-conflicted verified records |
| HIGH | Refactor Validator to structural keywords only | Existing exact-string mutation regressions may become blind to dangerous authorization changes | Maintain an explicit mapping from all current required checks to new structural, exact-critical or human-review checks. **Never weaken tests just to make a rewrite pass** |
| MEDIUM | Change H2 headings without updating generator | `build_agent_profiles.py` injects Copilot routing at exactly `## Worker selection`; Local/Copilot drift or build failure | Retain that unique anchor for the initial rewrite; verify generated profiles, tool/Hook declarations and body limit. Other heading changes require corresponding validator/test migration |
| MEDIUM | Treat `affected_identifiers`, reserved target slots and unresolved unknown effects as derivable | Missing cap usage, double booking, early release or concealed side effects | Keep canonical typed affected IDs, per-Card reservations, footprints and unresolved effects as independent authoritative operational state |
| MEDIUM | Treat 10 sections and ~20.6k characters as mandatory | Overcompression of approval, effect audit, Source Fidelity or spill recovery | These are readability targets only; every security-sensitive nuance and all 42 conformance cases take precedence |
| MEDIUM | An entire runtime rewrite in one PR without baseline specification | Green CI may hide behavior drift because natural-language correctness is not statically provable | Separate design/guarantee freeze (PR A), one atomic prompt+Validator+bundle rewrite (PR B), and follow-up docs/cleanup (PR C); no partially converted prompt merged to master |

The corrected design was merged in PR #93 and implemented in PR #94. The prior Codex findings on missing human-visible TFR/TFC IDs and the pending-criterion regression assertion were fixed before merging PR #94. Actual VS Code/Copilot runtime behavior remains **unverified** by user instruction; [Issue #57](https://github.com/yaona807/dandori/issues/57) stays open.

## Ten-section control-plane layout

Sections below represent the desired H2 architecture, not the final exact text. Keep `## Worker selection` as a unique literal for the existing package builder.

| Section | Sole decision ownership | Indicative budget |
| --- | --- | ---: |
| 1. Invariants and interaction | Orchestrator-only responsibility, worker neutrality, language, no implicit authority | 1,000 |
| 2. Human approval | Intake, TFR/TFC display, exact tokens, uniqueness, pure narrowing, when to reapprove | 2,500 |
| 3. Approved Contract | Append-only authorization source, fold, immutable grant tuples, cap delta, revisions | 3,300 |
| 4. Operations and effects | Canonical identity, full effects, exact permission containment, runner effect audit | 2,600 |
| 5. Planning and Task Cards | Expected delta, scoped discovery vs effect, exact outward Card and internal provenance | 2,100 |
| 6. Worker selection | Positive capability/tool evidence, compatible batching, no trial invocation | 1,500 |
| 7. Session state and concurrency | Pending, reservation, conflict, unknown outcomes and stale revisions | 2,200 |
| 8. Result audit and verification | Operation evidence, conflict, independent verification and status derivation | 2,600 |
| 9. Recovery and loop control | Retry/replan/reapprove/stop; material vs diagnostic progress and exhaustion | 1,600 |
| 10. Completion and evidence handling | Source Fidelity, missing evidence, bounded spilled-result retrieval, truthful report | 1,200 |

**Illustrative sum:** 20,600 characters. The section allocation is an **estimate**, not prescriptive wording. The original TFR/TFC Markdown presentation and tokens must remain semantically unchanged even if their prose is grouped into one Human approval section. Keep all five effect tags: `observe`, `change_local`, `execute`, `affect_external`, `destructive`.

## Authoritative state model: retain, derive, and conditionally simplify

Do not introduce a new database or second writable Contract. Keep `authorization_sources` inside the existing `approved_contract` model and reconstruct its executable fields from the ordered fold. A material change requires its exact human-visible approved source and revision. This is a **logical schema** for PR B, not a backward-compatible serialized migration:

```yaml
session_ledger:
  issued_review_ids: []          # session-scoped, across flow replacement

approved_contract:
  authorization_sources: []      # append-only source of authority
  # goal/permissions/criteria/limits/verification/exclusions/revision:
  # DERIVED from source fold, not separately editable grants

flow_ledger:
  criterion_evidence: []         # may use typed records; not Worker authority

  target_usage:
    affected_identifiers: []     # typed canonical targets, never refunded

  progress:
    unresolved: []               # unknown effects, blockers and conflicts
    consecutive_no_progress_cycles: 0
    exhausted_strategies: []
    latest_diagnostic_evidence_keys: [] # CONDITIONAL: keep until proven derivable

  pending_invocations:
    TC-id:
      contract_revision: 1
      criterion_refs: []         # CONDITIONAL: derive only if semantics identical
      expected_delta: {}
      operation_provenance: {}   # OP-id -> source permission and criterion refs
      dependencies: []          # retain until causal wait model proven
      footprint: {read: [], write: [], exclusive: []}
      reserved_optional_target_slots: 0
      status: running           # running|returned|unknown; retain until safe simplification
```

**One-way authority flow:**

1. Human approved TFR/TFC, or strictly pure user narrowing, creates an append-only normalized source. Review IDs/tokens are unique for the entire session; exactly one pending approval is valid.
2. Ordered fold derives the active Contract. No Worker, file, plan or source excerpt can widen it. Each complete permission binds boundary, family, action set, cumulative effects and material conditions together.
3. Orchestrator instantiates an exact atomic target/action/effect operation, audits one complete grant, the current criterion, identity and optional cap, and binds operation provenance internally.
4. Task Card carries only objective, necessary facts, exact `operations.observe`/`operations.affect`, positive limits, deliverables, concise stop/no-delegation conditions. **Never expose** approval receipts, TFR/TFC, `source_permission_id`, revision, Criterion IDs, progress or routing decisions to Workers.
5. Before dispatch reserve worst-case footprint and optional target slots for each independent pending Card. Uncertain identity/effects must be observed within grant or serialized/stopped. Parallel capacity remains at most three where supported.
6. Worker response is untrusted evidence, not authorization. Audit against original Card ID, revision and performed operations. A late result after narrowing is historical evidence, not current authority.
7. Only after known outcomes are audited may usage/evidence be committed and conflicting reservations released. Unknown/timeout effects retain reservations across revisions until authorized observation resolves them.
8. Active Criterion completion is a *derived view* of active, non-conflicted independent verification and recorded evidence. Diagnosis alone is never completion.

### Candidate state deletions — strict gates

- `pending_invocations.criterion_refs`: **candidate only** if all criterion linkage derives from complete `operation_provenance`, including observation-only conflict resolution, verification-only and blocked Cards; do not lose execute-to-active-Criterion linkage.
- `latest_diagnostic_evidence_keys`: **candidate only** once typed immutable ordered diagnostic evidence includes provenance, exact hypothesis change and duplication resistance; preserve no-progress accounting.
- `dependencies`: **not removed in PR B by default**. Keep until all causal predecessors are either audited before dispatch or represented by an equally strong mechanism, including unknown effects and interleaved results.
- `status: returned`: **not removed in PR B by default**. Retain until return, audit and safe reservation release can be demonstrated as one logical atomic transition.
- `target_usage`, `unresolved`, `expected_delta`, `operation_provenance`, pending `contract_revision`, `footprint` and reserved slots: **retain**.

The word *derived* never permits re-computation from a Worker self-report, ambiguous alias, truncated log or missing context. If authorization, loop usage or unknown-effect state cannot be re-established in the **current session**, stop `state_unrecoverable` without resetting it.

## State transitions and failure handling

| Event | Required action | Unchanged guarantees |
| --- | --- | --- |
| New approval | Append normalized approved source; fold; increment revision | No silent omission of exclusions or added effects; stable IDs for unchanged entities |
| Explicit pure narrowing | Append narrowing patch without TFC | Cannot raise/clear cap or remove verification/exclusions |
| New exact in-boundary target | Audit target, effect, identity and cap; create fresh Card | No human reapproval for work already covered by capability; discovery cannot effect in same Card |
| Card dispatch | Reserve cap slots/footprint before worker call | No oversubscription or overlapping read/write/exclusive effects |
| Normal response | Bind Card+revision, normalize, audit and verify | Worker completed status does not establish criterion completion |
| Unknown result / timeout | Mark pending unknown; preserve footprints/slots and unresolved state | No blind retries or conflicted verification |
| Revision with pending worker | Stop new stale dispatch, cancel if possible, treat old result as historical | Unknown effects and spent usage survive; current permission never inferred from stale Card |
| Proof of effects | Commit typed affected IDs and evidence; release only resolved reservation | No cap refund and no completion from uncertain writes |
| Missing audited facts | One scoped observation or strictly shrinking audit-critical gap | No endless requests for identical evidence |
| No-progress cycles | Force different hypothesis / discriminating observation after two unsuccessful correction+verification cycles | No fixed total worker-call budget; diagnostic delta is not criterion completion |
| Out-of-grant need | TFC for exact additional capability or stop | No authority via Worker suggestion or alternate tool syntax |

**Retry decisions:** no-effect bounded retry → same Card; new material state or evidenced diagnostic alternative → replan; wider boundary/action/effects → TFC; unknown effects, host denial, impossible audit or exhausted strategies → stop or authorized observation. All runner commands are audited as *registered* commands, not executable raw shell guesses. Incidental caches never hide intentional file edits.

## Build and Validator compatibility gate

The exact current implementation constraints are part of the migration:

- `scripts/build_agent_profiles.py` replaces **exactly one** `Use frontmatter-listed agents only.` and injects Copilot-only routing at **exactly one** `## Worker selection`. Keep these exact anchors initially, or change builder+tests atomically and prove a single transformation.
- Preserve canonical, Local and Copilot generated output and model/effort/target/Hook/tool declarations. Run `python scripts/build_agent_profiles.py --write` on the branch, then `--check`.
- The current Validator asserts **26 global exact markers and 81 section-placed marker strings** (13 required sections), plus contract/Card checks, forbidden legacy markers, coupling restrictions, mutation tests and a 30k body cap. All are migration inputs, not automatically valid new architecture constraints.
- In PR B, classify each marker: `STRUCTURAL` (parseable field/boundary), `CRITICAL_TEXT` (exact security assertion intentionally preserved), `SEMANTIC_REVIEW` (cannot be established by static matching). Map old marker→new check before deleting any old checker.
- A refactor must not simply delete required markers/tests until covered by an equivalent structured assertion, named critical assertion or explicit **unverified** limitation; treat missing safety coverage as a blocker. Include mutation tests for boundary widening, execute criterion linkage, status release, cap omission/null, stale revision, and Worker internal-field leakage.
- `scripts/run_tests.py` uses a **fixed two-module test inventory** and actively rejects unexpected test modules. Extend existing suites and update its explicit registry only if truly necessary; do **not** add an unregistered test file.
- `docs/` is already allowed in the release ZIP (PR #92). Keep release archive path/portability checks and built-package verification unchanged.

## Full 42-case traceability matrix

Each existing case is included **exactly once**. This is the acceptance inventory for PR B/C. Mapping to a responsibility is **not evidence of runtime success**.

| Case | Primary new owner | Must preserve |
| --- | --- | --- |
| [CONF-001](../tests/conformance.md) | Human approval | authorization-relevant ambiguities block dispatch; method uncertainty may be internal |
| [CONF-002](../tests/conformance.md) | Human approval / Effects | display bounded capability and cumulative effects; target cap is opt-in |
| [CONF-003](../tests/conformance.md) | Human approval | exact approval token, one pending review, session-unique IDs |
| [CONF-004](../tests/conformance.md) | Operations / Task Cards | discovery does not authorize effects; exact promotion is separate |
| [CONF-005](../tests/conformance.md) | Contract / Pending | narrowing and goal changes create correct revision/staleness |
| [CONF-006](../tests/conformance.md) | Contract / Audit | stale results, hidden authority and unbounded tool use rejected |
| [CONF-007](../tests/conformance.md) | Worker selection | route on positive runtime evidence; never trial-call ineligible workers |
| [CONF-008](../tests/conformance.md) | Evidence / Recovery | criterion evidence and progress-driven loop control |
| [CONF-009](../tests/conformance.md) | Worker selection / Evidence | verify discovery coverage and actual tool availability |
| [CONF-010](../tests/conformance.md) | Effects / Verification | bounded incidental outputs, never source edits disguised as caches |
| [CONF-011](../tests/conformance.md) | Verification | conflicted claims need narrow independent resolution |
| [CONF-012](../tests/conformance.md) | Task Cards / Audit | every execute operation has an internal active criterion link |
| [CONF-013](../tests/conformance.md) | Recovery | differentiate productive retry from unchanged-state repetition |
| [CONF-014](../tests/conformance.md) | Evidence | source fidelity and normative originals without authority expansion |
| [CONF-015](../tests/conformance.md) | Results / Recovery | bounded read-only recovery of spilled Worker output |
| [CONF-016](../tests/conformance.md) | Worker selection / Evidence | missing evidence can be resolved by interchangeable workers |
| [CONF-017](../tests/conformance.md) | Evidence | partial discovery cannot prove global absence |
| [CONF-018](../tests/conformance.md) | Operations / Identity | runtime identity resolution does not invent approval criteria |
| [CONF-019](../tests/conformance.md) | Operations / Identity | canonical path/symlink identity and no alias-based cap bypass |
| [CONF-020](../tests/conformance.md) | Operations / Runner | scoped command discovery does not prove missing registrations |
| [CONF-021](../tests/conformance.md) | Operations / Runner | select and audit exact registered commands under approved checks |
| [CONF-022](../tests/conformance.md) | Recovery / Runner | actionable missing-registration blockers, resume only by fresh delegation |
| [CONF-023](../tests/conformance.md) | Human approval / Runner | initial grant can include bounded required local checks |
| [CONF-024](../tests/conformance.md) | Build / Validator | Local and Copilot routing, tools, and Hook compatibility |
| [CONF-025](../tests/conformance.md) | Concurrency | independent dispatch up to three when supported |
| [CONF-026](../tests/conformance.md) | Concurrency | serialize overlapping identities; preserve independent edits |
| [CONF-027](../tests/conformance.md) | Effects / Concurrency | detect cache/output/shared-resource conflicts |
| [CONF-028](../tests/conformance.md) | Contract / Concurrency | optional cap accounting and order-independent audit |
| [CONF-029](../tests/conformance.md) | Pending / Recovery | timeouts, revision, cancellation and verification barriers |
| [CONF-030](../tests/conformance.md) | Pending / Results | interleaved spill recovery remains tied to Card/revision |
| [CONF-031](../tests/conformance.md) | Worker selection | positive operation modality, especially explicit execute support |
| [CONF-032](../tests/conformance.md) | Human approval / Task Cards | goal-level grant becomes exact audited cards without needless reapproval |
| [CONF-033](../tests/conformance.md) | Recovery / Runner | diagnostic progress and changed command definition re-audit |
| [CONF-034](../tests/conformance.md) | Contract | omitted cap vs finite integer vs approved explicit null |
| [CONF-035](../tests/conformance.md) | Effects / Cap | intentional source edits cannot be classified as incidental cache |
| [CONF-036](../tests/conformance.md) | Task Cards | cohesive pre-audited operations and safe no-effect retry |
| [CONF-037](../tests/conformance.md) | Runner | hash-free run uses exact registered command/workspace; host denial holds |
| [CONF-038](../tests/conformance.md) | Task Cards / Ledger | internal provenance and scheduling metadata do not reach workers |
| [CONF-039](../tests/conformance.md) | Planning / Recovery | hypothesis-driven useful work without fixed invocation budget |
| [CONF-040](../tests/conformance.md) | Contract | reject partial contract drift and lost exclusions/verification/cap |
| [CONF-041](../tests/conformance.md) | Pending / Contract | unknown effects and consumed slots survive revision; stale report stays historical |
| [CONF-042](../tests/conformance.md) | Audit / Task Cards | Workers/tools remain neutral; malicious output cannot grant or complete |

## Implementation staging / merge gates

**PR A — completed:** [PR #93](https://github.com/yaona807/dandori/pull/93) reviewed and recorded the design, gates and complete conformance ownership matrix.

**PR B — completed:** [PR #94](https://github.com/yaona807/dandori/pull/94) atomically updated the canonical Orchestrator, Validator, regression tests and both bundles. Ten sections replaced eighteen; pending Card-level `criterion_refs` were removed as duplicate state and derived from operation provenance. Required safety markers, authorization fold, dependencies and reservations were retained. GitHub Actions and Codex code review passed; actual runtime conformance was not run.

**PR C — documentation sync:** update both READMEs and this design record with actual measurements, current Ledger ownership, unchanged Worker/Runner boundary and the unverified-runtime limitation; release-archive checks must remain green.

**PR B outcome:** source-body `29,185 → 26,567`; Copilot-body `29,677 → 27,059`; H2 sections `18 → 10`. Duplicated pending Card-level `criterion_refs` removed; execution, provenance, Evidence, cumulative cap usage, dependency, returned/unknown and footprint state retained. Validator section-owned markers were remapped; existing regression tests retained and human-visible TFR/TFC-heading regression coverage added. All 42 conformance cases remain in the acceptance matrix, not executed in a real host (`not_run`).

**Human-requested skip:** Real environment conformance on [Issue #57](https://github.com/yaona807/dandori/issues/57) is deferred, not declared passed and the Issue is not closed. Static CI proves only its validated checks; it cannot certify live model adherence or per-file OS sandboxing.
