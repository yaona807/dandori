#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';

const TERMINAL_TOOL_NAMES = new Set([
  'execute/runInTerminal',
  'runInTerminal',
  'runTerminalCommand',
]);
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
const EXECUTION_OVERRIDE_KEY_PATTERN = /^(?:cwd|workingDirectory|working_directory|env|environment|shell|executable|profile|terminal|options)$/iu;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function allow(reason) {
  output({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  });
}

function deny(reason) {
  output({
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

function validateRunnerInvocation(tokens) {
  if (
    tokens.length < FIXED_PREFIX.length + 1
    || !FIXED_PREFIX.every((token, index) => tokens[index] === token)
  ) {
    throw new Error('only the fixed user-level command runner may be invoked');
  }

  const operation = tokens[2];
  if (operation === 'list') {
    for (const token of tokens.slice(3)) validateEncodedParameter(token);
    return;
  }

  if (operation === 'output') {
    const executionId = tokens[3];
    if (!EXECUTION_ID_PATTERN.test(executionId ?? '')) {
      throw new Error('output requires a safe execution ID');
    }
    for (const token of tokens.slice(4)) validateEncodedParameter(token);
    return;
  }

  const commandId = tokens[3];
  if (!COMMAND_ID_PATTERN.test(commandId ?? '')) {
    throw new Error('describe, register, unregister, and run require a safe command ID');
  }
  if (operation === 'describe') {
    if (tokens.length !== 4) {
      throw new Error('describe accepts exactly one command ID');
    }
    return;
  }
  if (operation === 'register') {
    if (tokens.length !== 5 || validateEncodedParameter(tokens[4]) !== 'definition') {
      throw new Error('register accepts exactly definition=<encoded-json>');
    }
    return;
  }
  if (operation === 'unregister') {
    if (tokens.length !== 5 || validateEncodedParameter(tokens[4]) !== 'expected') {
      throw new Error('unregister accepts exactly expected=<definition-hash>');
    }
    return;
  }
  if (operation === 'run') {
    for (const token of tokens.slice(4)) validateEncodedParameter(token);
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
  const toolName = input?.tool_name;
  if (!TERMINAL_TOOL_NAMES.has(toolName)) {
    if (
      typeof toolName === 'string'
      && WRITE_TOOL_NAME_PATTERN.test(toolName)
      && containsProtectedPath(input?.tool_input)
    ) {
      deny('User-level CommandRunner control files cannot be modified by agent write tools.');
    } else {
      output({ continue: true });
    }
  } else {
    validateTerminalInput(input?.tool_input);
    allow('Only the fixed user-level command runner interface is permitted.');
  }
} catch (error) {
  deny(error instanceof Error ? error.message : String(error));
}
