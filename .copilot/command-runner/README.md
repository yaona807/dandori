# User-level workspace command runner

[日本語](./README_ja.md)

This directory is the distribution source for the user-level `CommandRunner` agent, fixed Node.js runner, and agent-scoped `PreToolUse` hook.

The installed files live under `~/.copilot/`. No CommandRunner files or personal command allowlists need to be added to a project repository.

## Supported environments

Version 1 targets macOS, Linux, and WSL2. Native Windows support is not included yet.

The hook command and the fixed runner interface use `~/.copilot/...`, which must be expanded by a POSIX-compatible shell.

## Installation

Install this component in addition to the main DANDORI agents and skills:

```bash
mkdir -p ~/.copilot/agents ~/.copilot/command-runner
cp .copilot/command-runner/CommandRunner.agent.md ~/.copilot/agents/
cp .copilot/command-runner/command-runner.mjs ~/.copilot/command-runner/
cp .copilot/command-runner/command-runner-hook.mjs ~/.copilot/command-runner/
test -f ~/.copilot/command-runner/workspaces.json \
  || cp .copilot/command-runner/workspaces.example.json ~/.copilot/command-runner/workspaces.json
```

Edit `~/.copilot/command-runner/workspaces.json` and replace every example root with a canonical absolute workspace path. This personal file is not part of the DANDORI repository.

Set `chat.useCustomAgentHooks` to `true` in VS Code because agent-scoped hooks are a preview feature. Confirm in Chat Diagnostics that `CommandRunner` is loaded from `~/.copilot/agents/CommandRunner.agent.md`.

If `COPILOT_HOME` is set, only the configuration lookup changes: the runner reads `$COPILOT_HOME/command-runner/workspaces.json`. The installed Agent, runner, and hook paths remain under `~/.copilot/`.

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

## Runner interface

Run from the active workspace:

```bash
node ~/.copilot/command-runner/command-runner.mjs list
node ~/.copilot/command-runner/command-runner.mjs describe test
node ~/.copilot/command-runner/command-runner.mjs run test runInBand=true
```

Argument values use URI component encoding. Workspace path arguments are resolved under the selected root and rejected when they escape it.

A `run` result includes:

- selected workspace ID;
- command ID and normalized supplied arguments;
- configured workspace-relative `cwd`;
- exit code and signal;
- `timedOut`;
- `outputTruncated`;
- stdout and stderr.

## Security boundary

- Unknown workspaces and commands fail closed.
- The most specific matching registered root is selected.
- The agent cannot register or select a workspace.
- Terminal working-directory, environment, shell, profile, and background overrides are denied by the hook.
- Commands are started with `spawn(..., shell: false)`.
- The agent-scoped hook permits only the fixed runner interface and protects the user-level control files.

The hook is an additional guard, not an operating-system sandbox. A registered command can still execute project code and produce its own side effects. Review personal registrations and use Workspace Trust, normal approvals, and containers when stronger isolation is required.

VS Code hook timeouts are fail-open. The hook uses a 30-second timeout to reduce accidental bypass, but it must not be treated as the sole security boundary.

## Local checks

```bash
node --test .copilot/command-runner/command-runner.test.mjs
COPILOT_HOME=/path/to/test-home node .copilot/command-runner/command-runner.mjs list
```
