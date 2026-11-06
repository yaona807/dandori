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

### Built-in behavior at the point of use

`describe <exact-id>` exposes each built-in description and argument schema; `inspect <exact-id>` exposes its fixed execution specification. For known IDs, do not first `list` them. Neither read grants execution permission. Built-in file paths are relative to the Runner-selected workspace root, **not** the editor path, current OS trash, or an arbitrary absolute path. Resolve differing path spellings using already permitted workspace/file identity evidence; never assume an alias points to the same file, choose another workspace, or change the approved target.

| Built-in | Effect and recovery boundary |
| --- | --- |
| `builtin-fs-move` | Move/rename one ordinary file to an existing-parent workspace-relative destination; rejects overwrite, directories and symlinks. |
| `builtin-fs-copy` | Copy one ordinary file to an existing-parent workspace-relative destination; rejects overwrite, directories and symlinks. |
| `builtin-fs-trash` | Move one ordinary file to the **workspace-local** `.agent-trash/<itemId>/payload` (not the OS trash); returns `itemId`; no permanent deletion or overwrite. |
| `builtin-fs-restore` | Restore a trash `itemId` to its original file path, provided the parent still exists and the path is not occupied; no overwrite. |
| `builtin-fs-trash-list` | Read-only paginated inventory of restorable `itemId`, original path and creation time. |
| `builtin-git-status` | Read-only tracked/untracked status without index refresh; Git root must equal workspace root. |
| `builtin-git-diff` | Read-only staged/unstaged diff with optional file scope; Git root must equal workspace root. |
| `builtin-git-log` | Read-only bounded commit summaries; Git root must equal workspace root. |
| `builtin-git-show` | Read-only commit inspection by full SHA; Git root must equal workspace root. |
| `builtin-git-ls-files` | Read-only tracked-file enumeration with optional path scope; Git root must equal workspace root. |
| `builtin-git-branch-info` | Read-only current branch name; Git root must equal workspace root. |

The trash is excluded by its own `.agent-trash/.gitignore` and remains in the workspace; it is not an OS-managed recycle bin and is not auto-purged by these built-ins. File moves are same-filesystem only. Built-in availability does not grant approval for destructive effects, nor does restoring or listing trash grant authority to move another file.

The result of `run` includes `executionId`, `exitCode`, `signal`, `timedOut`, `outputTruncated` and bounded previews. Normal `run` only checks global cache size and never deletes old logs. The separate internal `cache-prune confirm=prune-managed-executions` operation is intentionally *not* a worker-facing v2 command; only the user may run it directly for explicit cache maintenance. Captured stdout/stderr bytes are stored under runner-owned execution cache and read via `output`. When `outputTruncated: true`, output exceeded the configured limit and missing bytes are irrecoverable; report incomplete/failed execution instead of claiming full logs or successful verification. Inspect a command's effective definition and possible writes (including package script lifecycle hooks) before execution; command names alone are not proof of safety.
