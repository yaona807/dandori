# Fixed runner v2 operation reference

Every example suffix must be preceded by the **exact** installed CLI prefix:
`node ~/.copilot/command-runner/command-runner-v2.mjs`

| Operation | Example suffix | Required consideration |
| --- | --- | --- |
| `context` | `context` | Runtime-selected workspace metadata |
| `workspace.ensure` | `workspace.ensure` | May register the current workspace; separate permission for config write |
| `list` | `list query=git offset=0` | Filtered registered IDs; follow `revision` and `nextOffset` for pages |
| `describe` | `describe builtin-git-status` | Public definition; not equivalent to exact `inspect` |
| `inspect` | `inspect builtin-git-status` | Effective fixed argv, cwd and schema for exact ID |
| `propose` | `propose test-ci script=test%3Aci packageDir=.` | Inert proposal for existing package script |
| `activate` | `activate prop-<32-hex-digits>` | Registry mutation needing exact separate human/host approval |
| `run` | `run builtin-git-status` | Exact registered ID, separately granted run and effects, output cache |
| `output` | `output <execution-id> stream=stdout offset=0` | Bounded output chunks for an authorized execution |

Parameters use `key=URL-encoded-value` (no quotes, shell interpolation or unbounded arguments). The v2 facade determines the actual terminal working directory and internally checks `--expected-workspace`; never try to select a different workspace.

Registration-free **Git observation** builtins (execution still needs an exact grant): `builtin-git-status`, `builtin-git-diff` (optional `scope=unstaged|staged` and `file=...`), `builtin-git-log` (`count=...`), `builtin-git-show` (`commit=<full-SHA>`), `builtin-git-ls-files`, `builtin-git-branch-info`.

Registration-free filesystem operations: `builtin-fs-move`, `builtin-fs-copy`, `builtin-fs-trash`, `builtin-fs-restore`, `builtin-fs-trash-list`. These have different change/destructive effects and are never permitted by a Git observation grant.

The result of `run` includes `executionId`, `exitCode`, `signal`, `timedOut`, `outputTruncated` and bounded previews. Normal `run` only checks global cache size and never deletes old logs. The separate internal `cache-prune confirm=prune-managed-executions` operation is intentionally *not* a worker-facing v2 command; only the user may run it directly for explicit cache maintenance. Captured stdout/stderr bytes are stored under runner-owned execution cache and read via `output`. When `outputTruncated: true`, output exceeded the configured limit and missing bytes are irrecoverable; report incomplete/failed execution instead of claiming full logs or successful verification. Inspect a command's effective definition and possible writes (including package script lifecycle hooks) before execution; command names alone are not proof of safety.
