#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { githubMcpDecision } from './github-mcp-approval.mjs';

const TERMINAL_TOOL_NAMES = new Set([
  'execute/runInTerminal',
  'execute',
  'terminal/execute',
  'run_in_terminal',
  'runInTerminal',
  'runTerminalCommand',
  'Bash',
  'bash',
  'powershell',
  'shell',
]);
// Local/Copilot terminal aliases, including the host's run_in_terminal name,
// must pass the same fixed-runner validation. Never default-allow unknown tools.
// Explicit non-terminal capabilities exposed to Researcher and Writer.
// Unknown tools remain denied; the agent frontmatter is the capability boundary.
const PERMITTED_NON_TERMINAL_TOOL_NAMES = new Set([
  'read', 'search', 'web', 'edit', 'Read', 'Edit', 'view',
  // Native Copilot code search and compatible PascalCase search aliases.
  'glob', 'Glob', 'grep', 'rg', 'Grep',
  // Native edit tools; the host still enforces the Writer's granted scope.
  'apply_patch', 'str_replace_editor',
  'search/codebase', 'search/usages', 'search/fileSearch', 'search/textSearch',
  'search/listDirectory', 'read/readFile', 'read/problems', 'web/fetch',
  'edit/editFiles', 'edit/createFile', 'edit/createDirectory',
  // Native Copilot Web and file-creation tools; Host permission checks still apply.
  'create', 'Write', 'web_search', 'WebSearch', 'web_fetch', 'WebFetch',
  // User-shared browser-tab interactions; never enable direct URL navigation.
  // This tool-name allowlist cannot prove tab identity or approve external effects.
  'browser/readPage',
  'browser/screenshotPage',
  'browser/clickElement',
  'browser/hoverElement',
  'browser/dragElement',
  'browser/typeInPage',
  'browser/handleDialog',
]);
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXECUTION_ID_PATTERN = /^\d{8}T\d{6}\.\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARAMETER_TOKEN_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}=[A-Za-z0-9._~%/-]*$/;
const FIXED_PREFIX = ['node', '~/.copilot/skills/command-runner/scripts/gateway.mjs'];
const CLI_PREFIX = ['node', '~/.copilot/skills/command-runner/scripts/cli.mjs'];
const PROPOSAL_ID = /^prop-[a-f0-9]{32}$/u;
const FORBIDDEN_CHARACTER_PATTERN = /[\u0000-\u001f\u007f'"`$&|;<>()[\]{}\\]/u;
const MAX_COMMAND_LENGTH = 65_536;
const PROTECTED_SUFFIXES = new Set([
  '.copilot/agents/CommandRunner.agent.md', // protect legacy installed control definition
  '.copilot/agents/Researcher.agent.md',
  '.copilot/agents/Writer.agent.md',
  '.copilot/skills/command-runner/SKILL.md',
  '.copilot/skills/command-runner/scripts/hook.mjs',
  '.copilot/skills/command-runner/scripts/runner.mjs',
  '.copilot/skills/command-runner/scripts/gateway.mjs',
  '.copilot/skills/command-runner/scripts/cli.mjs',
  '.copilot/skills/command-runner/scripts/script-guard.mjs',
  '.copilot/skills/command-runner/scripts/builtins.mjs',
  '.copilot/command-runner/workspaces.json',
]);
const WRITE_TOOL_NAME_PATTERN = /(?:^|[/._-])(?:edit|write|create|delete|remove|move|rename|patch)(?:$|[/._-])/iu;
const EXECUTION_OVERRIDE_KEY_PATTERN = /^(?:cwd|workingDirectory|working_directory|env|environment|shell|executable|profile|terminal|options|requestUnsandboxedExecution|requestAllowNetwork)$/iu;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function allow(reason) {
  output({
    permissionDecision: 'allow',
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  });
}

function activationReview(id) {
  const home = process.env.COPILOT_HOME ? path.resolve(process.env.COPILOT_HOME) : path.join(os.homedir(), '.copilot');
  const file = path.join(home, 'command-runner', 'proposals', id + '.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('unreadable approval proposal');
  const item = JSON.parse(readFileSync(file, 'utf8'));
  const fixed = item.version === 3 && item.kind === 'fixed'
    && item.definition?.scriptGuard === undefined && item.scriptPreview === null;
  const packageScript = [1, 2].includes(item.version) && !!item.definition?.scriptGuard;
  const commandUpdate = item.version === 4 && item.kind === 'update'
    && item.patch && typeof item.patch === 'object' && !Array.isArray(item.patch)
    && item.previous && typeof item.previous === 'object' && !Array.isArray(item.previous)
    && /^sha256-[0-9a-f]{64}$/u.test(item.expectedHash);
  if (item.id !== id || !item.definition || !Array.isArray(item.definition.run)
    || typeof (item.definition.cwd ?? '.') !== 'string' || (!fixed && !packageScript && !commandUpdate)
    || typeof item.definition.description !== 'string'
    || !Number.isFinite(item.expiresAt) || Date.now() > item.expiresAt) {
    throw new Error('invalid or expired approval proposal');
  }
  if (commandUpdate) {
    // Do not disclose unrelated registered argv/legacy arguments during a
    // metadata-only edit; show the exact execution details for execution changes.
    const executableChanged = ['run', 'cwd', 'script', 'packageDir']
      .some(key => Object.hasOwn(item.patch, key));
    const summary = JSON.stringify({
      action: 'update_command', commandId: item.commandId,
      workspaceIdentity: item.workspaceIdentity, previous: item.previous,
      changes: item.patch, effectiveDefinition: {
        description: item.definition.description,
        ...(executableChanged ? {
          argv: item.definition.run, cwd: item.definition.cwd ?? '.',
          arguments: item.definition.arguments ?? {},
          scriptGuard: item.definition.scriptGuard ?? null,
        } : {}),
        ...(executableChanged || Object.hasOwn(item.patch, 'allow')
          ? {allow: item.definition.allow ?? null} : {}),
        ...(executableChanged || Object.hasOwn(item.patch, 'timeoutMs')
          ? {timeoutMs: item.definition.timeoutMs} : {}),
        ...(executableChanged || Object.hasOwn(item.patch, 'maxOutputBytes')
          ? {maxOutputBytes: item.definition.maxOutputBytes} : {}),
      },
      ...(item.scriptPreview === null ? {} : {scriptPreview: item.scriptPreview}),
      expectedDefinitionHash: item.expectedHash,
    });
    if (summary.length > 6000) throw new Error('approval details exceed bounded preview');
    return 'Human approval is required for an exact command update: ' + summary;
  }
  const display = JSON.stringify({
    action: item.expectedHash ? 'update' : 'register',
    commandId: item.commandId,
    type: fixed ? 'fixed' : 'package',
    description: item.definition.description,
    argv: item.definition.run,
    cwd: item.definition.cwd,
    arguments: item.definition.arguments ?? {},
    timeoutMs: item.definition.timeoutMs,
    maxOutputBytes: item.definition.maxOutputBytes,
    scriptGuard: item.definition.scriptGuard ?? null,
    previousAllow: item.previousAllow ?? null,
    allow: item.definition.allow ?? null,
    scriptPreview: item.scriptPreview,
  });
  if (display.length > 6000) throw new Error('approval details exceed bounded preview');
  return 'Human approval is required for this exact command definition: ' + display;
}

// A first-time workspace registration is confirmed once, not on every run.
// Review the exact directory whose registration will inherit into linked worktrees.
function worktreeEnableReview(input) {
  const callerCwd = realpathSync(process.cwd());
  if (input.cwd !== undefined
    && (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)
      || realpathSync(input.cwd) !== callerCwd)) {
    throw new Error('host workspace differs from hook current directory');
  }
  const runner = path.join(path.dirname(realpathSync(fileURLToPath(import.meta.url))), 'runner.mjs');
  const check = spawnSync(process.execPath, [runner, 'list'], {
    cwd: callerCwd, env: process.env, encoding: 'utf8',
    timeout: 10_000, maxBuffer: 128_000, windowsHide: true,
  });
  if (check.status !== 0) throw new Error('registered repository root could not be verified');
  let selected;
  try { selected = JSON.parse(check.stdout); }
  catch { throw new Error('runner returned invalid workspace metadata'); }
  if (selected.registeredRoot !== callerCwd || selected.runtimeRoot !== callerCwd) {
    throw new Error('worktree inheritance must be enabled at the exact registered repository root');
  }
  return 'Enable registered commands for all verified Git worktrees? Repository root: ' + callerCwd;
}

function workspaceEnsureReview(input) {
  const callerCwd = realpathSync(process.cwd());
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)
      || realpathSync(input.cwd) !== callerCwd) {
      throw new Error('host workspace differs from hook current directory');
    }
  }
  const home = process.env.COPILOT_HOME ? path.resolve(process.env.COPILOT_HOME) : path.join(os.homedir(), '.copilot');
  const configFile = path.join(home, 'command-runner', 'workspaces.json');
  let registry;
  try {
    const st = lstatSync(configFile);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('unsafe workspace registry');
    registry = JSON.parse(readFileSync(configFile, 'utf8'));
    if (!Array.isArray(registry.workspaces)) throw new Error('invalid workspace registry');
  } catch (e) {
    if (e?.code === 'ENOENT') registry = {workspaces: []};
    else throw e;
  }
  const existing = registry.workspaces.some(ws => {
    if (typeof ws.root !== 'string') throw new Error('invalid workspace root');
    let root;
    try { root = realpathSync(ws.root); }
    catch { return false; }
    const relative = path.relative(root, callerCwd);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  });
  if (existing) return null;
  // Reuse the Core Runner's Git membership verification instead of duplicating
  // authorization logic in the hook. An unverified directory still needs approval.
  const runner = path.join(path.dirname(realpathSync(fileURLToPath(import.meta.url))), 'runner.mjs');
  const check = spawnSync(process.execPath, [runner, 'list'], {
    cwd: callerCwd, env: process.env, encoding: 'utf8',
    timeout: 10_000, maxBuffer: 128_000, windowsHide: true,
  });
  if (check.status === 0) {
    try {
      const selected = JSON.parse(check.stdout);
      if (typeof selected.runtimeRoot === 'string' && typeof selected.registeredRoot === 'string'
        && selected.runtimeRoot !== selected.registeredRoot) return null;
    } catch {
      // Unrecognized Runner output is not proof of authorization.
    }
  }
  // No automatic parent-directory selection. Show the exact cwd to the human.
  const rootMarker = ['.git', 'package.json'].some(name => {
    try {
      const entry = lstatSync(path.join(callerCwd, name));
      return !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory());
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      return false;
    }
  });
  if (!rootMarker) throw new Error('new workspace root is not verifiable from this directory');
  return 'Register this exact project directory as a workspace? ' + callerCwd;
}

function ask(reason) {
  output({permissionDecision: 'ask', permissionDecisionReason: reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason }});
}

function deny(reason) {
  output({
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function parseCommand(command) {
  if (
    typeof command !== 'string'
    || command.length === 0
    || command.length > MAX_COMMAND_LENGTH
  ) {
    throw new Error('terminal command must be a non-empty bounded string');
  }
  if (FORBIDDEN_CHARACTER_PATTERN.test(command)) {
    throw new Error('terminal command contains unsupported shell syntax or control characters');
  }
  if (command !== command.trim() || /\s{2,}/u.test(command)) {
    throw new Error('terminal command must use canonical single-space formatting');
  }
  return command.split(' ');
}

function validateEncodedParameter(token) {
  if (!PARAMETER_TOKEN_PATTERN.test(token)) {
    throw new Error(`invalid named argument token: ${token}`);
  }
  const separator = token.indexOf('=');
  try {
    const decoded = decodeURIComponent(token.slice(separator + 1));
    if (/\p{Cc}/u.test(decoded)) throw new Error('control character');
  } catch {
    throw new Error(`invalid encoded value in named argument: ${token.slice(0, separator)}`);
  }
  return token.slice(0, separator);
}

function validateWorkspaceGuard(token) {
  const prefix = '--expected-workspace=';
  if (typeof token !== 'string' || !token.startsWith(prefix)
    || !COMMAND_ID_PATTERN.test(token.slice(prefix.length))) {
    throw new Error('scoped operations require --expected-workspace=<id> first');
  }
}

function validateCliInvocation(tokens) {
  if (!CLI_PREFIX.every((s, i) => s === tokens[i])) throw new Error('unknown runner prefix');
  const operation = tokens[2];
  if (operation === 'workspace.ensure' || operation === 'context') {
    if (tokens.length !== 3) throw new Error('unexpected parameters');
    return 'allow';
  }
  if (operation === 'workspace.worktrees.enable') {
    if (tokens.length !== 3) throw new Error('unexpected parameters');
    return 'ask';
  }
  if (operation === 'list') {
    for (const t of tokens.slice(3)) validateEncodedParameter(t);
    return 'allow';
  }
  if (operation === 'activate') {
    if (tokens.length !== 4 || !PROPOSAL_ID.test(tokens[3])) throw new Error('invalid proposal');
    return 'ask';
  }
  if (operation === 'propose.update') {
    if (tokens.length !== 5 || !COMMAND_ID_PATTERN.test(tokens[3] ?? '')
      || validateEncodedParameter(tokens[4]) !== 'patch') {
      throw new Error('propose.update requires one encoded patch');
    }
    return 'allow';
  }
  if (operation === 'propose') {
    if (!COMMAND_ID_PATTERN.test(tokens[3] ?? '')) throw new Error('invalid command ID');
    for (const t of tokens.slice(4)) if (!['packageDir', 'script', 'allow', 'description', 'definition'].includes(validateEncodedParameter(t))) throw new Error('unsupported proposal argument');
    return 'allow';
  }
  if (operation === 'describe' || operation === 'inspect') {
    if (!COMMAND_ID_PATTERN.test(tokens[3] ?? '') || tokens.length !== 4) throw new Error('invalid command request');
    return 'allow';
  }
  if (operation === 'run') {
    if (!COMMAND_ID_PATTERN.test(tokens[3] ?? '')) throw new Error('invalid command ID');
    for (const t of tokens.slice(4)) validateEncodedParameter(t);
    return 'allow';
  }
  if (operation === 'output') {
    if (tokens.length < 5 || !EXECUTION_ID_PATTERN.test(tokens[3] ?? '')) throw new Error('invalid execution ID');
    for (const t of tokens.slice(4)) validateEncodedParameter(t);
    return 'allow';
  }
  throw new Error('unsupported command-runner operation');
}

function validateRunnerInvocation(tokens) {
  if (
    tokens.length < FIXED_PREFIX.length + 1
    || !FIXED_PREFIX.every((token, index) => tokens[index] === token)
  ) {
    throw new Error('only the fixed user-level command runner may be invoked');
  }

  const operation = tokens[2];
  if (operation === 'workspace-list') {
    for (const token of tokens.slice(3)) validateEncodedParameter(token);
    return;
  }

  if (operation === 'list') {
    validateWorkspaceGuard(tokens[3]);
    for (const token of tokens.slice(4)) validateEncodedParameter(token);
    return;
  }

  if (operation === 'workspace-describe' || operation === 'workspace-register') {
    const workspaceId = tokens[3];
    if (!COMMAND_ID_PATTERN.test(workspaceId ?? '') || tokens.length !== 4) {
      throw new Error(`${operation} accepts exactly one safe workspace ID`);
    }
    return;
  }

  if (operation === 'workspace-unregister') {
    const workspaceId = tokens[3];
    if (!COMMAND_ID_PATTERN.test(workspaceId ?? '')) {
      throw new Error('workspace-unregister requires a safe workspace ID');
    }
    if (tokens.length !== 5 || validateEncodedParameter(tokens[4]) !== 'expected') {
      throw new Error('workspace-unregister accepts exactly expected=<workspace-hash>');
    }
    return;
  }

  if (operation === 'output') {
    const executionId = tokens[3];
    if (!EXECUTION_ID_PATTERN.test(executionId ?? '')) {
      throw new Error('output requires a safe execution ID');
    }
    validateWorkspaceGuard(tokens[4]);
    for (const token of tokens.slice(5)) validateEncodedParameter(token);
    return;
  }

  const commandId = tokens[3];
  if (!COMMAND_ID_PATTERN.test(commandId ?? '')) {
    throw new Error('describe, inspect, register, update, unregister, and run require a safe command ID');
  }
  if (operation === 'describe' || operation === 'inspect') {
    if (tokens.length !== 5) {
      throw new Error(`${operation} requires a command ID and workspace guard`);
    }
    validateWorkspaceGuard(tokens[4]);
    return;
  }
  if (operation === 'register') {
    validateWorkspaceGuard(tokens[4]);
    if (tokens.length !== 6 || validateEncodedParameter(tokens[5]) !== 'definition') {
      throw new Error('register accepts exactly --expected-workspace=<id> definition=<encoded-json>');
    }
    return;
  }
  if (operation === 'update') {
    validateWorkspaceGuard(tokens[4]);
    if (
      tokens.length !== 7
      || validateEncodedParameter(tokens[5]) !== 'expected'
      || validateEncodedParameter(tokens[6]) !== 'definition'
    ) {
      throw new Error('update accepts exactly --expected-workspace=<id> expected=<definition-hash> definition=<encoded-json>');
    }
    return;
  }
  if (operation === 'unregister') {
    validateWorkspaceGuard(tokens[4]);
    if (tokens.length !== 6 || validateEncodedParameter(tokens[5]) !== 'expected') {
      throw new Error('unregister accepts exactly --expected-workspace=<id> expected=<definition-hash>');
    }
    return;
  }
  if (operation === 'run') {
    const expected = tokens[4];
    const prefix = '--expected-workspace=';
    if (
      typeof expected !== 'string'
      || !expected.startsWith(prefix)
      || !COMMAND_ID_PATTERN.test(expected.slice(prefix.length))
    ) {
      throw new Error('run requires --expected-workspace=<id> first');
    }
    // Legacy assertions remain valid during upgrades, but current Workers do
    // not need to handle any execution hash. Partial assertions are rejected.
    let argumentStart = 5;
    if (tokens[5]?.startsWith('--expected-identity=')
      || tokens[5]?.startsWith('--expected-definition=')) {
      if (
        !/^--expected-identity=sha256-[0-9a-f]{64}$/u.test(tokens[5])
        || !/^--expected-definition=sha256-[0-9a-f]{64}$/u.test(tokens[6] ?? '')
      ) {
        throw new Error('legacy run assertions require both valid hashes');
      }
      argumentStart = 7;
    }
    for (const token of tokens.slice(argumentStart)) validateEncodedParameter(token);
    return;
  }
  throw new Error(`unsupported command-runner operation: ${operation}`);
}

function installedControlRoot() {
  // COPILOT_HOME is only for runner data, not for installed code.
  return path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '../../..');
}

function normalizePossiblePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let candidate = value.trim();
  if (candidate.startsWith('file://')) {
    candidate = fileURLToPath(candidate);
  } else {
    const slashed = candidate.replaceAll('\\', '/');
    if (slashed === '~/.copilot' || slashed.startsWith('~/.copilot/')) {
      // The CLI uses ~/.copilot syntax even when COPILOT_HOME selects a test/install root.
      candidate = installedControlRoot() + slashed.slice('~/.copilot'.length);
    } else if (slashed === '~' || slashed.startsWith('~/')) {
      candidate = os.homedir() + slashed.slice(1);
    }
  }
  // Do not collapse ".." before resolving symlinks: the filesystem may follow
  // the link first, so lexical normalization can point at a different file.
  return candidate;
}

// Walk components in filesystem order: a symlink/../ suffix must follow the
// symlink before moving up. Lexical path.resolve()/realpathSync() may otherwise
// conceal installed control targets. Missing suffixes permit normal file creation.
function canonicalTargetPath(target) {
  const absolute = path.isAbsolute(target)
    ? target : process.cwd() + path.sep + target;
  const root = path.parse(absolute).root;
  if (!root) throw new Error('cannot resolve edit target root');
  let current = realpathSync(root);
  const separator = process.platform === 'win32' ? /[\\/]+/u : /\/+/u;
  for (const part of absolute.slice(root.length).split(separator)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    try {
      current = realpathSync(next);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        if (lstatSync(next).isSymbolicLink()) {
          throw new Error('unresolvable symbolic link in edit target');
        }
      } catch (linkError) {
        if (linkError?.code !== 'ENOENT') throw linkError;
      }
      current = next;
    }
  }
  return current;
}

function sameExistingFile(left, right) {
  try {
    const a = lstatSync(left);
    const b = lstatSync(right);
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function patchTargetPaths(value) {
  const patch = typeof value === 'string' ? value
    : value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value.patch ?? value.input) : null;
  if (typeof patch !== 'string') throw new Error('patch tool requires patch text');
  const lines = patch.replaceAll('\r\n', '\n').trimEnd().split('\n');
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    throw new Error('patch tool requires a bounded Begin/End Patch envelope');
  }
  const paths = [];
  let section = null;
  for (const originalLine of lines.slice(1, -1)) {
    // In update hunks, one leading space is a context-line marker. It may
    // contain literal "*** Update File" documentation rather than a directive.
    if (section === 'update' && originalLine.startsWith(' *** ')) continue;
    const line = originalLine.trimStart();
    if (!line.startsWith('*** ')) continue;
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (file) {
      section = file[1].toLowerCase();
      paths.push(file[2].trim());
    } else if (move) {
      if (section !== 'update') throw new Error('move must follow update');
      paths.push(move[1].trim());
    } else if (!['*** End of File'].includes(line)) {
      throw new Error('unsupported patch path directive');
    }
  }
  if (!paths.length) throw new Error('patch tool needs an explicit file path');
  return paths;
}

function isProtectedTargetPath(value) {
  const target = normalizePossiblePath(value);
  if (target === null) return false;
  const canonicalTarget = canonicalTargetPath(target);
  const root = installedControlRoot();
  const installedSkill = canonicalTargetPath(path.join(root, 'skills', 'command-runner'));
  if (canonicalTarget === installedSkill || canonicalTarget.startsWith(installedSkill + path.sep)) return true;
  const installedPaths = [...PROTECTED_SUFFIXES].map((suffix) =>
    path.join(root, suffix.slice('.copilot/'.length)));
  if (process.env.COPILOT_HOME) {
    // The workspace registry follows COPILOT_HOME even when code does not.
    installedPaths.push(path.join(
      path.resolve(process.env.COPILOT_HOME), 'command-runner', 'workspaces.json',
    ));
  }
  return installedPaths.some((installedPath) => {
    const canonicalInstalled = canonicalTargetPath(installedPath);
    return canonicalTarget === canonicalInstalled
      || sameExistingFile(canonicalTarget, canonicalInstalled);
  });
}

const EDIT_TARGET_KEYS = new Set([
  'path', 'filePath', 'file_path', 'filename', 'target', 'targetPath',
  'destination', 'destinationPath', 'source', 'sourcePath', 'oldPath', 'newPath',
  'directory', 'folder', 'to', 'from', 'paths',
]);

function containsProtectedPath(value, field = null) {
  if (typeof value === 'string') {
    // Explicit target paths are never exempt, even when they look like prose.
    if (EDIT_TARGET_KEYS.has(field)) return isProtectedTargetPath(value);
    // Content and replacement strings are data, not filesystem paths.
    // A bare top-level string may still be a direct target argument.
    return field === null && !value.includes('\n')
      && !value.trimStart().startsWith('*** ')
      && isProtectedTargetPath(value);
  }
  if (Array.isArray(value)) return value.some((entry) => containsProtectedPath(entry, field));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => containsProtectedPath(entry, key));
  }
  return false;
}

function containsExecutionOverride(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).some(([key, nested]) => (
    EXECUTION_OVERRIDE_KEY_PATTERN.test(key)
    || containsExecutionOverride(nested)
  ));
}

function validateTerminalInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    throw new Error('terminal tool input must be an object');
  }
  if (containsExecutionOverride(toolInput)) {
    throw new Error(
      'terminal working directory, environment, shell, or profile overrides are not allowed',
    );
  }
  if (toolInput.isBackground === true || toolInput.background === true) {
    throw new Error('background terminal execution is not allowed');
  }
  if (toolInput.mode !== undefined && toolInput.mode !== 'sync') {
    throw new Error('terminal mode must be sync or omitted; retry the same fixed-runner command with mode=sync');
  }
  if (toolInput.timeout !== undefined && toolInput.timeout !== 0) {
    throw new Error('terminal timeout must be 0 or omitted; retry the same fixed-runner command without terminal timeout');
  }
  const words = parseCommand(toolInput.command);
  if (CLI_PREFIX.every((s, i) => words[i] === s)) return validateCliInvocation(words);
  validateRunnerInvocation(words);
  if (['register', 'update', 'unregister', 'workspace-register', 'workspace-unregister'].includes(words[2])) {
    throw new Error('Worker registry mutations require the approved propose/activate flow; owner management remains outside the Worker Hook');
  }
  return 'allow';
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const source = Buffer.concat(chunks).toString('utf8');
  if (!source || source.length > 1_048_576) {
    throw new Error('invalid hook input size');
  }
  return JSON.parse(source);
}

try {
  const input = await readInput();
  const toolName = input?.tool_name ?? input?.toolName;
  let toolInput = input?.tool_input ?? input?.toolArgs;
  if (typeof toolInput === 'string') {
    try {
      toolInput = JSON.parse(toolInput);
    } catch {
      // An opaque string can never be a valid fixed-runner terminal invocation.
    }
  }
  const githubDecision = githubMcpDecision(toolName, toolInput);
  if (githubDecision !== null) {
    output(githubDecision);
  } else if (!TERMINAL_TOOL_NAMES.has(toolName)) {
    // Parse only a real patch-bearing argument, never ordinary source text or
    // replacement strings that merely contain patch syntax as documentation.
    const isWriteTool = typeof toolName === 'string'
      && (WRITE_TOOL_NAME_PATTERN.test(toolName) || toolName === 'str_replace_editor');
    const patchPayload = toolName === 'apply_patch' ? toolInput
      : isWriteTool && typeof toolInput === 'string' && toolInput.startsWith('*** Begin Patch')
        ? toolInput
        : isWriteTool && toolInput !== null && typeof toolInput === 'object'
          && !Array.isArray(toolInput) && typeof toolInput.patch === 'string'
          ? toolInput.patch : null;
    const blockedPatch = patchPayload !== null
      && patchTargetPaths(patchPayload).some(isProtectedTargetPath);
    if (
      blockedPatch || (isWriteTool && containsProtectedPath(toolInput))
    ) {
      deny('User-level CommandRunner control files cannot be modified by agent write tools.');
    } else if (PERMITTED_NON_TERMINAL_TOOL_NAMES.has(toolName)) {
      // Local expects a continuation response; Copilot camelCase expects no
      // hook permission decision so native permission checks still apply.
      output(input?.toolName === undefined ? { continue: true } : {});
    } else {
      deny('Shared runner permits only declared Worker tools and fixed-runner terminal calls.');
    }
  } else {
    const decision = validateTerminalInput(toolInput);
    const tokens = parseCommand(toolInput.command);
    const isCli = CLI_PREFIX.every((s, i) => tokens[i] === s);
    if (isCli && tokens[2] === 'workspace.ensure') {
      const reason = workspaceEnsureReview(input);
      if (reason) ask(reason);
      else allow('Workspace is already registered and bound to this directory.');
    } else if (decision === 'ask') {
      const isActivation = isCli && tokens[2] === 'activate';
      const worktrees = isCli && tokens[2] === 'workspace.worktrees.enable';
      ask(worktrees ? worktreeEnableReview(input)
        : isActivation ? activationReview(tokens[3])
          : 'Human approval required for registry mutation; review the exact command definition.');
    } else allow('Only the fixed user-level command runner interface is permitted.');
  }
} catch (error) {
  deny(error instanceof Error ? error.message : String(error));
}
