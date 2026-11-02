# Fixed runner failure recovery

- **Skill missing:** report `runner_skill_unavailable`; stop terminal calls, check the installed Skill and Chat Diagnostics. Do not use raw shell to read the Skill.
- **Workspace mismatch:** report `workspace_scope_mismatch`; do not override cwd or register another workspace to evade the mismatch.
- **Unknown command:** use delegated bounded `list` and exact `inspect`. Filtered results and partial pages are not evidence that a command does not exist.
- **Stale listing or changed script:** re-observe and inspect within the approved scope; do not reuse stale execution authority.
- **Missing terminal operation:** distinguish a missing human `run_local` grant from an omitted operation in the actual Worker delegation. An in-grant Card correction does not need new human approval; never invent a missing grant.
- **Host or Hook denial:** stop; do not switch to arbitrary shell tools or a less restrictive terminal mode.
- **Timeout/failure/unknown effects:** record the exact command ID, status, output cache ID, workspace and material effects; do not blindly retry.
- **Short preview, `outputTruncated: false`:** fetch authorized `output` chunks by execution ID when more evidence is needed.
- **`outputTruncated: true`:** the Runner reached its configured output ceiling and terminated capture/execution. Missing bytes cannot be fetched later; report incomplete/failed execution and do not mark the criterion verified.

All terminal calls have actual `execute` effects, even metadata queries. `run` usually writes a bounded execution cache and tests may touch additional files; both must be explicitly covered. Synchronous command completion does not guarantee that the VS Code terminal tab was disposed. Do not send `exit`, use `exec`, or close another terminal.
