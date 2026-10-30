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
cp .copilot/command-runner/builtin-commands.mjs ~/.copilot/command-runner/
cp .copilot/command-runner/command-runner-interface.mjs ~/.copilot/command-runner/
cp .copilot/command-runner/command-runner-hook.mjs ~/.copilot/command-runner/
test -f ~/.copilot/command-runner/workspaces.json \
  || cp .copilot/command-runner/workspaces.example.json ~/.copilot/command-runner/workspaces.json
```

The copied configuration starts with an empty workspace registry. From the root directory that should become a workspace, register an explicit ID through `workspace-register <id>`. The runner derives and stores the canonical root from the actual current working directory, so no manual `workspaces.json` edit or root argument is required. This personal file is not part of the DANDORI repository.

Set `chat.useCustomAgentHooks` to `true` in VS Code because agent-scoped hooks are a preview feature. Confirm in Chat Diagnostics that `CommandRunner` is loaded from `~/.copilot/agents/CommandRunner.agent.md`.

If `COPILOT_HOME` is set, only the runner data/configuration lookup changes. The runner reads `$COPILOT_HOME/command-runner/workspaces.json` and stores execution output below `$COPILOT_HOME/command-runner/executions/`. The installed Agent, runner, and hook paths remain under `~/.copilot/`.

## Immutable built-in commands
After workspace registration, the following fixed commands are available without per-workspace registration:

- File operations: `builtin-fs-move`, `builtin-fs-copy`, `builtin-fs-trash`, `builtin-fs-restore`, `builtin-fs-trash-list`.
- Read-only Git: `builtin-git-status`, `builtin-git-diff`, `builtin-git-log`, `builtin-git-show`, `builtin-git-ls-files`, `builtin-git-branch-info`.

Availability never implies authority: every run still needs an exact delegated ID and approved effects. Built-in IDs are reserved and immutable.
Only regular files are moved/copied, without overwrites or symlink traversal. Trash uses the workspace-local `.agent-trash/` with an internal `.gitignore` containing `*`, and rejects already Git-tracked trash directories. Items can be restored by ID. No physical deletion command exists. Cross-filesystem moves fail.
Git reads require the repository root to match the selected workspace. `builtin-git-show` accepts a full 40-hex SHA only. Git staging, commits, branch changes and remote changes remain human-managed.
npm/pnpm/Yarn/Bun scripts and all project-owned commands continue to require individually human-approved allowlist registration. They are never inferred as executable from project scripts.

Example: `node ~/.copilot/command-runner/command-runner-interface.mjs run builtin-fs-trash --expected-workspace=example source=src%2Fold.ts`

## Workspace selection

At runtime the runner:

1. resolves the actual current working directory;
2. resolves every registered absolute workspace root;
3. selects the deepest registered root that contains the current directory;
4. exposes only that workspace's commands;
5. fails closed when no workspace matches.

The active directory may be the workspace root or any directory below it. The agent cannot provide a workspace ID, select another workspace, override the terminal working directory, change the environment or shell, or request background execution. Repository names and Git remotes are not authorization boundaries.

The runner's **terminal current working directory** is not necessarily the folder currently open in VS Code. If registration is requested for the editor-opened folder rather than explicitly for the terminal cwd, confirm those are the same target from authorized evidence before calling `workspace-register`. The runner cannot select the editor folder or override the terminal cwd; a successfully returned root alone does not establish that the intended folder was registered.

The same selection rule applies to command management. `register`, `update`, and `unregister` can mutate only the command map of the workspace selected from the real current directory; none accepts a workspace ID or root. Workspace management is separate: `workspace-register` registers only the actual current directory, while live workspace removal is allowed only for the workspace selected by that directory. A missing-root stale workspace may be removed by exact ID plus workspace-hash CAS so broken registrations remain recoverable.

An alias path for the current directory and its resolved real path may differ while identifying the same registered workspace. The runner determines that identity, not the caller. Workspace registration stores the canonical real directory; an alias does not authorize another workspace or bypass the checks that reject symlinks escaping a selected workspace.

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

A command's public `describe` representation is also bounded. It includes a `definitionHash` for compare-and-swap replacement or removal without exposing the fixed argv or other private configuration fields. A `describe` request fails closed when the public representation would be too large to return safely.

The separate read-only `inspect` operation provides the effective registered execution specification for exactly one authorized command: fixed `argv`, workspace-relative `cwd`, inherited timeout/output limits, and complete named-argument tokens/specifications. Unlike public `describe`, it reveals execution internals and must be separately permitted on the Worker Task Card. When the ID is already known, `inspect` requires no preceding `list` or preview. It does not execute, register, or update anything. Workspace selection is still checked against the delegated ID. The response is bounded to 10 KiB, and common embedded credential patterns are rejected with `inspection_sensitive` instead of being echoed. This detection is defense-in-depth, not a complete secret scanner; do not place credential literals in registered definitions. A failed/partial inspection cannot serve as a completed effects audit; fixed argv alone cannot prove all side effects. Execution remains bound to the current registered definition, not a frozen inspection snapshot.

## Runner interface

Run command operations from the active workspace. Workspace inspection/removal can also operate on stale registrations:

```bash
node ~/.copilot/command-runner/command-runner-interface.mjs workspace-list [query=<encoded-id-fragment>] [offset=<n>]
node ~/.copilot/command-runner/command-runner-interface.mjs workspace-describe <workspace-id>
node ~/.copilot/command-runner/command-runner-interface.mjs workspace-register <workspace-id>
node ~/.copilot/command-runner/command-runner-interface.mjs workspace-unregister <workspace-id> expected=<workspace-hash>
node ~/.copilot/command-runner/command-runner-interface.mjs list --expected-workspace=example [query=<encoded-search-text>] [offset=<n>] [revision=<sha256>]
node ~/.copilot/command-runner/command-runner-interface.mjs describe test --expected-workspace=example
node ~/.copilot/command-runner/command-runner-interface.mjs inspect test --expected-workspace=example
node ~/.copilot/command-runner/command-runner-interface.mjs register lint --expected-workspace=example definition=<encoded-json>
node ~/.copilot/command-runner/command-runner-interface.mjs update lint --expected-workspace=example expected=<definition-hash> definition=<encoded-json>
node ~/.copilot/command-runner/command-runner-interface.mjs unregister lint --expected-workspace=example expected=<definition-hash>
node ~/.copilot/command-runner/command-runner-interface.mjs run test --expected-workspace=example runInBand=true
node ~/.copilot/command-runner/command-runner-interface.mjs output <execution-id> --expected-workspace=example stream=stdout|stderr [offset=<n>]
```

Argument values use URI component encoding. Workspace path arguments are resolved under the selected root and rejected when they escape it. `register` and `update` accept one URI-component-encoded JSON command definition; the decoded definition is bounded to 16 KiB. `update` additionally requires the current `definitionHash`.

The agent and hook expose only `command-runner-interface.mjs`. Execution still delegates command schema validation and process execution to the fixed `command-runner.mjs` core. Management validates the complete candidate configuration through that same core before persisting it.

`list`, `describe`, command-definition registration/update/removal, `run`, and `output` require the delegated workspace ID as a `--expected-workspace` assertion. The fixed runner selects the workspace from the actual terminal cwd and compares it against that ID **before exposing scoped command data, modifying definitions, or launching a command**. On mismatch it returns `workspace_scope_mismatch`; the worker neither checks the terminal cwd nor tries to change it. `run` needs only the exact authorized command ID, workspace ID, and validated named arguments. It uses the currently registered definition as the execution source of truth, without Worker-supplied hashes. An update between discovery and execution can therefore change the executed semantics; registration management remains separately authorized and the Orchestrator must re-audit known changes. Older callers supplying both well-formed `--expected-identity` and `--expected-definition` assertions remain supported during migration, with their original strict checks. A missing exact command returned by `describe` includes the selected `workspaceId` in its structured error.

All interface responses are bounded below the terminal spill threshold. `list` includes a `revision` tied to the selected workspace and command catalog. Pass it with the same query when fetching subsequent pages; changed catalogs reject with `stale_listing` rather than implying absence. `list` returns only command IDs **for the selected terminal-cwd workspace**, at most 100 per call, with `total` and `nextOffset` when more matches remain. `query` performs a case-insensitive substring match against command IDs and descriptions; it only narrows discovery and never authorizes execution. **A filtered miss, an unfinished page, or a different selected workspace does not prove that a command is unregistered.** A successful exact-ID `describe` confirms presence for its returned `workspaceId`. A complete unfiltered list (or a verified exact-ID missing response) can establish absence **only in the verified selected workspace**; tool failures and unknown scope cannot. `describe` returns both the canonical `definitionHash` for management CAS and `executionHash` covering effective inherited timeout and output defaults for safe execution. Never register a replacement or invent an ID from a search miss.

### Command selection and missing registrations

`definitionHash` covers the full stored definition for management compare-and-swap, including its description. `executionHash` remains available for audit and legacy guarded execution, but is **not required to run a command**. The current command definition is validated before execution; legacy callers using explicit hashes retain stale-definition rejection. New Worker invocations do not copy or construct hashes.

When a delegated request authorizes several exact registered command IDs, the CommandRunner worker may select from those IDs and choose validated arguments and execution order. Registration and the current flow's execution authorization are separate: an ID merely being registered never grants execution permission. After a confirmed missing workspace or command registration, the worker reports the selected workspace/cwd evidence, exact lookup or complete unfiltered discovery result, and required registration facts. Partial or filtered misses remain unknown. The worker never registers automatically, widens authorization, or executes a follow-up command without a new delegation. The Orchestrator handles approval and subsequent Task Cards.

## Command management

Command definitions support required and optional arguments directly. Omitted `required` is optional; set `required: true` when omission must reject execution. For example:

```json
{
  "description": "Build one target.",
  "run": ["npm", "run", "build", "--"],
  "cwd": ".",
  "arguments": {
    "target": {
      "kind": "positional",
      "required": true,
      "value": { "type": "string", "maxLength": 80 }
    },
    "mode": {
      "kind": "option",
      "token": "--mode",
      "required": false,
      "value": { "type": "choice", "values": ["fast", "safe"] }
    }
  }
}
```

Argument kinds are `flag`, `option`, and `positional`. Non-flag arguments carry a validated `value` type: `boolean`, bounded `integer`, `choice`, bounded `string`, `workspace-file`, or `workspace-directory`. `option` requires a fixed option token; `positional` has no token. Repeatable non-flag arguments use `repeatable: true` with bounded `maxItems`.

`register` is create-only. It fails with `command_already_registered` when the ID already exists and never acts as an upsert. The supplied definition is strict-JSON parsed, inserted only into the currently selected workspace, then the entire candidate `workspaces.json` is validated by the fixed runner before persistence.

`update` replaces exactly one existing command definition and is not an upsert. It requires the current `definitionHash` returned by `describe`; a stale hash fails with `stale_definition`. The replacement is strict-JSON parsed, the whole candidate configuration is validated, and only then is it persisted atomically.

`unregister` requires the current `definitionHash` returned by `describe`. If the definition changed since it was observed, removal fails with `stale_definition`; this prevents an approval or request for one command definition from deleting a later replacement that reused the same ID. Empty command maps are valid, so the last command may be removed without deleting the workspace.

Management operations serialize through a user-level `workspaces.lock`. A candidate is written to a mode-`0600` temporary file in the same directory and atomically renamed over `workspaces.json` only after full validation and a final unchanged-source check. A live lock fails with `configuration_busy`. A lock older than five minutes is reported as `stale_configuration_lock` and must be removed manually rather than being broken automatically.

These management primitives do not decide whether a command should be registered, replaced, removed, or subsequently executed. They only apply an exact requested mutation while preserving configuration integrity.

### Recommended read-only Git recipes

Git does not receive special runtime privileges. When a workspace needs repository observation, register ordinary commands such as the following and authorize them like any other exact command ID.

`git-status` can expose a script-stable status view while suppressing optional index refresh and configured filesystem monitoring:

```json
{
  "description": "Inspect repository status without optional index refresh.",
  "run": [
    "git",
    "-c",
    "core.fsmonitor=false",
    "--no-pager",
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all",
    "--ignore-submodules=all"
  ],
  "cwd": ".",
  "arguments": {}
}
```

For file-scoped diffs, force literal pathspec handling, keep Git's external diff and text-conversion hooks disabled, and bind each path to the workspace. `mustExist: false` also permits an explicitly named deleted file while still rejecting paths that escape the workspace root:

```json
{
  "description": "Inspect unstaged changes for explicitly supplied workspace files.",
  "run": [
    "git",
    "-c",
    "core.fsmonitor=false",
    "--no-pager",
    "--no-optional-locks",
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "--"
  ],
  "cwd": ".",
  "arguments": {
    "paths": {
      "kind": "positional",
      "required": true,
      "repeatable": true,
      "maxItems": 20,
      "value": { "type": "workspace-file", "mustExist": false }
    }
  }
}
```

Use the same definition with `"--cached"` immediately after `"diff"` for a `git-diff-staged` command. These are recipes, not defaults: `workspace-register` still creates an empty command map and never injects Git commands automatically.

For project-wide validation, prefer one project-owned command such as `verify` that matches the repository's normal CI entry point. Register that exact command rather than adding a generic command-sequencing feature to the runner.

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
- Runtime workspace selection cannot be supplied by the agent; it always derives from the actual current directory.
- Explicitly delegated workspace registration/removal is available only through the fixed interface. Registration accepts no root argument, new overlapping roots are rejected, live removal is current-workspace-only, and stale removal requires exact ID plus workspace-hash CAS.
- Workspace registration is never a fallback for a missing command or unregistered runtime workspace.
- Command registration/removal is possible only through the fixed management operations for the current workspace; direct agent writes to `workspaces.json` remain denied by the hook.
- `register` does not overwrite an existing ID, and `unregister` is bound to the observed definition hash.
- Management candidates are validated as complete runner configurations before an atomic update.
- Terminal working-directory, environment, shell, profile, and background overrides are denied by the hook.
- Commands are started with `spawn(..., shell: false)`.
- On timeout or output-limit termination, the runner stops the command's POSIX process group, escalating from `SIGTERM` to `SIGKILL` after a fixed grace period so ordinary descendants do not outlive the bounded run. Deliberately detached descendants are outside this guarantee.
- The agent-scoped hook permits only the fixed runner interface and protects the user-level control files.
- The hook validates Local execution aliases (`execute` and `terminal/execute`), the observed VS Code/Copilot `run_in_terminal` alias, and legacy `execute/runInTerminal` with the same strict fixed-interface policy as Copilot harness terminal tool names such as `Bash`; unknown tools still fail closed. It emits permission decisions in both hook envelope formats. Static tests do not establish that a particular VS Code/Copilot installation invokes or enforces the hook; inspect actual tool names and verify both allowed and denied execution with `CONF-024` in [`tests/conformance.md`](../../tests/conformance.md). Existing installations must reinstall the updated hook and reload their agent session.
- `output` accepts only a valid execution ID and only resolves output under the current workspace's execution directory; arbitrary paths are not accepted.
- Execution output is untrusted data and does not grant authority for follow-up commands.

The hook is an additional guard, not an operating-system sandbox. A registered command can still execute project code and produce its own side effects. Review command definitions and use Workspace Trust, normal approvals, and containers when stronger isolation is required.

VS Code hook timeouts are fail-open. The hook uses a 30-second timeout to reduce accidental bypass, but it must not be treated as the sole security boundary.

## Local checks

```bash
node --test \
  .copilot/command-runner/command-runner.test.mjs \
  .copilot/command-runner/command-runner-interface.test.mjs
COPILOT_HOME=/path/to/test-home node .copilot/command-runner/command-runner-interface.mjs list --expected-workspace=example
```

## CommandRunner v2: self-onboarding and human-approved project commands

Use `node ~/.copilot/command-runner/command-runner-v2.mjs` for the Worker-facing API. It accepts `context`, `workspace.ensure`, `list`, `describe`, `inspect`, `propose <id> [packageDir=<relative>] [script=<name>]`, `activate <proposal-id>`, `run <id> [name=value]`, and `output <execution-id> stream=stdout|stderr [offset=<n>]`.

The worker does not send a workspace ID. The existing core selects the registered root from actual cwd and the v2 facade supplies internal workspace assertions. Hook requests first-time confirmation of the exact cwd root (already-registered roots are not prompted again). New roots are registered only when cwd is the exact directory containing `.git` or `package.json`; no parent-root inference. New command candidates are persisted but do not become executable until activation. A `PreToolUse` `ask` confirmation is requested for activation; user approval must be explicit. Unattended and untrusted hook environments do not provide a reliable human-approval attestation; **this is a prompt-level host permission, not a cryptographically enforced approval record**. The existing privileged v1 API is kept for migration and requests an interactive confirmation for registry mutations.

The generated argv is manager-sensitive: npm uses a terminal `--` separator, pnpm/Yarn/Bun do not. New npm/pnpm/Yarn/Bun registrations carry a `scriptGuard` fingerprint checked by the core before every execution, including through v1. All package scripts and declared package manager are hashed conservatively; this does not sandbox script contents or dependencies. Legacy entries without a guard remain supported. Do not auto-approve new candidates.
