<p align="center">
  <img src="./assets/dandori-logo.png" alt="DANDORI logo" width="160">
</p>

<h1 align="center">DANDORI</h1>

<p align="center">
  <strong>Bounded adaptive orchestration for the agents you already use.</strong>
</p>

<p align="center">
  Keep approval compact, execution narrow, and workers replaceable.
</p>

<p align="center">
  <a href="./README_ja.md">日本語</a>
</p>

DANDORI is an Orchestrator layer for GitHub Copilot Custom Agents.

It converts a user-approved work contract into minimal, bounded Task Cards. The Orchestrator can adapt the internal execution plan without repeatedly asking for approval, while every worker invocation remains constrained by the approved goal, operation permissions, limits, and verification requirements.

The core of DANDORI is the **Orchestrator**. The included workers are reference implementations. You can use them as-is, replace them with your own agents, or add specialized workers without embedding their internal details into the Orchestrator.

> DANDORI is an independent open source project. It is not affiliated with, endorsed by, or maintained by GitHub or Microsoft.

## Why DANDORI?

AI agents are powerful, but vague delegation creates predictable failure modes:

- unnecessary repository scans
- repeated tool calls without progress
- speculative edits
- scope expansion during execution
- workers choosing their own next steps
- frequent reapproval for harmless internal plan changes
- long approval screens that users stop reading carefully

Token efficiency is not only about shorter prompts. In agentic workflows, unnecessary work, repeated context, and redundant verification become unnecessary token consumption.

DANDORI separates the workflow into two layers:

- **User-approved contract**: goal, deliverables, observation boundaries, target/action/effect permissions, target-expansion limit, and verification level
- **Adaptive internal plan**: worker choice, ordering, Task Card grouping, bounded investigation, retry, and verification

The contract remains fixed until the user approves a meaningful widening. The internal plan can change freely inside that contract.

## Bounded adaptive orchestration

DANDORI is built around one containment rule:

```text
worker execution operation ⊆ exact Task Card operation ⊆ exact contract permission or authorized instantiation of a contract rule

active approved contract = ordered fold(authorization source sequence)
```

A **Task Flow Review (TFR)** is a short human decision surface. It is not a detailed execution plan.

A **Task Card** is a worker-neutral execution contract for one permission boundary. It defines the concrete objective, authorized target/action/effect operations, card-wide ceilings, limits, acceptance conditions, and stop conditions for one invocation.

The Orchestrator may change workers, reorder internal work, split or combine Task Cards, perform bounded investigation, and add verification without reapproval. It must request a **Task Flow Change (TFC)** only when the approved contract itself must widen.

## Key features

- **Compact approval**: users review only goal, deliverables, observation boundaries, affect operations or bounded authorization rules, target-expansion limit, verification, and reapproval conditions.
- **Revisioned contracts**: every Task Card and result belongs to one active approved contract revision derived from an ordered authorization source sequence.
- **Adaptive planning**: internal routing and execution order can change without reapproval when the contract does not widen.
- **Permission-boundary Task Cards**: work is grouped by authorization boundary rather than mechanically split into many tiny steps.
- **Discovery/effect separation**: a target discovered by a worker cannot be affected in the same invocation.
- **Atomic effect targets**: automatic authorization applies only to individually addressable targets, not directories, wildcard sets, or “related files.”
- **Operation-level authorization**: each permission binds an observation boundary or exact effect target/rule, one action, and every effect the action may produce; separate lists never create Cartesian-product permission.
- **Worker-neutral orchestration**: worker definitions remain the source of truth for worker behavior and output conventions.
- **Contract audit**: worker-reported operations, targets, actions, effects, limits, evidence, and revision are checked before progress is accepted.
- **Separate-context verification**: persistent changes are verified through a separate observation-only invocation when possible.
- **Differential approval**: only the requested widening is shown when reapproval is required.
- **Progress-based loop control**: equivalent calls without new evidence, artifacts, authorization, verification, or a more specific blocker are prohibited.

## Bring your own workers

The Orchestrator does not contain a static worker capability manifest, worker-specific routing table, or duplicated worker instructions.

At execution time it selects a plausible worker from the allowed agents, resolves that worker's active definition, and checks semantic compatibility with the bounded task. It does not adopt worker-specific input keys, wrappers, schemas, or input-language requirements. A compatible worker must be able to process a self-contained request without requiring DANDORI-specific input conventions. Worker selection affects execution quality, but never expands authorization.

This allows you to:

- start with the included reference workers
- reuse existing Custom Agents
- replace workers without redesigning the orchestration logic
- add specialized workers by updating the allowed agent list when needed

DANDORI does not require workers to contain DANDORI-specific implementation details. Worker definitions must not prescribe Task Card keys, input wrappers, caller-specific schemas, or DANDORI-specific output envelopes.

## How it works

```text
User request
   ↓
Compact Task Flow Review
   ↓ exact approval
Authorization source sequence
   ↓ ordered fold
Approved Contract revision
   ↓
Flow Ledger: criteria, authorized operations and targets, limits, material evidence
   ↓
Minimal Task Card for one permission boundary
   ↓
Selected Worker
   ↓
Result normalization and contract audit
   ↓
Separate-context verification when required
   ↓
Complete / next Task Card / differential approval / partial stop
```

The Orchestrator owns the control plane. Workers own narrow execution.

## Approval example

The Orchestrator presents a short review such as:

```markdown
## Task Flow Review: TFR-ab12

**Goal**
Fix the specified defect.

**Deliverables**
An explanation of the cause, the required changes, and the verification results that can be obtained.

**Work boundaries**
- Observe: the target repository
- Affect: explicit targets and evidence-backed atomic existing targets
- Automatic additions: up to five local change targets

**Allowed effects**
- observe
- change_local

**Verification**
- Persistent changes are checked in a separate context.

**Reapproval**
Only if the goal, deliverables, boundaries, target/action/effect permissions, automatic-addition cap, or verification level must widen or weaken.
```

Approval is exact-token based and language-neutral:

```text
APPROVE:TFR-ab12
```

Extra conditions, corrections, or additional instructions are treated as a change request, not approval.

If the contract must widen later, the Orchestrator displays only the difference:

```markdown
## Task Flow Change: TFC-cd34

**Reason**
The work requires more targets than the current automatic-addition cap permits.

**Requested change**
Automatic-addition cap: 5 → 7

**Unchanged**
Goal, deliverables, allowed effects, and verification level
```

The differential change uses the same language-neutral approval format:

```text
APPROVE:TFC-cd34
```

## Language handling

DANDORI uses the user's **interaction language**, not an inferred native language. The Orchestrator chooses it in this order:

1. An explicitly requested language
2. The primary language of the current substantive request
3. The established conversation language
4. English when the language is mixed, ambiguous, or uncertain

User-facing TFR/TFC labels, questions, stop reports, verification labels, and final summaries are localized. Code, paths, identifiers, schema keys, effect tags, evidence states, status values, and approval tokens remain unchanged. A display-language change does not alter the Approved Contract, create a new revision, or require reapproval.

Task Card control fields remain in English. Free-text task instructions use the interaction language. Worker results are translated or summarized for the user without translating code, paths, identifiers, literals, or quoted evidence.

## Effect model

DANDORI uses cumulative effect tags:

| Effect | Meaning |
| --- | --- |
| `observe` | Read, search, inspect, analyze, or fetch information |
| `change_local` | Create or modify local artifacts |
| `execute` | Run commands, tests, scripts, or automation |
| `affect_external` | Mutate remote state through UI, API, messaging, save, or post actions |
| `destructive` | Delete, discard, irreversibly overwrite, or perform similar destructive actions |

Effects are cumulative, not exclusive. For example, a command that can modify files requires both `execute` and `change_local`. Allowing a tool or action never implicitly authorizes its secondary effects.

Authorization is operation-based. Each permission binds an observation boundary or an exact effect target/bounded authorization rule, an action, and all effects that action may produce. Contract-wide action and effect lists are ceilings and summaries only; they do not authorize a target/action combination by themselves.

## Target authorization

Observation boundaries and effect targets are separate.

A repository, directory, domain, query, or wildcard may define where observation is allowed, but it is not one automatically authorized effect target. Effects may be applied only to **atomic targets**: the smallest individually addressable target with a stable identifier, such as a file, document, record, issue, pull request, comment, API resource, or specific configuration item.

Discovered targets move through bounded states:

```text
explicit → authorized
candidate → authorized or rejected
```

A candidate can be authorized without reapproval only when its exact identity, approved-boundary containment, deliverable traceability, concrete evidence source, required target/action/effect operation, risk state, and cumulative cap can all be established. A candidate never becomes a new discovery anchor and cannot be affected in the invocation that discovered it.

The active contract is derived by applying an append-only authorization source sequence in order. Approved TFRs and TFCs may widen the contract; explicit user narrowing records a normalized reduction without additional approval. Free-form user text is audit context, not executable permission, and removed permission is never restored implicitly.

## Verification and limits

Persistent local changes, external effects, and destructive effects require a separate observation-only verification invocation when possible. This is **separate-context verification**, not guaranteed independent third-party review.

If verification is unavailable, DANDORI reports the result as unverified rather than entering an approval loop or claiming completion without qualification.

DANDORI limits repeated work by requiring each invocation to produce a concrete delta: a new material fact, artifact, authorized target, criterion transition, verification result, conflict resolution, or more specific blocker.

If authorization or cumulative loop-control state cannot be reconstructed exactly, DANDORI stops with `state_unrecoverable`. Re-observable evidence may be reacquired inside the approved observation boundary, but lost permission state, cap usage, attempt counts, or pending-revision bindings are never guessed or reset.

## What's included

```text
.copilot/
  agents/
    Orchestrator.agent.md
    Researcher.agent.md
    PullRequestResearcher.agent.md
    Writer.agent.md
    Reviewer.agent.md
    BrowserQa.agent.md
  skills/
    code-review/
      SKILL.md
assets/
  dandori-logo.png
```

| Component | Role |
| --- | --- |
| `Orchestrator` | Control-plane agent for intake, compact approval, contract management, Task Card creation, worker selection, audit, loop control, and synthesis |
| Reference workers | Optional workers for investigation, pull-request inspection, implementation, review, and browser-based verification |
| `code-review` skill | Focused review guidance used by the reference review worker |

## Model requirements

DANDORI works best with a capable reasoning model for the Orchestrator.

The Orchestrator must distinguish execution-method ambiguity from authorization ambiguity, normalize contracts without widening them, create minimal Task Cards, audit worker results, resolve conflicts, and stop when containment cannot be established.

Worker models can be smaller, faster, or specialized depending on the delegated task.

## Installation

Copy the agents and skills into discovery paths supported by your GitHub Copilot environment.

Example user-level installation:

```bash
mkdir -p ~/.copilot/agents ~/.copilot/skills
cp .copilot/agents/*.agent.md ~/.copilot/agents/
cp -R .copilot/skills/* ~/.copilot/skills/
```

Example repository-level installation for an environment that discovers `.copilot`:

```bash
cp -R .copilot /path/to/your/repository/
```

Avoid keeping multiple active copies of the same agent definition in different locations. Duplicate definitions can cause the Orchestrator to inspect one definition while Copilot invokes another.

## Usage

1. Open Copilot Chat.
2. Select the `Orchestrator` agent.
3. Give it a task.
4. Review the compact Task Flow Review.
5. Reply with only the exact approval token when the goal, deliverables, boundaries, effects, target-expansion limit, and verification level are correct.
6. Review only differential changes if the approved contract later needs to widen.

## Design principles

- **Human approval is a contract, not an execution trace.**
- **Internal plans may adapt; approved permissions may not.**
- **Target, action, and effect are authorized together as one operation.**
- **The active contract is derived from an ordered, append-only authorization source sequence.**
- **Task Cards are split by permission boundary, not automatically by process step.**
- **Discovery does not authorize effects.**
- **Missing permission is denied.**
- **Worker output cannot authorize the next action.**
- **Worker selection affects quality, not scope.**
- **Only material claims receive evidence-state tracking.**
- **Verification is narrow and effect-driven.**
- **Reapproval is differential and risk-based.**
- **No progress means no repeated delegation.**

## Security boundary

DANDORI narrows delegated work and improves detection and stopping behavior, but it is not an operating-system sandbox. Tool restrictions, Workspace Trust, approval settings, diff review, and other platform controls remain important.

DANDORI does not claim that worker deviation is impossible. It narrows contracts, separates discovery from effects, audits reported actions, and stops when containment cannot be established.

## Non-goals

DANDORI is not:

- a general-purpose autonomous coding agent
- a replacement for GitHub Copilot or human review
- an operating-system security sandbox
- a durable workflow engine
- a CI/CD runner
- an agent marketplace
- a worker capability-manifest standard
- a framework that requires workers to contain DANDORI-specific internals
- a framework that encourages workers to self-delegate or expand scope
- an official GitHub or Microsoft product

## License

MIT. See [LICENSE](./LICENSE).
