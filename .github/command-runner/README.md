# Workspace command runner

This directory contains the fixed Node.js runner and `PreToolUse` hook used by the workspace `CommandRunner` agent.

## Configuration

Register commands in `.github/command-runner.json`. Each command has a stable ID, a description, a fixed `run` array, a workspace-relative `cwd`, and optional named arguments.

```json
{
  "version": 1,
  "commands": {
    "test": {
      "description": "Run tests.",
      "run": ["npm", "test", "--"],
      "cwd": ".",
      "arguments": {
        "runInBand": {
          "kind": "flag",
          "token": "--runInBand"
        },
        "maxWorkers": {
          "kind": "option",
          "token": "--maxWorkers",
          "value": {
            "type": "integer",
            "min": 1,
            "max": 8
          }
        },
        "file": {
          "kind": "positional",
          "value": {
            "type": "workspace-file",
            "extensions": [".test.js", ".test.ts"],
            "mustExist": true
          }
        }
      }
    }
  }
}
```

`run` is always an argv array, never a shell string. Dynamic executables, raw argument passthrough, user-defined regular expressions, and unrestricted arguments are not supported.

## Runner interface

Run the commands from the workspace root:

```bash
node .github/command-runner/command-runner.mjs list
node .github/command-runner/command-runner.mjs describe test
node .github/command-runner/command-runner.mjs run test runInBand=true maxWorkers=4 file=tests%2Fexample.test.ts
```

Argument values use URI component encoding. The runner validates the configuration and arguments, builds argv deterministically, and starts the registered executable with Node.js `spawn` and `shell: false`.

## Supported argument definitions

Kinds:

- `flag`: adds a fixed token when the supplied value is `true`
- `option`: adds a fixed token followed by one validated value
- `positional`: adds one validated value

Value types:

- `boolean`
- `integer` with required `min` and `max`
- `choice` with explicit `values`
- `string` with required `maxLength`
- `workspace-file`
- `workspace-directory`

A repeated argument requires both `repeatable: true` and a finite `maxItems`.

Workspace path values are resolved from the workspace root. Existing paths are checked after symlink resolution and must remain inside the workspace.

## Hook behavior

`.github/hooks/command-runner.json` installs a workspace `PreToolUse` hook. For known terminal tool names, the hook allows only the three canonical runner command shapes and denies raw project commands or shell syntax. Agent write tools are also denied when they target the active command-runner configuration, agent, hook, or runner files.

The hook is an additional guard, not an operating-system sandbox. A registered command can still execute project code and produce its own side effects. Review registered commands, use Workspace Trust and normal approval controls, and use a container or sandbox when stronger isolation is needed.

Confirm in VS Code Chat Diagnostics that the workspace agent and hook are loaded from the intended files. Hook support is a preview capability and may be disabled by organization policy.

## Local checks

```bash
node --test .github/command-runner/command-runner.test.mjs
node .github/command-runner/command-runner.mjs list
```
