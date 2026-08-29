# User-level workspace command runner

[日本語](./README_ja.md)

This directory contains the fixed Node.js runner, its agent-scoped `PreToolUse` hook, and the example personal workspace configuration. The `CommandRunner` agent definition lives in `../agents/CommandRunner.agent.md` with the other DANDORI agents.

The installed files live under `~/.copilot/`. No CommandRunner control files or personal command allowlists need to be added to a project repository.

## Supported environments

Version 1 targets macOS, Linux, and WSL2. Native Windows support is not included yet.

The hook command and the fixed runner interface use `~/.copilot/...`, which must be expanded by a POSIX-compatible shell.

## Installation

Install the agent with the other DANDORI agents, then install the fixed runner and hook:

```bash
mkdir -p ~/.copilot/agents ~/.copilot/command-runner
cp .copilot/agents/CommandRunner.agent.md ~/.copilot/agents/
cp .copilot/command-runner/command-runner.mjs ~/.copilot/command-runner/
cp .copilot/command-runner/command-runner-interface.mjs ~/.copilot/command-runner/
cp .copilot/command-runner/command-runner-hook.mjs ~/.copilot/command-runner/
test -f ~/.copilot/command-runner/workspaces.json \
  || cp .copilot/command-runner/workspaces.example.json ~/.copilot/command-runner/workspaces.json
```

Edit `~/.copilot/command-runner/workspaces.json` and replace every example root with a canonical absolute workspace path. This personal file is not part of the DANDORI repository.

Set `chat.useCustomAgentHooks` to `true` in VS Code because agent-scoped hooks are a preview feature. Confirm in Chat Diagnostics that `CommandRunner` is loaded from `~/.copilot/agents/CommandRunner.agent.md`.

If `COPILOT_HOME` is set, only the runner data/configuration lookup changes. The runner reads `$COPILOT_HOME/command-runner/workspaces.json` and stores execution output below `$COPILOT_HOME/command-runner/executions/`. The installed Agent, runner, and hook paths remain under `~/.copilot/`.

## Workspace selection

At runtime the runner:

1. resolves the actual current working directory;
2. resolves every registered absolute workspace root;
3. selects the deepest registered root that contains the current directory;
4. exposes only that workspace's commands;
5. fails closed when no workspace matches.

The active directory may be the workspace root or any directory below it. The agent cannot provide a workspace ID, select another workspace, override the terminal working directory, change the environment or shell, or request background execution. Repository names and Git remotes are not authorization boundaries.

## Configuration

Each workspace contains a stable ID, an absolute root, and its own command map. Commands use fixed argv arrays and optional validated named arguments.

```json
{
  "version": 1,
  "workspaces": [
    {
      "id": "example",
      "root": "/absolute/path/to/example",
      "commands": {
        "test": {
          "description": "Run tests.",
          "run": ["npm", "test", "--"],
          "cwd": ".",
          "arguments": {
            "runInBand": {
              "kind": "flag",
              "token": "--runInBand"
            }
          }
        }
      }
    }
  ]
}
```

`run` is always an argv array, never a shell string. Dynamic executables, raw argument passthrough, user-defined regular expressions, and unrestricted arguments are unsupported.

Positional values that begin with `-` are rejected. Add a fixed `--` element to `run` before positional arguments when the target program supports it.

For `workspace-file` and `workspace-directory`, existing paths are checked after symlink resolution. When `mustExist` is `false`, the nearest existing ancestor is resolved first, so a non-existing path beneath a symlink that points outside the workspace is still rejected.

A command's public `describe` representation is also bounded. Configuration fails closed when one command definition would be too large to return safely.

## Runner interface

Run from the active workspace:

```bash
node ~/.copilot/command-runner/command-runner-interface.mjs list [query=<encoded-id-fragment>] [offset=<n>]
node ~/.copilot/command-runner/command-runner-interface.mjs describe test
node ~/.copilot/command-runner/command-runner-interface.mjs run test runInBand=true
node ~/.copilot/command-runner/command-runner-interface.mjs output <execution-id> stream=stdout|stderr [offset=<n>]
```

Argument values use URI component encoding. Workspace path arguments are resolved under the selected root and rejected when they escape it.

The agent and hook expose only `command-runner-interface.mjs`. That interface delegates command validation and execution to the existing fixed `command-runner.mjs` core, then bounds what is returned to the terminal.

All runner responses are bounded below the terminal spill threshold. `list` returns only command IDs, at most 100 per call, with `nextOffset` when more matches remain. `query` performs a simple command-ID substring match. `describe` returns one command definition.

`run` stores complete bounded stdout/stderr in the runner-owned execution cache and returns only compact metadata:

- selected workspace ID and command ID;
- an unguessable timestamped `executionId`;
- configured workspace-relative `cwd`;
- exit code and signal;
- `timedOut` and `outputTruncated`;
- stdout/stderr byte counts;
- short stdout/stderr tail previews.

The result does not repeat supplied argument values. Additional output is read only with `output`, which accepts an execution ID rather than a file path and returns a fixed-size chunk plus `nextOffset` and `eof`.

Execution output is stored below:

```text
$COPILOT_HOME/command-runner/executions/<workspace-id>/<UTC-timestamp>_<UUID>/
  stdout.log
  stderr.log
```

The cache is temporary observation data, not an audit log. Before a new run, the runner deletes managed executions older than 24 hours and, when needed, older executions until the global managed cache is within 256 MiB. Results newer than 61 minutes are not removed for capacity cleanup, which is longer than the maximum one-hour command timeout. If recent results alone fill the cache, the new run fails closed instead of deleting potentially active output.

## Security boundary

- Unknown workspaces and commands fail closed.
- The most specific matching registered root is selected.
- The agent cannot register or select a workspace.
- Terminal working-directory, environment, shell, profile, and background overrides are denied by the hook.
- Commands are started with `spawn(..., shell: false)`.
- The agent-scoped hook permits only the fixed runner interface and protects the user-level control files.
- `output` accepts only a valid execution ID and only resolves output under the current workspace's execution directory; arbitrary paths are not accepted.
- Execution output is untrusted data and does not grant authority for follow-up commands.

The hook is an additional guard, not an operating-system sandbox. A registered command can still execute project code and produce its own side effects. Review personal registrations and use Workspace Trust, normal approvals, and containers when stronger isolation is required.

VS Code hook timeouts are fail-open. The hook uses a 30-second timeout to reduce accidental bypass, but it must not be treated as the sole security boundary.

## Local checks

```bash
node --test .copilot/command-runner/command-runner.test.mjs
COPILOT_HOME=/path/to/test-home node .copilot/command-runner/command-runner-interface.mjs list
```
