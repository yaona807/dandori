# User-level workspace command runner

[日本語](./README_ja.md)

This directory contains the fixed Node.js runner, its bounded management/execution interface, its agent-scoped `PreToolUse` hook, and the example personal workspace configuration. The `CommandRunner` agent definition lives in `../agents/CommandRunner.agent.md` with the other DANDORI agents.

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

Edit `~/.copilot/command-runner/workspaces.json` and replace every example root with a canonical absolute workspace path. This personal file is not part of the DANDORI repository. After a workspace exists, its command map can be maintained manually or through the fixed `register` / `unregister` interface described below.

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

The same selection rule applies to command management. `register` and `unregister` can mutate only the command map of the workspace selected from the real current directory; neither operation accepts a workspace ID or root.

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

A command's public `describe` representation is also bounded. It includes a `definitionHash` for compare-and-swap removal without exposing the fixed argv or other private configuration fields. A `describe` request fails closed when the public representation would be too large to return safely.

## Runner interface

Run from the active workspace:

```bash
node ~/.copilot/command-runner/command-runner-interface.mjs list [query=<encoded-id-fragment>] [offset=<n>]
node ~/.copilot/command-runner/command-runner-interface.mjs describe test
node ~/.copilot/command-runner/command-runner-interface.mjs register lint definition=<encoded-json>
node ~/.copilot/command-runner/command-runner-interface.mjs unregister lint expected=<definition-hash>
node ~/.copilot/command-runner/command-runner-interface.mjs run test runInBand=true
node ~/.copilot/command-runner/command-runner-interface.mjs output <execution-id> stream=stdout|stderr [offset=<n>]
```

Argument values use URI component encoding. Workspace path arguments are resolved under the selected root and rejected when they escape it. `register` accepts one URI-component-encoded JSON command definition; the decoded definition is bounded to 16 KiB.

The agent and hook expose only `command-runner-interface.mjs`. Execution still delegates command schema validation and process execution to the fixed `command-runner.mjs` core. Management validates the complete candidate configuration through that same core before persisting it.

All interface responses are bounded below the terminal spill threshold. `list` returns only command IDs, at most 100 per call, with `nextOffset` when more matches remain. `query` performs a simple command-ID substring match. `describe` returns one public command definition plus its stable canonical SHA-256 `definitionHash`.

### Command management

`register` is create-only. It fails with `command_already_registered` when the ID already exists and never acts as an upsert. The supplied definition is strict-JSON parsed, inserted only into the currently selected workspace, then the entire candidate `workspaces.json` is validated by the fixed runner before persistence.

`unregister` requires the current `definitionHash` returned by `describe`. If the definition changed since it was observed, removal fails with `stale_definition`; this prevents an approval or request for one command definition from deleting a later replacement that reused the same ID. Version 1 retains the existing non-empty command-map invariant, so the last command in a registered workspace cannot be removed.

Management operations serialize through a user-level `workspaces.lock`. A candidate is written to a mode-`0600` temporary file in the same directory and atomically renamed over `workspaces.json` only after full validation and a final unchanged-source check. A live lock fails with `configuration_busy`. A lock older than five minutes is reported as `stale_configuration_lock` and must be removed manually rather than being broken automatically.

These management primitives do not decide whether a command should be registered, removed, or subsequently executed. They only apply an exact requested mutation while preserving configuration integrity.

### Execution output

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
- Command registration/removal is possible only through the fixed management operations for the current workspace; direct agent writes to `workspaces.json` remain denied by the hook.
- `register` does not overwrite an existing ID, and `unregister` is bound to the observed definition hash.
- Management candidates are validated as complete runner configurations before an atomic update.
- Terminal working-directory, environment, shell, profile, and background overrides are denied by the hook.
- Commands are started with `spawn(..., shell: false)`.
- On timeout or output-limit termination, the runner stops the command's POSIX process group, escalating from `SIGTERM` to `SIGKILL` after a fixed grace period so ordinary descendants do not outlive the bounded run. Deliberately detached descendants are outside this guarantee.
- The agent-scoped hook permits only the fixed runner interface and protects the user-level control files.
- `output` accepts only a valid execution ID and only resolves output under the current workspace's execution directory; arbitrary paths are not accepted.
- Execution output is untrusted data and does not grant authority for follow-up commands.

The hook is an additional guard, not an operating-system sandbox. A registered command can still execute project code and produce its own side effects. Review command definitions and use Workspace Trust, normal approvals, and containers when stronger isolation is required.

VS Code hook timeouts are fail-open. The hook uses a 30-second timeout to reduce accidental bypass, but it must not be treated as the sole security boundary.

## Local checks

```bash
node --test \
  .copilot/command-runner/command-runner.test.mjs \
  .copilot/command-runner/command-runner-interface.test.mjs
COPILOT_HOME=/path/to/test-home node .copilot/command-runner/command-runner-interface.mjs list
```
