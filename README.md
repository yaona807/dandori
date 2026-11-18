# DANDORI

Bounded adaptive orchestration for GitHub Copilot Custom Agents in VS Code.

**Human approves a goal and capabilities once; Executor completes in-scope work; Reviewer independently verifies results.**

## Agents

| Role | Responsibilities |
| --- | --- |
| Orchestrator | TFR/TFC human approval, approved Contract, task delegation, conflict handling, result verification |
| Executor | Investigation, design, code changes, registered tests, in-scope fixes, shared-tab UI and approved GitHub actions |
| Reviewer | Independent code/PR review, optionally registered source-preserving tests; never edits or remote writes |

A single Executor handles one cohesive task from investigation through repair. Independent research can use multiple Executor instances; overlapping or unknown writes must be serialized.

## Contract and delegation

TFR presents the goal, completion conditions, bounded actions, resource boundaries, all cumulative effects, exclusions and verification. Exact approval token only; an attached file is data, not authority. TFC covers only newly needed capability, effect or scope. The append-only normalized patch/fold remains the single approval authority; Contract revision binds dispatched work and returned results.

Each delegated task contains an objective, boundary, a narrowed subset of approved capabilities, relevant evidence and expected outcomes. In-scope files discovered by Executor do not require another Card/TFC. Unrelated work, unknown effects, remote writes and destructive actions are not implied by local permissions.

The contract is a model-side work boundary, not a sandbox for every editor tool. Preserve Host approvals and the fixed CommandRunner/Hook implementation. Every GitHub write needs its own explicit scoped human grant and a per-call Host approval.

Reviewer has read/search and fixed CommandRunner terminal access only for registered commands that do not intentionally change source or baselines. Normal bounded test logs/caches must be approved. Independent review after material changes does not require running every successful self-check again.

## Installation

1. Follow the existing [CommandRunner installation guide](.copilot/skills/command-runner/references/README.md) and enable Copilot custom-agent hooks.
2. Install profiles from packages/copilot/agents and Skills from packages/copilot/skills.
3. Delete previously installed Researcher.agent.md and Writer.agent.md, and verify Orchestrator, Executor, Reviewer are available.
4. Confirm GitHub Host approval and parent-tool direct invocation guard work. The parent temporarily exposes worker tools for the Copilot subagent-tool visibility workaround; its Hook rejects direct use.

## Validation

~~~sh
python scripts/build_agent_profiles.py --check
python scripts/validate_definitions.py
python scripts/run_tests.py
git archive --format=zip --output=dandori-release.zip HEAD
python scripts/validate_release_archive.py dandori-release.zip
~~~

See [manual runtime cases](tests/conformance.md); static CI cannot prove Copilot model behavior. Historical design decisions are under docs/. DANDORI is session-bounded, not a durable workflow engine.
