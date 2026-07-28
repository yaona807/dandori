#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const NAME_RE = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const DEFAULTS = { timeoutMs: 300_000, maxOutputBytes: 1_048_576 };
const LIMITS = { parameters: 50, valueLength: 8192, totalLength: 65_536 };
const INLINE_CODE = new Set([
  'sh\0-c', 'bash\0-c', 'zsh\0-c', 'cmd\0/c', 'cmd.exe\0/c',
  'powershell\0-command', 'powershell.exe\0-command', 'pwsh\0-command',
  'node\0-e', 'node\0--eval', 'python\0-c', 'python3\0-c', 'ruby\0-e', 'php\0-r',
]);

class RunnerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeString = (value) => typeof value === 'string' && value.length > 0
  && value.length <= LIMITS.valueLength && !CONTROL_RE.test(value);

function copilotHome() {
  const configured = process.env.COPILOT_HOME;
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.copilot');
}

function configPath() {
  return path.join(copilotHome(), 'command-runner', 'workspaces.json');
}

function emit(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error) {
  const normalized = error instanceof RunnerError
    ? error
    : new RunnerError('internal_error', error instanceof Error ? error.message : String(error));
  emit({
    status: 'error',
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  }, process.stderr);
  return 2;
}

function requireObject(value, location) {
  if (!object(value)) throw new RunnerError('invalid_config', `${location} must be an object`);
}

function requireKeys(value, allowed, location) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new RunnerError('invalid_config', `${location} contains unsupported fields`, unknown);
}

function requireString(value, location, maxLength = LIMITS.valueLength) {
  if (!safeString(value) || value.length > maxLength) {
    throw new RunnerError('invalid_config', `${location} must be a non-empty bounded string without control characters`);
  }
  return value;
}

function requireInteger(value, location, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RunnerError('invalid_config', `${location} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseStrictJson(source, sourceName) {
  let index = 0;
  const error = (message) => {
    throw new RunnerError('invalid_config', `${sourceName}: ${message} at byte ${index}`);
  };
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(source[index] ?? '')) index += 1;
  };
  function parseString() {
    if (source[index] !== '"') error('expected string');
    const start = index++;
    while (index < source.length) {
      if (source[index] === '"') {
        index += 1;
        try { return JSON.parse(source.slice(start, index)); } catch { error('invalid string'); }
      }
      if (source[index] === '\\') {
        index += 1;
        if (source[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(index + 1, index + 5))) error('invalid unicode escape');
          index += 5;
        } else if ('"\\/bfnrt'.includes(source[index] ?? '')) index += 1;
        else error('invalid escape');
      } else {
        if (source.charCodeAt(index) < 0x20) error('unescaped control character');
        index += 1;
      }
    }
    error('unterminated string');
  }
  function parseValue() {
    whitespace();
    if (source[index] === '{') return parseMapping();
    if (source[index] === '[') return parseArray();
    if (source[index] === '"') return parseString();
    const match = source.slice(index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u);
    if (!match) error('expected JSON value');
    index += match[0].length;
  }
  function parseArray() {
    index += 1;
    whitespace();
    if (source[index] === ']') { index += 1; return; }
    while (index < source.length) {
      parseValue();
      whitespace();
      if (source[index] === ']') { index += 1; return; }
      if (source[index++] !== ',') error('expected comma or closing bracket');
    }
    error('unterminated array');
  }
  function parseMapping() {
    index += 1;
    whitespace();
    const keys = new Set();
    if (source[index] === '}') { index += 1; return; }
    while (index < source.length) {
      const key = parseString();
      if (keys.has(key)) error(`duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (source[index++] !== ':') error('expected colon');
      parseValue();
      whitespace();
      if (source[index] === '}') { index += 1; return; }
      if (source[index++] !== ',') error('expected comma or closing brace');
      whitespace();
    }
    error('unterminated object');
  }
  parseValue();
  whitespace();
  if (index !== source.length) error('unexpected trailing content');
  try { return JSON.parse(source); } catch (parseError) {
    throw new RunnerError('invalid_config', `${sourceName}: invalid JSON: ${parseError.message}`);
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalExistingDirectory(value, location) {
  if (!safeString(value) || !path.isAbsolute(value)) {
    throw new RunnerError('invalid_config', `${location} must be an absolute path`);
  }
  let canonical;
  try {
    canonical = await realpath(value);
  } catch {
    throw new RunnerError('invalid_config', `${location} must identify an existing directory`);
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new RunnerError('invalid_config', `${location} must identify a directory`);
  return canonical;
}

function validateValueSpec(spec, location) {
  requireObject(spec, location);
  requireKeys(spec, ['type', 'min', 'max', 'values', 'maxLength', 'extensions', 'mustExist'], location);
  if (!['boolean', 'integer', 'choice', 'string', 'workspace-file', 'workspace-directory'].includes(spec.type)) {
    throw new RunnerError('invalid_config', `${location}.type is unsupported`);
  }
  if (spec.type === 'integer') {
    requireInteger(spec.min, `${location}.min`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    requireInteger(spec.max, `${location}.max`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (spec.min > spec.max) throw new RunnerError('invalid_config', `${location}.min must not exceed max`);
  }
  if (spec.type === 'choice') {
    if (!Array.isArray(spec.values) || !spec.values.length || spec.values.some((item) => !safeString(item))) {
      throw new RunnerError('invalid_config', `${location}.values must contain safe strings`);
    }
    if (new Set(spec.values).size !== spec.values.length) throw new RunnerError('invalid_config', `${location}.values contains duplicates`);
  }
  if (spec.type === 'string') requireInteger(spec.maxLength, `${location}.maxLength`, 1, LIMITS.valueLength);
  if (spec.mustExist !== undefined && typeof spec.mustExist !== 'boolean') {
    throw new RunnerError('invalid_config', `${location}.mustExist must be boolean`);
  }
  if (spec.extensions !== undefined) {
    if (spec.type !== 'workspace-file' || !Array.isArray(spec.extensions) || !spec.extensions.length
      || spec.extensions.some((item) => !safeString(item) || !item.startsWith('.') || /[/\\]/u.test(item))) {
      throw new RunnerError('invalid_config', `${location}.extensions is invalid`);
    }
  }
}

function validateArgument(spec, location) {
  requireObject(spec, location);
  requireKeys(spec, ['kind', 'token', 'value', 'required', 'repeatable', 'maxItems'], location);
  if (!['flag', 'option', 'positional'].includes(spec.kind)) {
    throw new RunnerError('invalid_config', `${location}.kind is unsupported`);
  }
  if (spec.required !== undefined && typeof spec.required !== 'boolean') throw new RunnerError('invalid_config', `${location}.required must be boolean`);
  if (spec.repeatable !== undefined && typeof spec.repeatable !== 'boolean') throw new RunnerError('invalid_config', `${location}.repeatable must be boolean`);
  if (spec.repeatable) requireInteger(spec.maxItems, `${location}.maxItems`, 1, LIMITS.parameters);
  else if (spec.maxItems !== undefined) throw new RunnerError('invalid_config', `${location}.maxItems requires repeatable: true`);
  if (spec.kind === 'flag') {
    requireKeys(spec, ['kind', 'token', 'required'], location);
    if (!safeString(spec.token) || !spec.token.startsWith('-')) throw new RunnerError('invalid_config', `${location}.token must be a safe option token`);
  } else {
    if (spec.kind === 'option' && (!safeString(spec.token) || !spec.token.startsWith('-'))) {
      throw new RunnerError('invalid_config', `${location}.token must be a safe option token`);
    }
    if (spec.kind === 'positional' && spec.token !== undefined) throw new RunnerError('invalid_config', `${location}.token is not valid for positional arguments`);
    validateValueSpec(spec.value, `${location}.value`);
  }
}

function validateCommands(rawCommands, defaults, location) {
  requireObject(rawCommands, location);
  if (!Object.keys(rawCommands).length) throw new RunnerError('invalid_config', `${location} must not be empty`);
  const commands = {};
  for (const [id, command] of Object.entries(rawCommands)) {
    if (!ID_RE.test(id)) throw new RunnerError('invalid_config', `invalid command ID: ${id}`);
    requireObject(command, `${location}.${id}`);
    requireKeys(command, ['description', 'run', 'cwd', 'arguments', 'timeoutMs', 'maxOutputBytes'], `${location}.${id}`);
    if (!Array.isArray(command.run) || !command.run.length || command.run.some((item) => !safeString(item))) {
      throw new RunnerError('invalid_config', `${location}.${id}.run must be a non-empty safe string array`);
    }
    const cwd = command.cwd ?? '.';
    if (!safeString(cwd) || path.isAbsolute(cwd)) throw new RunnerError('invalid_config', `${location}.${id}.cwd must be workspace-relative`);
    const args = command.arguments ?? {};
    requireObject(args, `${location}.${id}.arguments`);
    for (const [name, spec] of Object.entries(args)) {
      if (!NAME_RE.test(name)) throw new RunnerError('invalid_config', `invalid parameter name: ${name}`);
      validateArgument(spec, `${location}.${id}.arguments.${name}`);
    }
    const executable = path.basename(command.run[0]).toLowerCase();
    const first = command.run[1]?.toLowerCase();
    if (Object.keys(args).length && INLINE_CODE.has(`${executable}\0${first}`)) {
      throw new RunnerError('invalid_config', `${location}.${id} connects dynamic arguments to an inline-code execution form`);
    }
    commands[id] = {
      description: requireString(command.description, `${location}.${id}.description`, 500),
      run: [...command.run],
      cwd,
      arguments: args,
      timeoutMs: command.timeoutMs === undefined ? defaults.timeoutMs : requireInteger(command.timeoutMs, `${location}.${id}.timeoutMs`, 1, 3_600_000),
      maxOutputBytes: command.maxOutputBytes === undefined ? defaults.maxOutputBytes : requireInteger(command.maxOutputBytes, `${location}.${id}.maxOutputBytes`, 1, 16_777_216),
    };
  }
  return commands;
}

async function validateConfig(raw) {
  requireObject(raw, 'configuration');
  requireKeys(raw, ['version', 'defaults', 'workspaces'], 'configuration');
  if (raw.version !== 1) throw new RunnerError('invalid_config', 'configuration.version must be 1');
  const rawDefaults = raw.defaults ?? {};
  requireObject(rawDefaults, 'configuration.defaults');
  requireKeys(rawDefaults, ['timeoutMs', 'maxOutputBytes'], 'configuration.defaults');
  const defaults = {
    timeoutMs: rawDefaults.timeoutMs === undefined ? DEFAULTS.timeoutMs : requireInteger(rawDefaults.timeoutMs, 'defaults.timeoutMs', 1, 3_600_000),
    maxOutputBytes: rawDefaults.maxOutputBytes === undefined ? DEFAULTS.maxOutputBytes : requireInteger(rawDefaults.maxOutputBytes, 'defaults.maxOutputBytes', 1, 16_777_216),
  };
  if (!Array.isArray(raw.workspaces) || !raw.workspaces.length) {
    throw new RunnerError('invalid_config', 'configuration.workspaces must be a non-empty array');
  }
  const ids = new Set();
  const roots = new Set();
  const workspaces = [];
  for (const [index, workspace] of raw.workspaces.entries()) {
    const location = `configuration.workspaces[${index}]`;
    requireObject(workspace, location);
    requireKeys(workspace, ['id', 'root', 'commands'], location);
    if (!ID_RE.test(workspace.id ?? '')) throw new RunnerError('invalid_config', `${location}.id is invalid`);
    if (ids.has(workspace.id)) throw new RunnerError('invalid_config', `duplicate workspace ID: ${workspace.id}`);
    ids.add(workspace.id);
    const root = await canonicalExistingDirectory(workspace.root, `${location}.root`);
    const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
    if (roots.has(rootKey)) throw new RunnerError('invalid_config', `duplicate workspace root: ${root}`);
    roots.add(rootKey);
    workspaces.push({
      id: workspace.id,
      root,
      commands: validateCommands(workspace.commands, defaults, `${location}.commands`),
    });
  }
  return workspaces;
}

async function loadWorkspace(start = process.cwd()) {
  const configurationPath = configPath();
  let source;
  try {
    await access(configurationPath, fsConstants.R_OK);
    source = await readFile(configurationPath, 'utf8');
  } catch {
    throw new RunnerError('configuration_not_found', `unable to read ${configurationPath}`);
  }
  const workspaces = await validateConfig(parseStrictJson(source, configurationPath));
  let current;
  try {
    current = await realpath(path.resolve(start));
  } catch {
    throw new RunnerError('workspace_not_found', `current working directory does not exist: ${start}`);
  }
  const matches = workspaces.filter((workspace) => inside(workspace.root, current));
  if (!matches.length) {
    throw new RunnerError('workspace_not_registered', `current workspace is not registered: ${current}`);
  }
  matches.sort((left, right) => right.root.length - left.root.length);
  if (matches.length > 1 && matches[0].root.length === matches[1].root.length) {
    throw new RunnerError('invalid_config', `workspace selection is ambiguous for ${current}`);
  }
  return matches[0];
}

function publicCommand(id, command) {
  return {
    id,
    description: command.description,
    arguments: Object.entries(command.arguments).map(([name, spec]) => ({
      name,
      kind: spec.kind,
      required: spec.required === true,
      repeatable: spec.repeatable === true,
      ...(spec.maxItems === undefined ? {} : { maxItems: spec.maxItems }),
      ...(spec.kind === 'flag' ? { type: 'boolean' } : { ...spec.value }),
    })),
  };
}

function parseArguments(tokens) {
  if (tokens.length > LIMITS.parameters) throw new RunnerError('invalid_argument', 'too many parameters');
  const result = new Map();
  let total = 0;
  for (const token of tokens) {
    total += token.length;
    if (total > LIMITS.totalLength) throw new RunnerError('invalid_argument', 'parameter input is too large');
    const separator = token.indexOf('=');
    if (separator <= 0) throw new RunnerError('invalid_argument', `parameters must use name=encoded-value: ${token}`);
    const name = token.slice(0, separator);
    if (!NAME_RE.test(name)) throw new RunnerError('invalid_argument', `invalid parameter name: ${name}`);
    let value;
    try { value = decodeURIComponent(token.slice(separator + 1)); } catch {
      throw new RunnerError('invalid_argument', `invalid percent encoding for parameter: ${name}`);
    }
    if (CONTROL_RE.test(value) || value.length > LIMITS.valueLength) {
      throw new RunnerError('invalid_argument', `parameter value is unsafe or too large: ${name}`);
    }
    const values = result.get(name) ?? [];
    values.push(value);
    result.set(name, values);
  }
  return result;
}

async function validateWorkspacePath(value, spec, root, parameterName) {
  if (path.isAbsolute(value)) throw new RunnerError('invalid_argument', `${parameterName} must be workspace-relative`);
  const candidate = path.resolve(root, value);
  if (!inside(root, candidate)) throw new RunnerError('invalid_argument', `${parameterName} escapes the workspace root`);
  let canonical = candidate;
  try {
    canonical = await realpath(candidate);
  } catch {
    if (spec.mustExist !== false) throw new RunnerError('invalid_argument', `${parameterName} must exist`);
  }
  if (!inside(root, canonical)) throw new RunnerError('invalid_argument', `${parameterName} resolves outside the workspace root`);
  if (spec.mustExist !== false) {
    const info = await stat(canonical);
    if (spec.type === 'workspace-file' && !info.isFile()) throw new RunnerError('invalid_argument', `${parameterName} must be a file`);
    if (spec.type === 'workspace-directory' && !info.isDirectory()) throw new RunnerError('invalid_argument', `${parameterName} must be a directory`);
  }
  if (spec.extensions && !spec.extensions.some((extension) => canonical.endsWith(extension))) {
    throw new RunnerError('invalid_argument', `${parameterName} has a disallowed extension`);
  }
  return path.relative(root, canonical) || '.';
}

async function validateValue(value, spec, root, parameterName) {
  if (spec.type === 'boolean') {
    if (!['true', 'false'].includes(value)) throw new RunnerError('invalid_argument', `${parameterName} must be true or false`);
    return value === 'true';
  }
  if (spec.type === 'integer') {
    if (!/^-?(?:0|[1-9]\d*)$/u.test(value)) throw new RunnerError('invalid_argument', `${parameterName} must be an integer`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < spec.min || number > spec.max) {
      throw new RunnerError('invalid_argument', `${parameterName} must be between ${spec.min} and ${spec.max}`);
    }
    return String(number);
  }
  if (spec.type === 'choice') {
    if (!spec.values.includes(value)) throw new RunnerError('invalid_argument', `${parameterName} must be one of ${spec.values.join(', ')}`);
    return value;
  }
  if (spec.type === 'string') {
    if (value.length > spec.maxLength) throw new RunnerError('invalid_argument', `${parameterName} exceeds maxLength ${spec.maxLength}`);
    return value;
  }
  return validateWorkspacePath(value, spec, root, parameterName);
}

async function buildArgv(command, provided, root) {
  const unknown = [...provided.keys()].filter((name) => !(name in command.arguments));
  if (unknown.length) throw new RunnerError('invalid_argument', `unregistered parameter(s): ${unknown.join(', ')}`);
  const argv = [...command.run];
  for (const [name, spec] of Object.entries(command.arguments)) {
    const values = provided.get(name) ?? [];
    if (!values.length) {
      if (spec.required) throw new RunnerError('invalid_argument', `missing required parameter: ${name}`);
      continue;
    }
    const maximum = spec.repeatable ? spec.maxItems : 1;
    if (values.length > maximum) throw new RunnerError('invalid_argument', `${name} accepts at most ${maximum} value(s)`);
    for (const rawValue of values) {
      if (spec.kind === 'flag') {
        if (!['true', 'false'].includes(rawValue)) throw new RunnerError('invalid_argument', `${name} must be true or false`);
        if (rawValue === 'true') argv.push(spec.token);
        continue;
      }
      const value = await validateValue(rawValue, spec.value, root, name);
      if (spec.kind === 'option') argv.push(spec.token, value);
      else argv.push(value);
    }
  }
  return argv;
}

async function commandDirectory(workspace, command) {
  const candidate = path.resolve(workspace.root, command.cwd);
  if (!inside(workspace.root, candidate)) throw new RunnerError('invalid_config', 'command cwd escapes the workspace root');
  let canonical;
  try { canonical = await realpath(candidate); } catch {
    throw new RunnerError('invalid_config', 'command cwd must exist');
  }
  if (!inside(workspace.root, canonical)) throw new RunnerError('invalid_config', 'command cwd resolves outside the workspace root');
  if (!(await stat(canonical)).isDirectory()) throw new RunnerError('invalid_config', 'command cwd must be a directory');
  return canonical;
}

async function execute(workspace, id, command, provided) {
  const argv = await buildArgv(command, provided, workspace.root);
  const cwd = await commandDirectory(workspace, command);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exceeded = false;
    const collect = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > command.maxOutputBytes) {
        exceeded = true;
        child.kill();
        return combined.subarray(0, command.maxOutputBytes);
      }
      return combined;
    };
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => child.kill(), command.timeoutMs);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: code === 0 && !signal && !exceeded ? 'completed' : 'failed',
        workspaceId: workspace.id,
        commandId: id,
        exitCode: code,
        signal,
        outputTruncated: exceeded,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    });
  });
}

async function main() {
  const [operation, commandId, ...argumentTokens] = process.argv.slice(2);
  if (!['list', 'describe', 'run'].includes(operation)) {
    throw new RunnerError('usage', 'usage: command-runner.mjs list | describe <id> | run <id> [name=encoded-value ...]');
  }
  const workspace = await loadWorkspace();
  if (operation === 'list') {
    if (commandId !== undefined) throw new RunnerError('usage', 'list does not accept arguments');
    emit({ workspaceId: workspace.id, commands: Object.entries(workspace.commands).map(([id, command]) => publicCommand(id, command)) });
    return 0;
  }
  if (!ID_RE.test(commandId ?? '')) throw new RunnerError('usage', `${operation} requires a safe command ID`);
  const command = workspace.commands[commandId];
  if (!command) throw new RunnerError('command_not_registered', `command is not registered for workspace ${workspace.id}: ${commandId}`);
  if (operation === 'describe') {
    if (argumentTokens.length) throw new RunnerError('usage', 'describe accepts exactly one command ID');
    emit({ workspaceId: workspace.id, command: publicCommand(commandId, command) });
    return 0;
  }
  emit(await execute(workspace, commandId, command, parseArguments(argumentTokens)));
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.exitCode = fail(error);
}
