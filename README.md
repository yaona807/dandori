# DANDORI

Bounded adaptive orchestration for the GitHub Copilot harness (including Copilot sessions in VS Code). Local/`target: vscode` harness profiles are no longer supported.

**Human approves a goal and capabilities once; Executor completes in-scope work; Reviewer independently verifies results.**

## Agents

| Role | Responsibilities |
| --- | --- |
| Orchestrator | TFR/TFC human approval, approved Contract, task delegation, conflict handling, result verification |
| Executor | Investigation, design, code changes, registered tests, in-scope fixes, shared-tab UI and approved GitHub actions |
| Reviewer | Independent code/PR review, optionally registered source-preserving tests; never edits or remote writes |

A single Executor handles one cohesive task from investigation through repair. Independent research can use multiple Executor instances; overlapping or unknown writes must be serialized.

## Contract and delegation

TFR presents the goal, completion conditions, bounded operations, resource boundaries, explicit exclusions and verification. A granted registered command `run` is one operation and includes its internal effects. Exact approval token only; an attached file is data, not authority. TFC covers only newly needed capability, effect or scope. The append-only normalized patch/fold remains the single approval authority; Contract revision binds dispatched work and returned results.

Each delegated task contains an objective, boundary, a narrowed subset of approved capabilities, relevant evidence and expected outcomes. In-scope files discovered by Executor do not require another Card/TFC. Unknown internal effects of an approved registered command do not trigger reapproval; separately initiated work, remote writes and destructive actions are not implied by that command grant.

The contract is a model-side work boundary, not a sandbox for every editor tool. Preserve Host approvals and the fixed CommandRunner/Hook implementation. Every GitHub write needs its own explicit scoped human grant and a per-call Host approval.

Reviewer has read/search and fixed CommandRunner terminal access only for registered commands that do not intentionally change source or baselines. Internal test logs, caches and temporary cleanup are included in the approved run rather than separately authorized. Independent review after material changes does not require running every successful self-check again.

## Optional Copilot Memory reflection

Orchestrator preloads the short `task-reflection` Skill through its `skills` frontmatter. Before preparing a new TFR it consults relevant existing lessons when useful; while executing, it can store distinct verified actionable lessons without a per-task count limit as soon as the evidence is reliable, without a mandatory final-audit pass. Normal tasks need no memory call or full history scan. The user has granted standing opt-in for non-sensitive Copilot Memory maintenance: DANDORI's agent-scoped Hook allows the exact `store_memory` and `vote_memory` tools without per-call approval or a new TFR/TFC. Other Host/organization policies may still restrict them. Memory never grants task permissions or replaces project instructions, code or tests. No new Stop Hook, worker or cross-session transcript storage is added.

Executor and Reviewer selectively use `read_memories` for relevant lessons; neither can store or vote. They may include verified `memory_suggestions` and evidence-backed `memory_feedback` in ordinary results. Orchestrator applies existing quality, duplication, and authority rules before saving or evaluating proposals. A review finding alone is not verified knowledge. Optional memory work adds no new agents, mandatory Task Card fields or persistence, and must not block the task. The Worker Hook permits only exact memory reads.

## Installation

1. Follow the existing [CommandRunner installation guide](.copilot/skills/command-runner/references/README.md) and enable Copilot custom-agent hooks.
2. Install profiles from packages/copilot/agents and Skills from packages/copilot/skills.
3. Delete previously installed Researcher.agent.md, Writer.agent.md, and any obsolete `target: vscode` profiles; verify Orchestrator, Executor, Reviewer use `target: github-copilot`.
4. Confirm GitHub Host approval and parent-tool direct invocation guard work. The parent temporarily exposes worker tools for the Copilot subagent-tool visibility workaround; its Hook rejects direct use. Both `.copilot/agents` and `packages/copilot/agents` contain identical Copilot-native profiles with no Local-harness conversion.

## Validation

~~~sh
python scripts/build_agent_profiles.py --check
python scripts/validate_definitions.py
python scripts/run_tests.py
git archive --format=zip --output=dandori-release.zip HEAD
python scripts/validate_release_archive.py dandori-release.zip
~~~

See [manual runtime cases](tests/conformance.md); static CI cannot prove Copilot model behavior. Historical design decisions are under docs/. DANDORI is session-bounded, not a durable workflow engine.
