<p align="center">
  <img src="./assets/dandori-logo.png" alt="DANDORI logo" width="160">
</p>

<h1 align="center">DANDORI</h1>

<p align="center">
  <strong>Task Card-driven orchestration for the agents you already use.</strong>
</p>

<p align="center">
  Make AI agents spend tokens on approved work, not runaway work.
</p>

<p align="center">
  <a href="./README_ja.md">日本語</a>
</p>

DANDORI is an Orchestrator layer for GitHub Copilot Custom Agents.

It turns approved work into bounded Task Cards so your agents can execute narrowly, spend tokens intentionally, and remain easy to replace.

The core of DANDORI is the **Orchestrator**. The included workers are reference implementations. You can use them as-is, replace them with your own agents, or add specialized workers as your workflow grows.

> DANDORI is an independent open source project. It is not affiliated with, endorsed by, or maintained by GitHub or Microsoft.

## Why DANDORI?

AI coding agents are powerful, but vague work creates predictable failure modes:

- unnecessary repository scans
- repeated tool calls
- speculative edits
- broad investigations
- scope expansion during execution
- unclear delegation history

Token efficiency is not only about shorter prompts. In agentic workflows, wasted work becomes wasted tokens.

DANDORI reduces this waste by making the Orchestrator define the approved scope, create bounded Task Cards, delegate one card at a time, and review each result before continuing.

## Task Card-driven orchestration

DANDORI is built around a simple rule:

```text
No worker should act without a bounded Task Card.
```

A Task Card is a compact execution contract between the Orchestrator and a worker. It defines what the worker should do, what it should not do, what output is expected, when the task is done, and when the worker must stop and return to the Orchestrator.

In DANDORI, users approve the Task Flow Review. The Orchestrator then creates internal Task Cards from that approved scope.

The central invariant is:

```text
Internal Task Card ⊆ approved Task Flow Review step
```

No worker may expand the task based on preference, relevance, convenience, confidence, or broad best practices.

## Key features

- **Task Card-driven orchestration**: workers execute bounded Task Cards, not vague requests.
- **Token-efficient by design**: DANDORI is designed to reduce wasted tokens by reducing wasted agent work.
- **Orchestrator-first control**: planning, delegation, review, and synthesis stay in the Orchestrator.
- **Approved-scope execution**: workers act within the user-approved work scope.
- **Bring your own workers**: reuse existing agents or add specialized workers as needed.
- **Loosely coupled workers**: the Orchestrator depends on delegation contracts, not worker internals.
- **Review before continuation**: worker results are checked before the workflow proceeds.
- **Capable Orchestrator model recommended**: use a stronger reasoning model for the Orchestrator, while workers can be chosen per task.
- **Minimal runtime footprint**: the runtime is limited to agent definitions and the focused code-review skill.

## Bring your own workers

The Orchestrator is the core of DANDORI.

DANDORI keeps the Orchestrator decoupled from worker internals. The Orchestrator does not need to embed each worker's implementation details. It only depends on a simple delegation contract: a worker receives a bounded Task Card, executes within that scope, and returns the result.

You can use the included reference workers, replace them with your own agents, or add new specialized workers as your workflow grows.

This makes DANDORI easy to adopt incrementally: start with the Orchestrator, reuse the agents you already have, and add or swap workers without redesigning the orchestration layer.

## Model requirements

DANDORI works best with a capable reasoning model, especially for the Orchestrator.

The Orchestrator is responsible for planning, scope control, delegation, review, and synthesis. A weaker model may still handle simple tasks, but it is more likely to skip clarification, create vague Task Cards, over-delegate, or miss out-of-scope worker results.

Use the strongest model for the Orchestrator, not necessarily for every worker. Worker agents can often use smaller, faster, or more specialized models depending on the task.

## How it works

```text
User request
   ↓
Orchestrator
   ↓
Task Flow Review
   ↓
Bounded Task Cards
   ↓
Specialized Workers
   ↓
Orchestrator Review
   ↓
Final response
```

The Orchestrator owns the control plane. Workers own narrow execution.

## What's included

```text
.copilot/
  agents/
    orchestrator.agent.md
    researcher.agent.md
    pull-request-researcher.agent.md
    writer.agent.md
    reviewer.agent.md
    browser-qa.agent.md
  skills/
    code-review/
      SKILL.md
      references/
        correctness.md
        maintainability.md
        testability.md
        security.md
        performance.md
assets/
  dandori-logo.svg
  dandori-logo.png
```

| Component | Role |
| --- | --- |
| `Orchestrator` | Core control-plane agent. Plans, requests approval, creates Task Cards, delegates work, audits responses, and synthesizes the final answer. |
| Reference workers | Minimal workers for research, PR inspection, writing, review, and browser QA. |
| `code-review` skill | Focused review guidance used by the reviewer worker. |

The reference workers are optional starting points. You can replace them with your own agents as long as they follow bounded delegation from the Orchestrator.

## Installation

Copy the agents and skills into the discovery paths supported by your GitHub Copilot environment.

Example user-level installation:

```bash
mkdir -p ~/.copilot/agents ~/.copilot/skills
cp .copilot/agents/*.agent.md ~/.copilot/agents/
cp -R .copilot/skills/* ~/.copilot/skills/
```

Example workspace-level installation:

```bash
cp -R .copilot /path/to/your/repository/
```

Avoid keeping multiple active copies of the same agent definition in different locations. Duplicate definitions can make the Orchestrator audit one definition while Copilot invokes another.

## Usage

1. Open Copilot Chat.
2. Select the `Orchestrator` agent.
3. Give it a task.
4. Review the proposed Task Flow Review.
5. Approve only when the proposed flow, boundaries, and stop conditions are correct.

When approval is required, the Orchestrator asks for an exact approval line:

```text
承認:TFR-xxxx
```

Approval applies only to the displayed Task Flow Review. If you add conditions, corrections, or extra instructions, the message is treated as a change request, not approval.

## Design principles

- **Plan before execution**: the Orchestrator defines the work before workers act.
- **Task Cards over vague delegation**: workers receive explicit execution contracts.
- **Approved scope only**: workers operate within the approved work scope.
- **One bounded task at a time**: delegation stays narrow and auditable.
- **Review before continuing**: the Orchestrator checks worker output before moving forward.
- **Loose coupling**: the Orchestrator depends on delegation contracts, not worker internals.
- **Small replaceable workers**: workers are reference implementations, not the core value.

## Non-goals

DANDORI is not:

- a general-purpose autonomous coding agent
- a replacement for GitHub Copilot
- a replacement for human review
- a workflow engine with durable state
- a CI/CD runner
- an agent marketplace
- a prompt collection for making one agent do everything
- a framework that encourages workers to self-delegate or expand scope
- an official GitHub or Microsoft product

## License

MIT. See [LICENSE](./LICENSE).
