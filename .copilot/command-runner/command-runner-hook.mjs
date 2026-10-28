#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';

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
// Keep only these explicitly read-only compatibility names non-blocking.
const READ_ONLY_TOOL_NAMES = new Set(['read/readFile', 'Read', 'view']);
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXECUTION_ID_PATTERN = /^\d{8}T\d{6}\.\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARAMETER_TOKEN_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}=[A-Za-z0-9._~%/-]*$/;
const FIXED_PREFIX = ['node', '~/.copilot/command-runner/command-runner-interface.mjs'];
const FORBIDDEN_CHARACTER_PATTERN = /[\u0000-\u001f\u007f'"`$&|;<>()[\]{}\\]/u;
const MAX_COMMAND_LENGTH = 65_536;
const PROTECTED_SUFFIXES = new Set([
  '.copilot/agents/CommandRunner.agent.md',
  '.copilot/command-runner/command-runner-hook.mjs',
  '.copilot/command-runner/command-runner.mjs',
  '.copilot/command-runner/command-runner-interface.mjs',
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
    throw new Error('describe, register, update, unregister, and run require a safe command ID');
  }
  if (operation === 'describe') {
    if (tokens.length !== 5) {
      throw new Error('describe requires a command ID and workspace guard');
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

function normalizePossiblePath(value) {
  let normalized = value.trim().replaceAll('\\', '/');
  if (normalized.startsWith('file://')) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {
      return null;
    }
  }
  normalized = path.posix.normalize(normalized);
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function containsProtectedPath(value) {
  if (typeof value === 'string') {
    const normalized = normalizePossiblePath(value);
    if (normalized === null) return false;
    return [...PROTECTED_SUFFIXES].some(
      (suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`),
    );
  }
  if (Array.isArray(value)) return value.some(containsProtectedPath);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsProtectedPath);
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
  if ((toolInput.mode !== undefined && toolInput.mode !== 'sync')
    || (toolInput.timeout !== undefined && toolInput.timeout !== 0)) {
    throw new Error('asynchronous or timed background terminal execution is not allowed');
  }
  validateRunnerInvocation(parseCommand(toolInput.command));
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
  if (!TERMINAL_TOOL_NAMES.has(toolName)) {
    if (
      typeof toolName === 'string'
      && WRITE_TOOL_NAME_PATTERN.test(toolName)
      && containsProtectedPath(toolInput)
    ) {
      deny('User-level CommandRunner control files cannot be modified by agent write tools.');
    } else if (READ_ONLY_TOOL_NAMES.has(toolName)) {
      output({ continue: true });
    } else {
      deny('CommandRunner permits only fixed-runner terminal calls and explicitly read-only tools.');
    }
  } else {
    validateTerminalInput(toolInput);
    allow('Only the fixed user-level command runner interface is permitted.');
  }
} catch (error) {
  deny(error instanceof Error ? error.message : String(error));
}
