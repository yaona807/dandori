---
name: command-runner
description: "Safe fixed CommandRunner CLI guide for delegated command discovery, Git observations, registered tests, registration proposals, output recovery and error handling. Load before a Worker uses its terminal."
user-invocable: false
---

# CommandRunner operations

This is **method guidance, not execution permission**. Read this Skill at the start of any delegated fixed-runner task. The human grant, exact delegated action, effects, and host permission remain authoritative.

Use only the user-level CLI `node ~/.copilot/command-runner/command-runner-v2.mjs` through the delegated terminal tool, **never** a raw project shell command or the internal management interface. Terminal mode is synchronous (`mode: "sync"` if supported); omit the terminal timeout or use `0` only if the tool requires it. Do not override cwd, environment, profile or shell.

## Procedure

1. **Known exact command ID:** directly `inspect` its effective definition if this operation is delegated. Avoid needless `list`.
2. **Unknown ID:** use a delegated `list` with a bounded query and pagination; inspect exact candidates only when authorized. Filtered misses, stale revisions and incomplete pages do not prove absence. An npm script name (possibly containing `:`) is not necessarily a safe command ID.
3. **Before execution:** audit the actual workspace, command definition, arguments, script lifecycle hooks, and all effects. Terminal metadata calls require `observe+execute`. A `run` normally also writes runner-owned logs under `$COPILOT_HOME/command-runner/executions/`; those cache effects require `change_local` in the same approved capability, in addition to any intended source/test-output effects.
4. **Execution:** call `run` only for an exact permitted registered ID with validated named arguments. Capture `executionId`, `exitCode`, signal and timeout status. The returned stdout/stderr preview may be incomplete; use separately authorized `output` for bounded chunks as necessary.
5. **Missing registration:** `workspace.ensure` or `propose` requires delegated registration actions; `propose` creates only a proposal. `activate` is a separate host/human-approved registry mutation. Never use registration to evade a permission or lookup failure.

[All nine worker operations and builtin IDs](./references/commands.md) · [Troubleshooting and permission failures](./references/troubleshooting.md)

## Host integration

Runner terminal invocation is not permissionless, even for builtins. Never retry denied commands via shell aliases, disable Hook checks, issue `exit`/`exec`, or guess which tab belongs to the Worker. The current Hook requires synchronous foreground terminal calls; VS Code may retain tabs after they finish. Background auto-disposal is a separate harness-specific experiment and must not be enabled until output/exit code and owner-scoped cleanup are verified.
