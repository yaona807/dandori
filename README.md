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

DANDORI is an Orchestrator layer for GitHub Copilot Custom Agents in VS Code.

It converts a user-approved work contract into minimal, bounded Task Cards. The Orchestrator can adapt the internal execution plan without repeatedly asking for approval, while every worker invocation remains constrained by the approved goal, completion criteria, operation permissions, target-expansion limit, exclusions, and verification requirements.

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

- **User-approved contract**: one immutable goal, completion criteria, target/action/effect operations, target-expansion limit, exclusions, and verification requirements
- **Adaptive internal plan**: worker choice, ordering, Task Card grouping, bounded investigation, retry, and verification

The contract remains fixed until the user approves a meaningful widening. The internal plan can change freely inside that contract.

## Bounded adaptive orchestration

DANDORI is built around one containment rule:

```text
worker execution operation ⊆ exact Task Card operation ⊆ exact contract permission or authorized instantiation of a contract rule

active approved contract = ordered fold(authorization source sequence)
```

A **Task Flow Review (TFR)** is a short human decision surface. It is not a detailed execution plan.

A **Task Card** is a worker-neutral execution contract for one permission boundary. It defines the concrete objective, criterion references, exact target/action/effect operations, invocation limits, expected progress, and stop conditions for one invocation.

The Orchestrator may change workers, reorder internal work, split or combine Task Cards, perform bounded investigation, and add verification without reapproval. It must request a **Task Flow Change (TFC)** only when the approved contract itself must widen.

## Key features

- **Compact approval**: users review one goal, completion criteria, complete target/action/effect operations, target-expansion limit, verification requirements, exclusions, and reapproval conditions.
- **Revisioned contracts**: every Task Card and result belongs to one active contract revision reconstructed by folding an ordered, append-only sequence of normalized authorization patches.
- **Adaptive planning**: internal routing and execution order can change without reapproval when the contract does not widen.
- **Permission-boundary Task Cards**: work is grouped by authorization boundary rather than mechanically split into many tiny steps.
- **Discovery/effect separation**: a target discovered by a worker cannot be affected in the same invocation.
- **Atomic effect targets**: automatic authorization applies only to individually addressable targets, not directories, wildcard sets, or “related files.”
- **Operation-level authorization**: each permission binds an observation boundary or exact effect target/rule, one action, and every effect the action may produce; separate lists never create Cartesian-product permission.
- **Worker-neutral orchestration**: worker definitions remain the source of truth for worker behavior and output conventions.
- **Contract audit**: worker-reported operations, limits, evidence, expected progress, and revision are checked before criterion progress is accepted.
- **Separate-context verification**: persistent changes are verified through a separate invocation that may observe and run explicitly authorized non-mutating checks.
- **Differential approval**: the complete contract patch is shown whenever a revision contains widening, including concurrent reductions.
- **Progress-based loop control**: equivalent calls without new evidence, artifacts, authorization, verification, or a more specific blocker are prohibited.

## Bring your own workers

The Orchestrator does not contain a static worker capability manifest, worker-specific routing table, or duplicated worker instructions.

At execution time it selects a plausible worker from the runtime-visible allowed agent names and descriptions, then sends one self-contained bounded Task Card. It does not read or depend on a Worker definition file and does not adopt worker-specific input keys, wrappers, schemas, or input-language requirements. A Worker that reports a role, tool, or input mismatch is treated as blocked; the Orchestrator may try at most one other candidate without expanding authorization.

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
Flow Ledger: criteria, exact operation instances, target-cap usage, limits, material evidence
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

**Completion criteria**
- The cause is explained with evidence.
- Required changes are completed within the authorized operations.
- Available verification results or the reason verification was unavailable are reported.

**Authorized operations**
- Observe: the target repository — search and read (`observe`)
- Affect: explicitly listed existing files — modify existing content (`change_local`)
- Affect by rule: evidence-backed atomic existing files — modify existing content (`change_local`)

**Automatic target addition**
- Flow-wide cumulative maximum: 5

**Verification requirements**
- Persistent changes are checked in a separate context.

**Reapproval**
A new TFR is required for a different goal.
A TFC is required for broader criteria, operations, limits, removed exclusions, or reduced verification.
```

Approval is exact-token based and language-neutral:

```text
APPROVE:TFR-ab12
```

Extra conditions, corrections, or additional instructions are treated as a change request, not approval. TFR/TFC IDs and approval tokens are never reused within the same chat session.

Every authorized operation displays all cumulative effects it may produce. A rule-based operation shares one flow-wide automatic-target cap with every other rule-based operation; the cap is shown separately rather than repeated per rule.

If the contract must widen later, the Orchestrator displays only the difference:

```markdown
## Task Flow Change: TFC-cd34

**Reason**
The work requires more targets than the current automatic-addition cap permits.

**Contract patch**
- Set: auto-added target maximum: 5 → 7

All unlisted contract fields remain unchanged.
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

Authorization is operation-based. Each permission binds one observation boundary, exact affect target, or bounded authorization rule to one action and all effects that action may produce. No separate target, action, or effect list grants authorization.

## Target authorization

Observation boundaries and effect targets are separate.

A repository, directory, domain, query, or wildcard may define where observation is allowed, but it is not one automatically authorized effect target. Effects may be applied only to **atomic targets**: the smallest individually addressable target with a stable identifier, such as a file, document, record, issue, pull request, comment, API resource, or specific configuration item.

Discovered targets move through bounded states:

```text
explicit → authorized
candidate → authorized or rejected
```

A candidate can be authorized without reapproval only when its exact identity, approved-boundary containment, deliverable traceability, concrete evidence source, required target/action/effect operation, risk state, and cumulative cap can all be established. A candidate never becomes a new discovery anchor and cannot be affected in the invocation that discovered it.

Existing directories and directory subtrees are not atomic effect targets. An exact directory path that is confirmed not to exist may be authorized only through a `create_directory` operation that binds that path and `change_local`. Every required parent directory and every child artifact needs a separate operation; directory creation never grants permission over unspecified descendants or an existing subtree.

The active contract is a materialized view reconstructed by folding an append-only sequence of normalized patches. The first approved TFR initializes the contract; approved TFCs apply complete revision patches; explicit user narrowing records only structural reductions. Free-form user text is audit context, not executable permission, and removed permission is never restored implicitly.

Display-only wording or localization can avoid a revision only when the normalized authorization source sequence and every executable contract field remain byte-for-byte unchanged. A change to a criterion, operation, effect, limit, verification requirement, exclusion, stable ID, or source order is structural and follows the applicable revision path.

An automatic-target cap may be reduced only to a value greater than or equal to the number of unique targets already consumed. Target uniqueness and cap consumption use the canonical typed identity of each atomic subject, including its namespace or containing resource. Removing permissions or criteria does not reverse consumed usage.

## Verification and limits

Persistent local changes, external effects, and destructive effects require a separate verification invocation when possible. A verification Task Card may observe and may run explicitly authorized checks only when they are non-mutating and use no-write, no-update, and no-fix modes. The same narrow verification policy applies when material Worker claims conflict, so an exact contradiction may be resolved by observation or an explicitly authorized non-mutating check rather than confidence. Commands that may write source files, snapshots, lockfiles, caches, reports, or other persistent artifacts must be configured not to write them or remain unexecuted. Verification never performs corrections or local, external, or destructive mutations. This is **separate-context verification**, not guaranteed independent third-party review.

If verification is unavailable, DANDORI reports the result as unverified rather than entering an approval loop or claiming completion without qualification.

DANDORI limits repeated work by requiring each invocation to produce a concrete delta: a new material fact, artifact, candidate operation, criterion evidence or transition, verification result, conflict resolution, or more specific blocker. Before each execution attempt, DANDORI forms every `<criterion_id>|<source_permission_id>` pair from the Task Card. Any Task Card containing `execute` must therefore reference at least one active criterion; a contract-wide conflict or blocker may omit criteria only when it is observation-only. Each pair has its own two-attempt limit, so changing the Worker, order, grouping, or Task Card ID does not reset it.

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
    BrowserQA.agent.md
  skills/
    code-review/
      SKILL.md
.github/
  workflows/
    validate.yml
scripts/
  validate_definitions.py
  validate_release_archive.py
tests/
  test_validate_definitions.py
  test_validate_release_archive.py
  conformance.md
assets/
  dandori-logo.png
```

| Component | Role |
| --- | --- |
| `Orchestrator` | Control-plane agent for intake, compact approval, contract management, Task Card creation, worker selection, audit, loop control, and synthesis |
| Reference workers | Optional workers for investigation, pull-request inspection, implementation, review, and browser-based verification |
| `code-review` skill | Focused review guidance used by the reference review worker |

## Compatibility and prerequisites

- DANDORI agents explicitly target VS Code.
- Subagent restriction uses the `agents` allowlist, which is currently an experimental VS Code feature.
- `PullRequestResearcher` requires the GitHub Pull Requests extension and its exposed tools.
- `BrowserQA` requires the configured browser tool set.
- Unavailable or unrecognized tool names can be ignored by the runtime; verify actual tool availability before use.
- A bundled Worker calls a tool only when the tool arguments and runtime behavior can enforce the delegated boundary. If the available tool can operate only on a broader scope, the Worker returns `blocked` and identifies the narrower capability required.
- The bundled reference set does not include a terminal-command Worker. Add a dedicated, narrowly scoped execution Worker when tests, lint, type checks, builds, formatters, or other commands are required.
- External workers must accept a self-contained request, avoid sub-delegation, use no broader tools than necessary, and describe their role and effect boundary accurately.
- Confirm the loaded source for every agent and skill with VS Code Chat Diagnostics.

## Model requirements

DANDORI works best with a capable reasoning model for the Orchestrator.

The Orchestrator must distinguish execution-method ambiguity from authorization ambiguity, normalize contracts without widening them, create minimal Task Cards, audit worker results, resolve conflicts, and stop when containment cannot be established.

Worker models can be smaller, faster, or specialized depending on the delegated task.

## Installation

DANDORI targets GitHub Copilot Custom Agents in VS Code. Copy the agents and skills into discovery paths supported by that environment.

### User-level installation

Use this when you want the same DANDORI configuration across workspaces:

```bash
mkdir -p ~/.copilot/agents ~/.copilot/skills
cp .copilot/agents/*.agent.md ~/.copilot/agents/
cp -R .copilot/skills/* ~/.copilot/skills/
```

### Standard workspace installation

Use VS Code's standard workspace discovery paths when the configuration should travel with one repository:

```bash
mkdir -p .github/agents .github/skills
cp .copilot/agents/*.agent.md .github/agents/
cp -R .copilot/skills/* .github/skills/
```

### Custom `.copilot` workspace installation

Keeping `.copilot/agents` and `.copilot/skills` inside a workspace requires those locations to be enabled through `chat.agentFilesLocations` and `chat.agentSkillsLocations`. Do not assume that copying `.copilot` into a repository is sufficient without the corresponding discovery settings.


### Upgrade an existing installation

Copying a new version over an existing installation does not remove files that were deleted or renamed in the new release. Before upgrading, remove only the files managed by DANDORI, then copy the new release. Do not remove custom Workers or unrelated Skills.

User-level cleanup:

```bash
rm -f ~/.copilot/agents/{Orchestrator,Researcher,PullRequestResearcher,Writer,Reviewer,BrowserQA}.agent.md
rm -rf ~/.copilot/skills/code-review
```

Standard workspace cleanup:

```bash
rm -f .github/agents/{Orchestrator,Researcher,PullRequestResearcher,Writer,Reviewer,BrowserQA}.agent.md
rm -rf .github/skills/code-review
```

After cleanup, run the installation commands for the selected scope and verify discovery again. For a custom `.copilot` workspace installation, remove the same managed filenames from the configured discovery paths.

### Verify discovery

1. In the VS Code Chat view, open the context menu and select **Diagnostics**.
2. Confirm that every DANDORI agent and the `code-review` skill are loaded without errors.
3. Check the source shown for each agent and confirm that the Orchestrator allowlist resolves to the intended definitions.
4. Confirm that each external Worker satisfies the compatibility checklist above.
5. Remove or disable duplicate same-name definitions from workspace, user, organization, extension, or custom discovery locations.

Avoid keeping multiple active copies of the same agent definition in different locations. Duplicate definitions can cause Copilot to invoke a different definition than the one the user intended.

## Usage

1. Open Copilot Chat.
2. Select the `Orchestrator` agent.
3. Give it a task.
4. Review the compact Task Flow Review.
5. Reply with only the exact approval token when the goal, completion criteria, authorized operations, target-expansion limit, exclusions, and verification requirements are correct.
6. Review only differential changes if the approved contract later needs to widen.

## Definition validation

Run the deterministic validator before opening a pull request:

```bash
python -m pip install PyYAML==6.0.3
python scripts/validate_definitions.py
python -m unittest discover -s tests -p "test_*.py"
```

Create release archives from tracked files rather than zipping the working tree, then validate the actual artifact:

```bash
git archive --format=zip --output=dandori.zip HEAD
python scripts/validate_release_archive.py dandori.zip
```

The archive validator rejects path traversal, symlinks, generated artifacts, duplicate or portability-colliding names, unexpected top-level entries, missing release files, and extracted definitions that fail the repository validator. Portability checks include Unicode NFKC and case-folded collisions, Windows reserved device names, forbidden characters and control characters, and path components ending in a space or period.

GitHub Actions runs deterministic definition validation, mutation tests, and release-archive validation for every pull request and push to `master`. The repository permits only `.github/workflows/validate.yml`, only the `validate` job, and only the `pull_request` and `push` triggers; local Actions under `.github/actions` are forbidden. The checkout step discards persisted credentials, and the validation job has a 15-minute timeout. The validator structurally checks the unconditional job and its exact fail-closed validation steps; moving commands to another job, adding `if`, `needs`, `continue-on-error`, extra jobs or workflows, unapproved triggers, or path filters does not satisfy the contract. All step-level actions and reusable workflows are parsed from YAML and must use full-length commit SHAs. Python bytecode generation is disabled in CI, and the validator rejects tag- or branch-based action references, repository symlinks, missing Python ignore rules, and tracked generated artifacts. The validator treats the bundled definitions as a closed release inventory: only `*.agent.md` files are allowed in the agent directory; execution-bypass frontmatter such as `hooks`, `handoffs`, and `mcp-servers` is rejected; bundled-agent frontmatter, tools, filenames, required sections, safety-policy anchors, and conservative body-size regression floors are fixed; core Orchestrator invariants must remain in their intended sections; and the bundled `code-review` skill must contain only its declared Markdown files. DANDORI-specific coupling and Reviewer-owned worker policy are checked across every Skill Markdown file with case and separator variants normalized. Additional local workers may still be added as `*.agent.md` files, but they remain subject to the common runtime, no-subdelegation, forbidden-frontmatter, and DANDORI-coupling checks and produce a manual policy/Diagnostics review warning. External allowlisted workers also remain a Diagnostics-reviewed warning because their definitions are outside this repository. Required mutation tests must retain a real repository mutation and a failing-validator assertion; their shared helpers are also checked against empty replacements. Every conformance case must retain a non-empty Input and at least one concrete Expected bullet. LLM behavior is not inferred from static files; use the structured cases and run-record template in `tests/conformance.md` for model, Worker-tool, and VS Code release checks.

The validator proves structural constraints, tool boundaries, required policy anchors, and the integrity of the declared validation contract. It does not prove that every natural-language statement across an Agent definition is semantically consistent, nor can it establish actual model behavior from static files alone. Changes to policy wording therefore require human review, and runtime behavior must be checked with the conformance cases for the relevant VS Code, Copilot Chat, model, and extension versions.

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
