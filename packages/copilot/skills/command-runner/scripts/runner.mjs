#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { builtinDefinitions, isBuiltinId } from './builtins.mjs';
import { validateScriptGuard, scriptFingerprint } from './script-guard.mjs';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH_RE = /^sha256-[0-9a-f]{64}$/;
const REGISTRATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME_RE = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const DEFAULTS = { timeoutMs: 300_000, maxOutputBytes: 1_048_576 };
const TERMINATION_GRACE_MS = 1_000;
const LIMITS = { parameters: 50, valueLength: 8192, totalLength: 65_536 };
const gitExec = promisify(execFile);
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
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
function identityHash(value) {
  return `sha256-${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}
function executionHash(command, defaults) {
  // Human-readable descriptions are metadata, not execution semantics.
  const { description: _description, ...executableCommand } = command;
  return identityHash({
    ...executableCommand,
    timeoutMs: command.timeoutMs ?? defaults.timeoutMs,
    maxOutputBytes: command.maxOutputBytes ?? defaults.maxOutputBytes,
  });
}
const safeString = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= LIMITS.valueLength
  && !CONTROL_RE.test(value);

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
  if (unknown.length) {
    throw new RunnerError('invalid_config', `${location} contains unsupported fields`, unknown);
  }
}

function requireString(value, location, maxLength = LIMITS.valueLength) {
  if (!safeString(value) || value.length > maxLength) {
    throw new RunnerError(
      'invalid_config',
      `${location} must be a non-empty bounded string without control characters`,
    );
  }
  return value;
}

function requireInteger(value, location, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RunnerError(
      'invalid_config',
      `${location} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

// JSON.parse accepts duplicate object keys. This small syntax pass rejects them first.
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
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          error('invalid string');
        }
      }
      if (source[index] === '\\') {
        index += 1;
        if (source[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(index + 1, index + 5))) {
            error('invalid unicode escape');
          }
          index += 5;
        } else if ('"\\/bfnrt'.includes(source[index] ?? '')) {
          index += 1;
        } else {
          error('invalid escape');
        }
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
    const match = source.slice(index).match(
      /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u,
    );
    if (!match) error('expected JSON value');
    index += match[0].length;
  }
  function parseArray() {
    index += 1;
    whitespace();
    if (source[index] === ']') {
      index += 1;
      return;
    }
    while (index < source.length) {
      parseValue();
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      if (source[index++] !== ',') error('expected comma or closing bracket');
    }
    error('unterminated array');
  }
  function parseMapping() {
    index += 1;
    whitespace();
    const keys = new Set();
    if (source[index] === '}') {
      index += 1;
      return;
    }
    while (index < source.length) {
      const key = parseString();
      if (keys.has(key)) error(`duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (source[index++] !== ':') error('expected colon');
      parseValue();
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      if (source[index++] !== ',') error('expected comma or closing brace');
      whitespace();
    }
    error('unterminated object');
  }
  parseValue();
  whitespace();
  if (index !== source.length) error('unexpected trailing content');
  try {
    return JSON.parse(source);
  } catch (parseError) {
    throw new RunnerError(
      'invalid_config',
      `${sourceName}: invalid JSON: ${parseError.message}`,
    );
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

async function canonicalExistingDirectory(value, location, allowMissing = false) {
  if (!safeString(value) || !path.isAbsolute(value)) {
    throw new RunnerError('invalid_config', `${location} must be an absolute path`);
  }
  let canonical;
  try {
    canonical = await realpath(value);
  } catch (error) {
    if (allowMissing && ['ENOENT', 'ENOTDIR'].includes(error?.code)) {
      return path.resolve(value);
    }
    throw new RunnerError('invalid_config', `${location} must identify an existing directory`);
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new RunnerError('invalid_config', `${location} must identify a directory`);
  }
  return canonical;
}

function validateValueSpec(spec, location) {
  requireObject(spec, location);
  requireKeys(
    spec,
    ['type', 'min', 'max', 'values', 'maxLength', 'extensions', 'mustExist'],
    location,
  );
  if (![
    'boolean',
    'integer',
    'choice',
    'string',
    'workspace-file',
    'workspace-directory',
  ].includes(spec.type)) {
    throw new RunnerError('invalid_config', `${location}.type is unsupported`);
  }
  if (spec.type === 'integer') {
    requireInteger(spec.min, `${location}.min`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    requireInteger(spec.max, `${location}.max`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (spec.min > spec.max) {
      throw new RunnerError('invalid_config', `${location}.min must not exceed max`);
    }
  }
  if (spec.type === 'choice') {
    if (
      !Array.isArray(spec.values)
      || !spec.values.length
      || spec.values.some((item) => !safeString(item))
    ) {
      throw new RunnerError('invalid_config', `${location}.values must contain safe strings`);
    }
    if (new Set(spec.values).size !== spec.values.length) {
      throw new RunnerError('invalid_config', `${location}.values contains duplicates`);
    }
  }
  if (spec.type === 'string') {
    requireInteger(spec.maxLength, `${location}.maxLength`, 1, LIMITS.valueLength);
  }
  if (spec.mustExist !== undefined && typeof spec.mustExist !== 'boolean') {
    throw new RunnerError('invalid_config', `${location}.mustExist must be boolean`);
  }
  if (spec.extensions !== undefined) {
    if (
      spec.type !== 'workspace-file'
      || !Array.isArray(spec.extensions)
      || !spec.extensions.length
      || spec.extensions.some(
        (item) => !safeString(item) || !item.startsWith('.') || /[/\\]/u.test(item),
      )
    ) {
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
  if (spec.required !== undefined && typeof spec.required !== 'boolean') {
    throw new RunnerError('invalid_config', `${location}.required must be boolean`);
  }
  if (spec.repeatable !== undefined && typeof spec.repeatable !== 'boolean') {
    throw new RunnerError('invalid_config', `${location}.repeatable must be boolean`);
  }
  if (spec.repeatable) {
    requireInteger(spec.maxItems, `${location}.maxItems`, 1, LIMITS.parameters);
  } else if (spec.maxItems !== undefined) {
    throw new RunnerError('invalid_config', `${location}.maxItems requires repeatable: true`);
  }
  if (spec.kind === 'flag') {
    requireKeys(spec, ['kind', 'token', 'required'], location);
    if (!safeString(spec.token) || !spec.token.startsWith('-')) {
      throw new RunnerError(
        'invalid_config',
        `${location}.token must be a safe option token`,
      );
    }
    return;
  }
  if (spec.kind === 'option' && (!safeString(spec.token) || !spec.token.startsWith('-'))) {
    throw new RunnerError(
      'invalid_config',
      `${location}.token must be a safe option token`,
    );
  }
  if (spec.kind === 'positional' && spec.token !== undefined) {
    throw new RunnerError(
      'invalid_config',
      `${location}.token is not valid for positional arguments`,
    );
  }
  validateValueSpec(spec.value, `${location}.value`);
}


const ALLOW_OPTION_RE = /^(?:--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z0-9])$/u;

// Small, deliberately bounded grammar for worker-defined commands.
function compileAllowlist(allow, location) {
  if (!Array.isArray(allow) || allow.length === 0 || allow.length > LIMITS.parameters) {
    throw new RunnerError('invalid_config', location + ' must be a non-empty bounded array');
  }
  const rules = new Map();
  let hasPathGroup = false;
  for (const entry of allow) {
    if (typeof entry !== 'string' || entry.length > 256 || CONTROL_RE.test(entry)) {
      throw new RunnerError('invalid_config', location + ' contains an invalid rule');
    }
    let option = entry;
    let kind = 'flag';
    if (entry.endsWith(' path...')) {
      option = entry.slice(0, -' path...'.length);
      kind = 'files';
    } else if (entry.endsWith('=value')) {
      option = entry.slice(0, -'=value'.length);
      kind = 'value';
    } else if (entry.endsWith('=path')) {
      option = entry.slice(0, -'=path'.length);
      kind = 'path';
    }
    if (!ALLOW_OPTION_RE.test(option) || rules.has(option) || (kind === 'files' && hasPathGroup)) {
      throw new RunnerError('invalid_config', location + ' has a duplicate or unsupported rule: ' + entry);
    }
    if (kind === 'files') hasPathGroup = true;
    rules.set(option, kind);
  }
  return rules;
}

function validateCommands(rawCommands, defaults, location) {
  requireObject(rawCommands, location);
  const commands = {};
  for (const [id, command] of Object.entries(rawCommands)) {
    if (!ID_RE.test(id)) {
      throw new RunnerError('invalid_config', `invalid command ID: ${id}`);
    }
    requireObject(command, `${location}.${id}`);
    requireKeys(
      command,
      ['description', 'run', 'cwd', 'arguments', 'allow', 'timeoutMs', 'maxOutputBytes', 'scriptGuard'],
      `${location}.${id}`,
    );
    if (
      !Array.isArray(command.run)
      || !command.run.length
      || command.run.some((item) => !safeString(item))
    ) {
      throw new RunnerError(
        'invalid_config',
        `${location}.${id}.run must be a non-empty safe string array`,
      );
    }
    const cwd = command.cwd ?? '.';
    if (!safeString(cwd) || path.isAbsolute(cwd)) {
      throw new RunnerError(
        'invalid_config',
        `${location}.${id}.cwd must be workspace-relative`,
      );
    }
    const args = command.arguments ?? {};
    requireObject(args, `${location}.${id}.arguments`);
    for (const [name, spec] of Object.entries(args)) {
      if (!NAME_RE.test(name)) {
        throw new RunnerError('invalid_config', `invalid parameter name: ${name}`);
      }
      validateArgument(spec, `${location}.${id}.arguments.${name}`);
    }
    if (command.allow !== undefined) {
      compileAllowlist(command.allow, location + '.' + id + '.allow');
      if (Object.keys(args).length) {
        throw new RunnerError('invalid_config', location + '.' + id + ' cannot mix allow and legacy arguments');
      }
    }
    const executable = path.basename(command.run[0]).toLowerCase();
    const first = command.run[1]?.toLowerCase();
    if ((Object.keys(args).length || command.allow !== undefined) && INLINE_CODE.has(`${executable}\0${first}`)) {
      throw new RunnerError(
        'invalid_config',
        `${location}.${id} connects dynamic arguments to an inline-code execution form`,
      );
    }
    if (command.scriptGuard !== undefined) {
      try { validateScriptGuard(command.scriptGuard, command, `${location}.${id}.scriptGuard`); }
      catch (error) { throw new RunnerError('invalid_config', error.message); }
    }
    commands[id] = {
      ...(command.scriptGuard === undefined ? {} : { scriptGuard: command.scriptGuard }),
      description: requireString(command.description, `${location}.${id}.description`, 500),
      run: [...command.run],
      cwd,
      arguments: args,
      ...(command.allow === undefined ? {} : { allow: [...command.allow] }),
      timeoutMs: command.timeoutMs === undefined
        ? defaults.timeoutMs
        : requireInteger(
          command.timeoutMs,
          `${location}.${id}.timeoutMs`,
          1,
          3_600_000,
        ),
      maxOutputBytes: command.maxOutputBytes === undefined
        ? defaults.maxOutputBytes
        : requireInteger(
          command.maxOutputBytes,
          `${location}.${id}.maxOutputBytes`,
          1,
          16_777_216,
        ),
    };
  }
  return commands;
}

async function validateConfig(raw, { allowMissingRoots = false } = {}) {
  requireObject(raw, 'configuration');
  requireKeys(raw, ['version', 'defaults', 'workspaces'], 'configuration');
  if (raw.version !== 1) {
    throw new RunnerError('invalid_config', 'configuration.version must be 1');
  }
  const rawDefaults = raw.defaults ?? {};
  requireObject(rawDefaults, 'configuration.defaults');
  requireKeys(rawDefaults, ['timeoutMs', 'maxOutputBytes'], 'configuration.defaults');
  const defaults = {
    timeoutMs: rawDefaults.timeoutMs === undefined
      ? DEFAULTS.timeoutMs
      : requireInteger(rawDefaults.timeoutMs, 'defaults.timeoutMs', 1, 3_600_000),
    maxOutputBytes: rawDefaults.maxOutputBytes === undefined
      ? DEFAULTS.maxOutputBytes
      : requireInteger(
        rawDefaults.maxOutputBytes,
        'defaults.maxOutputBytes',
        1,
        16_777_216,
      ),
  };
  if (!Array.isArray(raw.workspaces)) {
    throw new RunnerError(
      'invalid_config',
      'configuration.workspaces must be an array',
    );
  }
  const builtins = builtinDefinitions();
  const builtinCommands = validateCommands(builtins, defaults, 'builtins');
  const builtinHashes = Object.fromEntries(Object.entries(builtins).map(([id, cmd]) => [id, executionHash(cmd, defaults)]));
  const ids = new Set();
  const roots = new Set();
  const workspaces = [];
  for (const [index, workspace] of raw.workspaces.entries()) {
    const location = `configuration.workspaces[${index}]`;
    requireObject(workspace, location);
    requireKeys(workspace, ['id', 'root', 'commands', 'registrationId', 'inheritWorktrees'], location);
    if (workspace.inheritWorktrees !== undefined && typeof workspace.inheritWorktrees !== 'boolean') {
      throw new RunnerError('invalid_config', `${location}.inheritWorktrees must be boolean`);
    }
    if (workspace.registrationId !== undefined && !REGISTRATION_RE.test(workspace.registrationId)) {
      throw new RunnerError('invalid_config', `${location}.registrationId must be a UUIDv4`);
    }
    if (!ID_RE.test(workspace.id ?? '')) {
      throw new RunnerError('invalid_config', `${location}.id is invalid`);
    }
    if (ids.has(workspace.id)) {
      throw new RunnerError('invalid_config', `duplicate workspace ID: ${workspace.id}`);
    }
    ids.add(workspace.id);
    const root = await canonicalExistingDirectory(
      workspace.root,
      `${location}.root`,
      allowMissingRoots,
    );
    const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
    if (roots.has(rootKey)) {
      throw new RunnerError('invalid_config', `duplicate workspace root: ${root}`);
    }
    roots.add(rootKey);
    const commands = validateCommands(workspace.commands, defaults, `${location}.commands`);
    if (Object.keys(commands).some(isBuiltinId)) {
      throw new RunnerError('invalid_config', 'built-in command IDs are reserved and immutable');
    }
    workspaces.push({
      id: workspace.id,
      root,
      inheritWorktrees: workspace.inheritWorktrees === true,
      workspaceIdentity: identityHash([workspace.id, root, workspace.registrationId ?? null]),
      commandHashes: { ...builtinHashes, ...Object.fromEntries(Object.entries(workspace.commands).map(([id, cmd]) => [id, executionHash(cmd, defaults)])) },
      commands: { ...builtinCommands, ...commands },
    });
  }
  return workspaces;
}

// Git resolves repository membership; paths and directory names alone never grant authority.
async function gitOutput(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith('GIT_')));
  const { stdout } = await gitExec('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env, timeout: 5_000, maxBuffer: 1_048_576, windowsHide: true,
  });
  return stdout;
}

async function gitState(cwd) {
  const top = (await gitOutput(cwd, ['rev-parse', '--show-toplevel'])).trimEnd();
  const common = (await gitOutput(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trimEnd();
  return { top: await realpath(top), common: await realpath(common) };
}

async function listedGitWorktree(registeredRoot, runtimeRoot) {
  const output = await gitOutput(registeredRoot, ['worktree', 'list', '--porcelain', '-z']);
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    if (!entries[i].startsWith('worktree ')) continue;
    let listed;
    try { listed = await realpath(entries[i].slice('worktree '.length)); }
    catch { continue; }
    if (listed !== runtimeRoot) continue;
    // Prunable registrations refer to absent or broken worktrees, not authorized roots.
    for (let j = i + 1; j < entries.length && entries[j] !== ''; j += 1) {
      if (entries[j] === 'prunable' || entries[j].startsWith('prunable ')) return false;
    }
    return true;
  }
  return false;
}

function runtimeWorkspace(workspace, runtimeRoot) {
  return {
    ...workspace,
    registeredRoot: workspace.root,
    runtimeRoot,
    root: runtimeRoot,
    runtimeIdentity: identityHash([workspace.workspaceIdentity, runtimeRoot]),
  };
}

async function loadWorkspace(start = process.cwd()) {
  const configurationPath = configPath();
  let source;
  try {
    await access(configurationPath, fsConstants.R_OK);
    source = await readFile(configurationPath, 'utf8');
  } catch {
    throw new RunnerError(
      'configuration_not_found',
      `unable to read ${configurationPath}`,
    );
  }
  const workspaces = await validateConfig(
    parseStrictJson(source, configurationPath),
  );
  let current;
  try {
    current = await realpath(path.resolve(start));
  } catch {
    throw new RunnerError(
      'workspace_not_found',
      `current working directory does not exist: ${start}`,
    );
  }
  const direct = workspaces.filter((workspace) => inside(workspace.root, current));
  if (direct.length) {
    direct.sort((left, right) => right.root.length - left.root.length);
    if (direct.length > 1 && direct[0].root.length === direct[1].root.length) {
      throw new RunnerError('invalid_config', `workspace selection is ambiguous for ${current}`);
    }
    return runtimeWorkspace(direct[0], direct[0].root);
  }

  const eligible = workspaces.filter((workspace) => workspace.inheritWorktrees);
  if (!eligible.length) {
    throw new RunnerError('workspace_not_registered', `current workspace is not registered: ${current}`);
  }
  let runtimeGit;
  try { runtimeGit = await gitState(current); }
  catch {
    throw new RunnerError('workspace_not_registered', `current workspace is not registered: ${current}`);
  }
  const candidates = [];
  for (const workspace of eligible) {
    try {
      const registeredGit = await gitState(workspace.root);
      if (registeredGit.top !== workspace.root || registeredGit.common !== runtimeGit.common
        || !(await listedGitWorktree(workspace.root, runtimeGit.top))) continue;
      candidates.push(workspace);
    } catch {
      // Git could not verify this workspace: fail closed instead of guessing by name.
    }
  }
  if (candidates.length !== 1) {
    throw new RunnerError(candidates.length ? 'workspace_ambiguous' : 'workspace_not_registered',
      `cannot uniquely identify a registered Git worktree for ${current}`);
  }
  return runtimeWorkspace(candidates[0], runtimeGit.top);
}

function publicCommand(id, command) {
  return {
    id,
    description: command.description,
    ...(command.allow === undefined ? {} : { allow: [...command.allow] }),
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
  if (tokens.length > LIMITS.parameters) {
    throw new RunnerError('invalid_argument', 'too many parameters');
  }
  const result = new Map();
  let total = 0;
  for (const token of tokens) {
    total += token.length;
    if (total > LIMITS.totalLength) {
      throw new RunnerError('invalid_argument', 'parameter input is too large');
    }
    const separator = token.indexOf('=');
    if (separator <= 0) {
      throw new RunnerError(
        'invalid_argument',
        `parameters must use name=encoded-value: ${token}`,
      );
    }
    const name = token.slice(0, separator);
    if (!NAME_RE.test(name)) {
      throw new RunnerError('invalid_argument', `invalid parameter name: ${name}`);
    }
    let value;
    try {
      value = decodeURIComponent(token.slice(separator + 1));
    } catch {
      throw new RunnerError(
        'invalid_argument',
        `invalid percent encoding for parameter: ${name}`,
      );
    }
    if (CONTROL_RE.test(value) || value.length > LIMITS.valueLength) {
      throw new RunnerError(
        'invalid_argument',
        `parameter value is unsafe or too large: ${name}`,
      );
    }
    const values = result.get(name) ?? [];
    values.push(value);
    result.set(name, values);
  }
  return result;
}

async function canonicalPotentialPath(root, candidate, mustExist, parameterName) {
  try {
    return await realpath(candidate);
  } catch {
    if (mustExist) {
      throw new RunnerError('invalid_argument', `${parameterName} must exist`);
    }
  }

  let ancestor = path.dirname(candidate);
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      const suffix = path.relative(ancestor, candidate);
      return path.resolve(canonicalAncestor, suffix);
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor || !inside(root, parent)) {
        throw new RunnerError(
          'invalid_argument',
          `${parameterName} has no existing ancestor inside the workspace`,
        );
      }
      ancestor = parent;
    }
  }
}

async function validateWorkspacePath(value, spec, root, parameterName) {
  if (path.isAbsolute(value)) {
    throw new RunnerError(
      'invalid_argument',
      `${parameterName} must be workspace-relative`,
    );
  }
  const candidate = path.resolve(root, value);
  if (!inside(root, candidate)) {
    throw new RunnerError(
      'invalid_argument',
      `${parameterName} escapes the workspace root`,
    );
  }
  const mustExist = spec.mustExist !== false;
  const canonical = await canonicalPotentialPath(
    root,
    candidate,
    mustExist,
    parameterName,
  );
  if (!inside(root, canonical)) {
    throw new RunnerError(
      'invalid_argument',
      `${parameterName} resolves outside the workspace root`,
    );
  }
  if (mustExist) {
    const info = await stat(canonical);
    if (spec.type === 'workspace-file' && !info.isFile()) {
      throw new RunnerError('invalid_argument', `${parameterName} must be a file`);
    }
    if (spec.type === 'workspace-directory' && !info.isDirectory()) {
      throw new RunnerError(
        'invalid_argument',
        `${parameterName} must be a directory`,
      );
    }
  }
  if (
    spec.extensions
    && !spec.extensions.some((extension) => canonical.endsWith(extension))
  ) {
    throw new RunnerError(
      'invalid_argument',
      `${parameterName} has a disallowed extension`,
    );
  }
  return path.relative(root, canonical) || '.';
}

async function validateValue(value, spec, root, parameterName) {
  if (spec.type === 'boolean') {
    if (!['true', 'false'].includes(value)) {
      throw new RunnerError(
        'invalid_argument',
        `${parameterName} must be true or false`,
      );
    }
    return value === 'true';
  }
  if (spec.type === 'integer') {
    if (!/^-?(?:0|[1-9]\d*)$/u.test(value)) {
      throw new RunnerError('invalid_argument', `${parameterName} must be an integer`);
    }
    const number = Number(value);
    if (
      !Number.isSafeInteger(number)
      || number < spec.min
      || number > spec.max
    ) {
      throw new RunnerError(
        'invalid_argument',
        `${parameterName} must be between ${spec.min} and ${spec.max}`,
      );
    }
    return String(number);
  }
  if (spec.type === 'choice') {
    if (!spec.values.includes(value)) {
      throw new RunnerError(
        'invalid_argument',
        `${parameterName} must be one of ${spec.values.join(', ')}`,
      );
    }
    return value;
  }
  if (spec.type === 'string') {
    if (value.length > spec.maxLength) {
      throw new RunnerError(
        'invalid_argument',
        `${parameterName} exceeds maxLength ${spec.maxLength}`,
      );
    }
    return value;
  }
  return validateWorkspacePath(value, spec, root, parameterName);
}


async function validateAllowlistPath(value, root, cwd, fileOnly) {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new RunnerError('invalid_argument', 'path must be relative to the command directory');
  }
  const candidate = path.resolve(cwd, value);
  if (!inside(root, candidate)) {
    throw new RunnerError('invalid_argument', 'path escapes workspace');
  }
  const canonical = await canonicalPotentialPath(root, candidate, true, 'path');
  if (!inside(root, canonical)) {
    throw new RunnerError('invalid_argument', 'path resolves outside workspace');
  }
  if (fileOnly && !(await stat(canonical)).isFile()) {
    throw new RunnerError('invalid_argument', 'test path must identify an existing file');
  }
  return path.relative(cwd, canonical) || '.';
}

async function buildAllowlistInvocation(command, provided, root, cwd) {
  const unknown = [...provided.keys()].filter((key) => key !== 'arg');
  if (unknown.length) {
    throw new RunnerError('invalid_argument', 'allowlist run accepts only arg= tokens');
  }
  const rules = compileAllowlist(command.allow, 'command.allow');
  const input = provided.get('arg') ?? [];
  const seen = new Set();
  let acceptingFiles = false;
  let fileCount = 0;
  const argv = [...command.run];
  const validated = [];
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      const name = eq > 0 ? token.slice(0, eq) : token;
      const kind = rules.get(name);
      if (kind === undefined || seen.has(name) || name === '--') {
        throw new RunnerError('invalid_argument', 'unknown or repeated option: ' + name);
      }
      seen.add(name);
      if (kind === 'flag' || kind === 'files') {
        if (eq !== -1) {
          throw new RunnerError('invalid_argument', 'option does not take a value: ' + name);
        }
        argv.push(token);
        validated.push(token);
        if (kind === 'files') acceptingFiles = true;
        continue;
      }
      let rawValue;
      if (eq !== -1) {
        rawValue = token.slice(eq + 1);
      } else {
        rawValue = input[++index];
        if (rawValue === undefined || rawValue.startsWith('-')) {
          throw new RunnerError('invalid_argument', 'option requires a value: ' + name);
        }
      }
      if (!rawValue) throw new RunnerError('invalid_argument', 'empty option value: ' + name);
      const value = kind === 'path'
        ? await validateAllowlistPath(rawValue, root, cwd, false)
        : rawValue;
      if (eq !== -1) {
        argv.push(name + '=' + value);
        validated.push(name + '=' + value);
      } else {
        argv.push(name, value);
        validated.push(name, value);
      }
    } else {
      if (!acceptingFiles) {
        throw new RunnerError('invalid_argument', 'positional paths require an allowed path... option');
      }
      const value = await validateAllowlistPath(token, root, cwd, true);
      argv.push(value);
      validated.push(value);
      fileCount += 1;
    }
  }
  if (acceptingFiles && fileCount === 0) {
    throw new RunnerError('invalid_argument', 'path... requires at least one file');
  }
  return { argv, publicArguments: { argv: validated } };
}

async function buildInvocation(command, provided, root, cwd) {
  if (command.allow !== undefined) return buildAllowlistInvocation(command, provided, root, cwd);
  const unknown = [...provided.keys()].filter(
    (name) => !(name in command.arguments),
  );
  if (unknown.length) {
    throw new RunnerError(
      'invalid_argument',
      `unregistered parameter(s): ${unknown.join(', ')}`,
    );
  }

  const argv = [...command.run];
  const publicArguments = {};
  for (const [name, spec] of Object.entries(command.arguments)) {
    const values = provided.get(name) ?? [];
    if (!values.length) {
      if (spec.required) {
        throw new RunnerError(
          'invalid_argument',
          `missing required parameter: ${name}`,
        );
      }
      continue;
    }
    const maximum = spec.repeatable ? spec.maxItems : 1;
    if (values.length > maximum) {
      throw new RunnerError(
        'invalid_argument',
        `${name} accepts at most ${maximum} value(s)`,
      );
    }

    const normalized = [];
    for (const rawValue of values) {
      if (spec.kind === 'flag') {
        if (!['true', 'false'].includes(rawValue)) {
          throw new RunnerError(
            'invalid_argument',
            `${name} must be true or false`,
          );
        }
        const enabled = rawValue === 'true';
        normalized.push(enabled);
        if (enabled) argv.push(spec.token);
        continue;
      }

      if (spec.kind === 'positional' && rawValue.startsWith('-')) {
        throw new RunnerError(
          'invalid_argument',
          `${name} positional value must not start with '-'`,
        );
      }
      const value = await validateValue(rawValue, spec.value, root, name);
      normalized.push(value);
      if (spec.kind === 'option') argv.push(spec.token, value);
      else argv.push(value);
    }
    publicArguments[name] = spec.repeatable ? normalized : normalized[0];
  }
  return { argv, publicArguments };
}

async function commandDirectory(workspace, command) {
  const candidate = path.resolve(workspace.root, command.cwd);
  if (!inside(workspace.root, candidate)) {
    throw new RunnerError('invalid_config', 'command cwd escapes the workspace root');
  }
  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new RunnerError('invalid_config', 'command cwd must exist');
  }
  if (!inside(workspace.root, canonical)) {
    throw new RunnerError(
      'invalid_config',
      'command cwd resolves outside the workspace root',
    );
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new RunnerError('invalid_config', 'command cwd must be a directory');
  }
  return canonical;
}

async function execute(workspace, id, command, provided) {
  const cwd = await commandDirectory(workspace, command);
  const { argv, publicArguments } = await buildInvocation(
    command,
    provided,
    workspace.root,
    cwd,
  );
  const relativeCwd = path.relative(workspace.root, cwd) || '.';
  if (command.scriptGuard) {
    let current;
    try { current = await scriptFingerprint(cwd, command.scriptGuard.manager, command.scriptGuard.script, workspace.root); }
    catch (error) { throw new RunnerError('stale_script_definition', String(error.message)); }
    if (current.fingerprint !== command.scriptGuard.fingerprint) {
      throw new RunnerError('stale_script_definition', 'approved package scripts or manager changed');
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let terminating = false;
    let terminationTimer;

    const signalCommand = (signal) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') child.kill(signal);
      }
    };

    const terminateCommand = () => {
      if (terminating) return;
      terminating = true;
      signalCommand('SIGTERM');
      terminationTimer = setTimeout(
        () => signalCommand('SIGKILL'),
        TERMINATION_GRACE_MS,
      );
    };

    const collect = (current, chunk) => {
      if (outputTruncated) return current;
      const remaining = command.maxOutputBytes - current.length;
      if (chunk.length > remaining) {
        outputTruncated = true;
        terminateCommand();
        return Buffer.concat([current, chunk.subarray(0, Math.max(0, remaining))]);
      }
      return Buffer.concat([current, chunk]);
    };

    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateCommand();
    }, command.timeoutMs);

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      callback();
    };

    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('close', (code, signal) => {
      if (terminating) signalCommand('SIGKILL');
      finish(() => resolve({
        status: code === 0 && !signal && !timedOut && !outputTruncated
          ? 'completed'
          : 'failed',
        workspaceId: workspace.id,
        runtimeIdentity: workspace.runtimeIdentity,
        commandId: id,
        arguments: publicArguments,
        cwd: relativeCwd,
        exitCode: code,
        signal,
        timedOut,
        outputTruncated,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      }));
    });
  });
}

async function main() {
  const [operation, commandId, ...argumentTokens] = process.argv.slice(2);
  if (!['validate-config', 'list', 'describe', 'run'].includes(operation)) {
    throw new RunnerError(
      'usage',
      'usage: runner.mjs validate-config | list | describe <id> | run <id> --expected-workspace=<id> [name=encoded-value ...]',
    );
  }

  if (operation === 'validate-config') {
    if (commandId !== undefined) {
      throw new RunnerError('usage', 'validate-config does not accept arguments');
    }
    const configurationPath = configPath();
    let source;
    try {
      await access(configurationPath, fsConstants.R_OK);
      source = await readFile(configurationPath, 'utf8');
    } catch {
      throw new RunnerError(
        'configuration_not_found',
        `unable to read ${configurationPath}`,
      );
    }
    await validateConfig(
      parseStrictJson(source, configurationPath),
      { allowMissingRoots: true },
    );
    emit({ status: 'valid' });
    return 0;
  }

  const workspace = await loadWorkspace();
  if (operation === 'list') {
    if (commandId !== undefined) {
      throw new RunnerError('usage', 'list does not accept arguments');
    }
    emit({
      workspaceId: workspace.id,
      workspaceIdentity: workspace.workspaceIdentity,
      runtimeIdentity: workspace.runtimeIdentity,
      registeredRoot: workspace.registeredRoot,
      runtimeRoot: workspace.runtimeRoot,
      commands: Object.entries(workspace.commands).map(
        ([id, command]) => publicCommand(id, command),
      ),
    });
    return 0;
  }

  if (!ID_RE.test(commandId ?? '')) {
    throw new RunnerError(
      'usage',
      `${operation} requires a safe command ID`,
    );
  }
  const command = workspace.commands[commandId];
  if (operation === 'describe') {
    if (!command) {
      throw new RunnerError('command_not_registered', `command is not registered for workspace ${workspace.id}: ${commandId}`);
    }
    if (argumentTokens.length) {
      throw new RunnerError(
        'usage',
        'describe accepts exactly one command ID',
      );
    }
    emit({
      workspaceId: workspace.id,
      workspaceIdentity: workspace.workspaceIdentity,
      runtimeIdentity: workspace.runtimeIdentity,
      definitionHash: workspace.commandHashes[commandId],
      command: publicCommand(commandId, command),
    });
    return 0;
  }

  // The expected workspace is an execution guard, never a workspace selector.
  // Compare it in this process, before any command or argument-related effects.
  const guard = argumentTokens[0];
  const expectedPrefix = '--expected-workspace=';
  const expectedWorkspace = typeof guard === 'string' && guard.startsWith(expectedPrefix)
    ? guard.slice(expectedPrefix.length)
    : '';
  if (!ID_RE.test(expectedWorkspace) || guard !== `${expectedPrefix}${expectedWorkspace}`) {
    throw new RunnerError('invalid_argument', 'run requires --expected-workspace=<id> first');
  }
  if (workspace.id !== expectedWorkspace) {
    throw new RunnerError('workspace_scope_mismatch', 'selected workspace differs from delegated workspace');
  }
  if (!command) {
    throw new RunnerError('command_not_registered', `command is not registered for workspace ${workspace.id}: ${commandId}`);
  }
  let argumentStart = 1;
  const identityToken = argumentTokens[1];
  if (identityToken?.startsWith('--expected-identity=')
    || identityToken?.startsWith('--expected-definition=')) {
    const definitionToken = argumentTokens[2];
    const expectedIdentity = identityToken?.startsWith('--expected-identity=')
      ? identityToken.slice('--expected-identity='.length) : '';
    const expectedDefinition = definitionToken?.startsWith('--expected-definition=')
      ? definitionToken.slice('--expected-definition='.length) : '';
    if (!HASH_RE.test(expectedIdentity) || !HASH_RE.test(expectedDefinition)) {
      throw new RunnerError('invalid_argument', 'legacy run assertions require both valid hashes');
    }
    if (workspace.workspaceIdentity !== expectedIdentity) {
      throw new RunnerError('workspace_identity_changed', 'workspace registration or root changed since discovery');
    }
    if (workspace.commandHashes[commandId] !== expectedDefinition) {
      throw new RunnerError('stale_definition', 'command definition changed since discovery');
    }
    argumentStart = 3;
  }
  emit(await execute(
    workspace,
    commandId,
    command,
    parseArguments(argumentTokens.slice(argumentStart)),
  ));
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.exitCode = fail(error);
}
