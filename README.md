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

It converts a human-approved goal and capability envelope into minimal, bounded Task Cards. Orchestrator may replan freely inside the approved resource/effect boundary while every Worker remains constrained by exact delegated operations.

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

- **User-approved contract**: one immutable goal, completion criteria, resource-bounded capability families, complete effect classes, exclusions, and verification requirements
- **Adaptive internal plan**: worker choice, ordering, Task Card grouping, bounded investigation, retry, and verification

The contract remains fixed until the user approves a meaningful widening. The internal plan can change freely inside that contract.

## Bounded adaptive orchestration

DANDORI is built around one containment rule:

```text
worker execution operation ⊆ exact Task Card operation ⊆ instance of a human-approved capability envelope

active approved contract = ordered fold(authorization source sequence)
```

A **Task Flow Review (TFR)** is a short human decision surface. It is not a detailed execution plan.

A **Task Card** is a worker-neutral execution contract for one permission boundary. It defines the concrete objective, criterion references, exact target/action/effect operations, invocation limits, expected progress, and stop conditions for one invocation.

The human approves the goal, resource boundary, capability classes, effects, and exclusions—not file names or command IDs. The Orchestrator investigates, chooses exact targets/checks, changes workers, and replans within that envelope; it requests a **Task Flow Change (TFC)** only to widen authority. Every Worker remains bound by an exact Task Card.

For compatible operations already explicitly authorized, a single Task Card can list several exact targets. The Worker may select among those targets and choose the execution order and valid arguments without another approval. This does not authorize additional operations just because they are registered or discoverable. A Worker reports confirmed missing prerequisites (for example, a workspace or command registration) with its evidence and missing information; only the Orchestrator decides whether to request a TFC, delegate registration, and issue a new Task Card to resume. The Worker does not register or resume on its own initiative.

For build/lint/test checks, the initial TFR may authorize registered local verification as a capability with bounded side effects. A Worker discovers exact available commands; Orchestrator verifies their identity, arguments, workspace, and effects, then issues a separate exact execution Task Card. Instructions and registrations supply evidence, never authority. Stale definitions must be re-discovered and re-audited, and host restrictions cannot be bypassed. Known in-scope discoveries do not force reapproval.

## Key features

- **Goal-level approval**: users review a goal, bounded capability families, effect classes, verification, and exclusions, without enumerating individual files or commands.
- **Revisioned contracts**: every Task Card and result belongs to one active contract revision reconstructed by folding an ordered, append-only sequence of normalized authorization patches.
- **Adaptive planning**: internal routing and execution order can change without reapproval when the contract does not widen.
- **Conflict-aware parallelism**: up to three independent Task Cards may run concurrently when supported; overlapping file or shared-resource effects serialize.
- **Permission-boundary Task Cards**: work is grouped by authorization boundary rather than mechanically split into many tiny steps.
- **Discovery/effect separation**: a target discovered by a worker cannot be affected in the same invocation.
- **Atomic Worker targets**: Orchestrator instantiates exact, individually addressable effect targets from the approved envelope; no Worker receives project-wide edit rights.
- **Capability containment**: a human grant binds resource boundary, operation family, complete effects, and conditions; separate lists never create Cartesian-product authority.
- **Worker-neutral orchestration**: worker definitions remain the source of truth for worker behavior and output conventions.
- **Contract audit**: worker-reported operations, limits, evidence, expected progress, and revision are checked before criterion progress is accepted.
- **Separate-context verification**: a separate invocation may run approved checks with declared incidental local outputs (such as caches), never silently mutate verification targets.
- **Differential approval**: the complete contract patch is shown whenever a revision contains widening, including concurrent reductions.
- **Evidence-driven loop control**: validated material progress or new supported diagnostic progress permits continuation; stagnation requires a strategy change rather than a fixed two-cycle flow stop.

## Bring your own workers

The Orchestrator does not contain a static worker capability manifest, worker-specific routing table, or duplicated worker instructions.

At execution time it selects a plausible worker from the runtime-visible allowed agent names and descriptions, then sends one self-contained bounded Task Card. Before delegation, the description must positively support each required operation modality: file editing does not imply terminal execution, and an `execute+change_local` command is still an execution operation. Mixed work is split into dependency-ordered cards when no worker supports all required modalities. The Orchestrator does not read or depend on a Worker definition file and does not adopt worker-specific input keys, wrappers, schemas, or input-language requirements. A blocked compatible candidate is excluded; another eligible untried candidate may be tried without expanding authorization. Recovery stops when one is suitable or no compatible candidate remains.

This allows you to:

- start with the included reference workers
- reuse existing Custom Agents
- replace workers without redesigning the orchestration logic
- add specialized workers by updating the allowed agent list when needed

DANDORI does not require workers to contain DANDORI-specific implementation details. Worker definitions must not prescribe Task Card keys, input wrappers, caller-specific schemas, or DANDORI-specific output envelopes.

A worker description explains delegable capabilities, not permissions. A workspace or subtree normally denotes a logical resource; a user-requested exact path spelling remains a separate constraint. Workers use delegated paths directly where tools enforce their bounds; they need alias evidence only when differing spellings affect identity or scope. Orchestrator audits verified resource identity against the approved boundary, not incidental spelling, and never turns tool-returned paths into new criteria. Neither an unverified alias nor an out-of-boundary link permits additional access. These principles apply to code research, file edits, reviews, and execution.

If a VS Code/Copilot file tool incorrectly reports an authorized file as outside the workspace, do not invent extra DANDORI permissions or bypass the host's prompt. Record the tool, VS Code/Copilot versions, and paths for diagnosis. See upstream fixes [microsoft/vscode#331566](https://github.com/microsoft/vscode/issues/331566) and [microsoft/vscode#334409](https://github.com/microsoft/vscode/issues/334409); whether a specific installation includes the fixes must be checked separately.

## Parallel worker dispatch

The Orchestrator can dispatch up to **three independent Task Cards concurrently** when the active VS Code harness supports it, falling back to serial delegation otherwise. A task waits until its dependencies have been audited. Before dispatch, the Orchestrator compares conservative read, write, and exclusive-resource footprints derived from **all permitted operations**, not worker names. Two reads may overlap; a read/write or write/write collision, shared command output, index, cache, port, unknown side effect, or unresolved resource identity prevents overlapping execution. Verified aliases and overlapping subtrees count as the same resource when appropriate.

Concurrent dispatch reserves any optional human-imposed target cap before launch, without adding authorization. Results are audited per Task Card ID and contract revision, regardless of return order. Timed-out or uncertain effects keep conflicting tasks waiting until safely resolved, and verification waits for relevant writes to finish. Parallel scheduling is internal to one Orchestrator flow; it does not lock other sessions or human edits. Worker definitions and Task Card permissions remain unchanged. Test real overlap and fallback in [CONF-025–030](./tests/conformance.md).

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
Flow Ledger: criteria, exact operation instances, optional cap usage, material/diagnostic evidence
   ↓
Ready independent Task Cards (up to three)
   ↓
Selected Workers (one card each)
   ↓
Per-card result normalization and contract audit
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
- Required changes are completed within the approved capability envelope.
- Available verification results or the reason verification was unavailable are reported.

**Authorized capabilities**
- Investigate the target repository (`observe`)
- Edit code and tests inside the target repository (`change_local`)
- Execute registered local checks, including bounded cache writes (`observe, execute, change_local`)

**Verification requirements**
- Persistent changes are checked in a separate context.

**Reapproval**
A new TFR is required for a different goal.
A TFC is required for a broader boundary, action family, effects, removed exclusions, or reduced verification.
```

Approval is exact-token based and language-neutral:

```text
APPROVE:TFR-ab12
```

Extra conditions, corrections, or additional instructions are treated as a change request, not approval. TFR/TFC IDs and approval tokens are never reused within the same chat session.

Every capability displays its boundary, operation family, and cumulative effects. New exact in-scope file or command subjects require no human reapproval, but the Orchestrator creates a narrow Task Card for each Worker invocation.

If the contract must widen later, the Orchestrator displays only the difference:

```markdown
## Task Flow Change: TFC-cd34

**Reason**
The work requires a remote operation excluded by the original local-only contract.

**Contract patch**
- Add: remote publishing capability for one named destination (`affect_external`)

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

Human authorization is capability-based: each indivisible grant binds one resource boundary, action family, complete effects, and conditions. Orchestrator translates a matching grant into exact Worker operations; separate lists never multiply authority.

## Target authorization

Observation boundaries and effect targets are separate.

The human may approve local edits across a repository without pre-enumerating files. A Worker may affect only **atomic targets** instantiated by Orchestrator, such as an exact file; a repository, directory, query, or wildcard is never itself a Worker effect target.

Discovered targets move through bounded states:

```text
explicit → authorized
candidate → authorized or rejected
```

A candidate can be authorized by Orchestrator without human reapproval when its exact identity, relevance, containment, evidence, action/effects, and any optional user cap all match one approved capability. Discovery does not grant authority, and a candidate cannot be affected by the Worker invocation that discovered it.

Existing directories and directory subtrees are not atomic effect targets. Creating an exact authorized file may also create only the missing ancestor directories required to materialize that file; those ancestors are incidental structure, consume no separate effect target, and grant no permission over siblings or other descendants. A standalone directory creation still requires a confirmed-nonexistent exact path bound to `create_directory` and `change_local`.

The active contract is a materialized view reconstructed by folding an append-only sequence of normalized patches. The first approved TFR initializes the contract; approved TFCs apply complete revision patches; explicit user narrowing records only structural reductions. Free-form user text is audit context, not executable permission, and removed permission is never restored implicitly.

Display-only wording or localization can avoid a revision only when the normalized authorization source sequence and every executable contract field remain byte-for-byte unchanged. A change to a criterion, operation, effect, limit, verification requirement, exclusion, stable ID, or source order is structural and follows the applicable revision path.

No automatic target-count cap is imposed by default. If the human sets one, it cannot be lowered below already affected unique subjects; canonical typed identities avoid alias double-counting.

## Verification and limits

Persistent changes require separate-context verification. The verifier may run an approved registered check with declared incidental local outputs (such as caches), but must not intentionally modify source, baselines, snapshots, or the state under verification. All real effects must be authorized and no unexpected changes may occur. Unknown effects block that method. Verification never silently performs corrections or remote/destructive actions.

If verification is unavailable, DANDORI reports the result as unverified rather than entering an approval loop or claiming completion without qualification.

DANDORI tracks **material progress** (independently verified criterion improvement without regression) separately from **diagnostic progress** (new source-backed evidence eliminating a hypothesis, finding a prerequisite, or producing an actionable candidate). Only material progress completes criteria. Two no-progress correction→verification cycles trigger re-planning, not an automatic full stop; if no distinct in-contract strategy remains, report a partial result. Equivalent executions on unchanged state are still prohibited, except for one narrow conflict/nondeterminism check. An `execute` Task Card always references an active criterion.

If the current session's authorization or cumulative loop-control state cannot be established reliably, DANDORI stops with `state_unrecoverable`. Re-observable evidence may be reacquired inside the approved observation boundary, but permission state, cap usage, the consecutive no-progress counter, and pending-revision bindings are never guessed or reset. DANDORI does not provide cross-session resume or durable workflow state.

## What's included

```text
.copilot/
  agents/
    Orchestrator.agent.md
    Researcher.agent.md
    GitHubResearcher.agent.md
    Writer.agent.md
    CommandRunner.agent.md
    Reviewer.agent.md
    BrowserQA.agent.md
  command-runner/
    command-runner.mjs
    command-runner-interface.mjs
    command-runner-hook.mjs
    command-runner.test.mjs
    workspaces.example.json
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
| Reference workers | Optional workers for investigation, exact GitHub issue/pull-request inspection, implementation, review, and browser-based verification |
| `CommandRunner` | Optional execution worker that exposes registered commands through a fixed bounded interface and keeps large command output in its own temporary execution cache |
| `code-review` skill | Focused review guidance used by the reference review worker |

## Compatibility and prerequisites

- DANDORI agents explicitly target VS Code.
- Bundled agents declare both VS Code Local and Copilot harness tool aliases where supported (`agent`/`task` for delegation and `execute/runInTerminal`/`execute` for CommandRunner). These declarations are compatibility candidates, not proof of runtime availability. Verify the active harness and loaded tools using the [conformance cases](./tests/conformance.md), especially `CONF-024`.
- Subagent restriction uses the `agents` allowlist, which is currently an experimental VS Code feature.
- `GitHubResearcher` requires the GitHub Pull Requests extension and its exposed tools.
- `BrowserQA` requires the configured browser tool set.
- Unavailable or unrecognized tool names can be ignored by the runtime; verify actual tool availability before use.
- A bundled Worker calls a tool only when the tool arguments and runtime behavior can enforce the delegated boundary. If the available tool can operate only on a broader scope, the Worker returns `blocked` and identifies the narrower capability required.
- `CommandRunner` is included as an optional terminal-command Worker. Its agent definition is discovered with the other agents, but its fixed user-level runner must also be installed from `.copilot/command-runner/`. See [the CommandRunner setup](./.copilot/command-runner/README.md). Agent-scoped hooks require `chat.useCustomAgentHooks` to be enabled.
- External workers must accept a self-contained request, avoid sub-delegation, use no broader tools than necessary, and describe their role and effect boundary accurately.
- Confirm the loaded source for every agent and skill with VS Code Chat Diagnostics.

## Model requirements

DANDORI works best with a capable reasoning model for the Orchestrator.

The Orchestrator must distinguish execution-method ambiguity from authorization ambiguity, normalize contracts without widening them, create minimal Task Cards, audit worker results, resolve conflicts, and stop when containment cannot be established.

The bundled agent definitions pin **GPT-6.1 Sol (copilot)** for the Orchestrator and **GPT-6 Luna (copilot)** for every Worker, with `reasoning-effort: medium` for all seven agents. The `reasoning-effort` frontmatter field is applied by the Copilot harness; model availability and actual model selection still require runtime verification. Custom or external Workers may select their own models.

## Installation

DANDORI targets GitHub Copilot Custom Agents in VS Code. Copy the agents and skills into discovery paths supported by that environment.

### User-level installation

Use this when you want the same DANDORI configuration across workspaces:

```bash
mkdir -p ~/.copilot/agents ~/.copilot/skills
cp .copilot/agents/*.agent.md ~/.copilot/agents/
cp -R .copilot/skills/* ~/.copilot/skills/
```

If you use `CommandRunner`, also complete the separate [CommandRunner installation](./.copilot/command-runner/README.md), which installs the fixed runner under `~/.copilot/command-runner/`.

### Standard workspace installation

Use VS Code's standard workspace discovery paths when the configuration should travel with one repository:

```bash
mkdir -p .github/agents .github/skills
cp .copilot/agents/*.agent.md .github/agents/
cp -R .copilot/skills/* .github/skills/
```

A workspace-level `CommandRunner.agent.md` still uses the fixed user-level runner under `~/.copilot/command-runner/`; install that runner separately before using the worker.

### Custom `.copilot` workspace installation

Keeping `.copilot/agents` and `.copilot/skills` inside a workspace requires those locations to be enabled through `chat.agentFilesLocations` and `chat.agentSkillsLocations`. Do not assume that copying `.copilot` into a repository is sufficient without the corresponding discovery settings.

### Upgrade an existing installation

Copying a new version over an existing installation does not remove files that were deleted or renamed in the new release. Before upgrading, remove only the files managed by DANDORI, then copy the new release. Do not remove custom Workers or unrelated Skills.

User-level cleanup:

```bash
rm -f ~/.copilot/agents/{Orchestrator,Researcher,GitHubResearcher,PullRequestResearcher,Writer,CommandRunner,Reviewer,BrowserQA}.agent.md
rm -rf ~/.copilot/skills/code-review
```

Standard workspace cleanup:

```bash
rm -f .github/agents/{Orchestrator,Researcher,GitHubResearcher,PullRequestResearcher,Writer,CommandRunner,Reviewer,BrowserQA}.agent.md
rm -rf .github/skills/code-review
```

The legacy `PullRequestResearcher.agent.md` name is also removed during this rename migration so an obsolete Worker definition cannot remain discoverable.

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
5. Reply with only the exact approval token when the goal, approved capabilities, resource/effect boundaries, exclusions, and verification requirements are correct.
6. Review only differential changes if the approved contract later needs to widen.

## Definition validation

Run the deterministic validator before opening a pull request:

```bash
python -m pip install PyYAML==6.0.3
python scripts/validate_definitions.py
python scripts/run_tests.py
```

Create release archives from tracked files rather than zipping the working tree, then validate the actual artifact:

```bash
git archive --format=zip --output=dandori.zip HEAD
python scripts/validate_release_archive.py dandori.zip
```

The archive validator rejects path traversal, symlinks, generated artifacts, duplicate or portability-colliding names, unexpected top-level entries, missing release files, and extracted definitions that fail the repository validator. Portability checks include Unicode NFKC and case-folded collisions, Windows reserved device names, forbidden characters and control characters, and path components ending in a space or period.

GitHub Actions runs deterministic definition validation, mutation tests, and release-archive validation for every pull request and push to `master`. The repository permits only `.github/workflows/validate.yml`, only the `validate` job, and only the `pull_request` and `push` triggers; local Actions under `.github/actions` are forbidden. The checkout step discards persisted credentials, and the validation job has a 15-minute timeout. The validator structurally checks the unconditional job and its exact fail-closed validation steps; moving commands to another job, adding `if`, `needs`, `continue-on-error`, extra jobs or workflows, unapproved triggers, or path filters does not satisfy the contract. All step-level actions and reusable workflows are parsed from YAML and must use full-length commit SHAs. Python bytecode generation is disabled in CI, and the validator rejects tag- or branch-based action references, repository symlinks, missing Python ignore rules, and tracked generated artifacts. The validator treats the bundled definitions as a closed release inventory: only `*.agent.md` files are allowed in the agent directory; execution-bypass frontmatter such as `hooks`, `handoffs`, and `mcp-servers` is rejected, except for the agent-scoped `hooks` field on the fixed `CommandRunner.agent.md`; bundled-agent frontmatter, tools, filenames, required sections, safety-policy anchors, and conservative body-size regression floors are fixed; core Orchestrator invariants must remain in their intended sections; and the bundled `code-review` skill must contain only its declared Markdown files. DANDORI-specific coupling and Reviewer-owned worker policy are checked across every Skill Markdown file with case and separator variants normalized. Additional local workers may still be added as `*.agent.md` files, but they remain subject to the common runtime, no-subdelegation, forbidden-frontmatter, and DANDORI-coupling checks and produce a manual policy/Diagnostics review warning. External allowlisted workers also remain a Diagnostics-reviewed warning because their definitions are outside this repository. The dedicated test runner fails when no tests are discovered or when any test is skipped in CI. Required mutation and release-archive tests must retain their approved classes, methods, real mutations, failing-validator assertions, and non-empty shared helpers. Every conformance case must retain a non-empty Input and at least one concrete Expected bullet. LLM behavior is not inferred from static files; use the structured cases and run-record template in `tests/conformance.md` for model, Worker-tool, and VS Code release checks.

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
- **Verified progress permits continued refinement; repeated no-progress work stops.**

## Security boundary

DANDORI narrows delegated work and improves detection and stopping behavior, but it is not an operating-system sandbox. Tool restrictions, Workspace Trust, approval settings, diff review, and other platform controls remain important.

DANDORI does not claim that worker deviation is impossible. It narrows contracts, separates discovery from effects, audits reported actions, and stops when containment cannot be established.

## Non-goals

DANDORI is not:

- an unbounded autonomous coding agent acting without a human-approved capability envelope
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
