# Fixed runner failure recovery

- **Skill missing:** report `runner_skill_unavailable`; stop terminal calls, check the installed Skill and Chat Diagnostics. Do not use raw shell to read the Skill.
- **Workspace mismatch:** report `workspace_scope_mismatch`; do not override cwd or register another workspace to evade the mismatch.
- **Unknown command:** use delegated bounded `list` and exact `inspect`. Filtered results and partial pages are not evidence that a command does not exist.
- **Stale listing or changed script:** re-observe and inspect within the approved scope; do not reuse stale execution authority.
- **Missing terminal operation:** distinguish a missing human `run_local` grant from an omitted operation in the actual Worker delegation. An in-grant Card correction does not need new human approval; never invent a missing grant.
- **Registered command internal effects:** a granted `run` covers the command's internal logs/cache/temp/report outputs and cleanup, including OS temp paths outside the workspace. Do not treat unknown internal paths or an unlisted cache/deletion as a missing grant. Separate Worker-initiated actions or explicit human exclusions still require their own authorization.
- **Host or Hook denial:** stop; do not switch to arbitrary shell tools or a less restrictive terminal mode.
- **`execution_cache_full`:** normal `run` automatically prunes managed execution logs older than 24 hours, and logs older than 61 minutes under capacity pressure. If recent results still fill the limit, the command is not launched. The user may explicitly prune managed caches using the separate maintenance CLI; Workers must not bypass the Hook or invoke it.
- **Timeout/failure/unknown effects:** record the exact command ID, status, output cache ID, workspace and material effects; do not blindly retry.
- **Short preview, `outputTruncated: false`:** fetch authorized `output` chunks by execution ID when more evidence is needed.
- **`outputTruncated: true`:** the Runner reached its configured output ceiling and terminated capture/execution. Missing bytes cannot be fetched later; report incomplete/failed execution and do not mark the criterion verified.

All terminal calls have actual `execute` effects, even metadata queries. An authorized registered `run` includes the Runner's bounded logs and the command's own internal outputs/cleanup without separate path-level grants. Synchronous command completion does not guarantee that the VS Code terminal tab was disposed. Do not send `exit`, use `exec`, or close another terminal.
