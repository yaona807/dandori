---
name: command-runner
description: "Safe fixed CommandRunner CLI guide for delegated command discovery, Git observations, registered tests, registration proposals, output recovery and error handling. Load before a Worker uses its terminal."
user-invocable: false
---

# CommandRunner operations

This is **method guidance, not execution permission**. Copilot declares Skill loading; Local must have a separately approved and Card-listed read of the installed Skill and any referenced guide before terminal use. Do not read outside that boundary. The human grant, exact delegated action, effects, and host permission remain authoritative.

Use only the user-level CLI `node ~/.copilot/command-runner/command-runner-v2.mjs` through the delegated terminal tool, **never** a raw project shell command or the internal management interface. Terminal mode is synchronous (`mode: "sync"` if supported); omit the terminal timeout or use `0` only if the tool requires it. Do not override cwd, environment, profile or shell.

## Procedure

1. **Known exact command ID:** directly `inspect` its effective definition if this operation is delegated. Avoid needless `list`.
2. **Unknown ID:** use a delegated `list` with a bounded query and pagination; inspect exact candidates only when authorized. Filtered misses, stale revisions and incomplete pages do not prove absence. An npm script name (possibly containing `:`) is not necessarily a safe command ID.
3. **Before execution:** audit the actual workspace, command definition, arguments, script lifecycle hooks, and all effects. Terminal metadata calls require `observe+execute`. A `run` reads shared execution-cache size metadata and writes new runner-owned logs under `$COPILOT_HOME/command-runner/executions/`. Grant this bounded observation and the current workspace's output-cache `change_local`, plus any intended source/test outputs. Normal `run` never deletes old caches: when the global limit is reached it fails closed with `execution_cache_full`, leaving owner-only cache maintenance separate. For a project-required registered local formatter with approved workspace-local write effects, do not predict every file it may format or add a per-file post-format audit. Preserve the required command, args, scope and order; explicit caps, external and destructive effects still constrain execution.
   Known check-owned outputs outside the workspace (including OS temp files) require a verified, bounded scope in the same approved grant and Card; the shared temp root is not blanket permission. Cleanup/deletion retains `destructive` when applicable; unknown paths or effects block the operation. Report an in-grant Card omission as a delegation gap, not missing human approval.
4. **Execution:** call `run` only for an exact permitted registered ID with validated named arguments. Capture `executionId`, `exitCode`, signal and timeout status. A shortened preview can be completed with separately authorized `output` chunks only if `outputTruncated` is false. If `outputTruncated: true`, the Runner stopped collecting beyond its output limit: lost bytes cannot be recovered by `output`. Treat the execution as incomplete/failed, record that limitation and do not claim verification.
5. **Missing registration:** `workspace.ensure` or `propose` requires delegated registration actions; `propose` creates only a proposal. `activate` is a separate host/human-approved registry mutation. Never use registration to evade a permission or lookup failure.

[All nine worker operations and builtin IDs](./references/commands.md) · [Troubleshooting and permission failures](./references/troubleshooting.md)

## Registered command argv allowlists (v3)

Configured project commands have two modes: **Fixed** without an `allow` field, or **Allowlist** with a non-empty array of rule strings. Legacy `arguments` definitions remain valid for existing commands, but cannot be mixed with non-empty `arguments` on an Allowlist command. Builtins retain their separate contracts.

Allowed rules are `--coverage` (flag), `--maxWorkers=value` (scalar), `--config=path` (existing workspace-contained path), and `--runTestsByPath path...` (one or more existing workspace-contained files). Only one `path...` group is supported; `--option=value` and `--option value` both work. Rule order is irrelevant. No bare positional files, unknown or repeated options. These strings describe permissions; they are not shell code.

Worker-facing `run` transports ordered argv as repeated percent-encoded `arg=` parameters. Example: `run test arg=--coverage arg=--runTestsByPath arg=tests%2Fa.test.js`. Encode special characters, whitespace and non-ASCII characters, including apostrophes and parentheses (`encodeURIComponent` alone leaves `!'()*` unescaped; percent-encode those characters as well). Never use terminal shell quotes or interpolation. Builtins/legacy commands still use their original named parameters.

To propose an allowlisted npm-family script, use `propose test allow=<percent-encoded-JSON-string-array>` with optional `script` and `packageDir`; omit `allow` for Fixed. Review each option's semantics and effects: `value` is not guaranteed to be a non-path. The inert proposal still requires separate human Host approval during `activate`. If interactive approval is unavailable, report the block to Orchestrator instead of bypassing the Hook.

## Host integration

Runner terminal invocation is not permissionless, even for builtins. Never retry denied commands via shell aliases, disable Hook checks, issue `exit`/`exec`, or guess which tab belongs to the Worker. The current Hook requires synchronous foreground terminal calls; VS Code may retain tabs after they finish. Background auto-disposal is a separate harness-specific experiment and must not be enabled until output/exit code and owner-scoped cleanup are verified.
