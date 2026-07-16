# Manual conformance check

Run these scenarios when changing the Orchestrator prompt, the selected model, VS Code, or the subagent feature. Record the tested versions and pass/fail result in the pull request or release notes.

- An ambiguous request is clarified before delegation.
- A Task Flow Review displays the subject or boundary, action, and all effects together as an authorized operation.
- Approval is rejected when the approval token contains extra prose, conditions, punctuation, quotes, or a code fence.
- A Worker-reported candidate is not treated as authorized until Orchestrator promotion checks succeed.
- A subject discovered in one invocation is not affected in that same invocation.
- A pure narrowing is recorded without a TFC.
- A mixed revision displays every addition, removal, and changed limit in the contract patch.
- A materially different goal supersedes the current flow and starts a new TFR.
- A stale-revision result can provide evidence but cannot authorize work or complete a current criterion.
- Worker routing does not depend on reading a Worker definition file.
- An incompatible Worker triggers at most one fallback candidate.
- No compatible Worker produces `no_suitable_worker` without widening the contract.
- Missing audit-critical information is requested at most once.
- External Worker sources and tool availability are checked with VS Code Chat Diagnostics.
