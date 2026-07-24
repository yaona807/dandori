#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = '.github/command-runner.json';
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

// Validate JSON syntax while retaining object key boundaries so duplicate keys fail closed.
function parseStrictJson(source, sourceName = CONFIG_PATH) {
  let i = 0;
  const error = (message) => { throw new RunnerError('invalid_config', `${sourceName}: ${message} at byte ${i}`); };
  const ws = () => { while (/[\t\n\r ]/u.test(source[i] ?? '')) i += 1; };
  function string() {
    if (source[i] !== '"') error('expected string');
    const start = i++;
    while (i < source.length) {
      if (source[i] === '"') {
        i += 1;
        try { return JSON.parse(source.slice(start, i)); } catch { error('invalid string'); }
      }
      if (source[i] === '\\') {
        i += 1;
        if (source[i] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(i + 1, i + 5))) error('invalid unicode escape');
          i += 5;
        } else if ('"\\/bfnrt'.includes(source[i] ?? '')) i += 1;
        else error('invalid escape');
      } else {
        if (source.charCodeAt(i) < 0x20) error('unescaped control character');
        i += 1;
      }
    }
    error('unterminated string');
  }
  function value() {
    ws();
    if (source[i] === '{') return mapping();
    if (source[i] === '[') return array();
    if (source[i] === '"') return string();
    const match = source.slice(i).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u);
    if (!match) error('expected JSON value');
    i += match[0].length;
  }
  function array() {
    i += 1; ws();
    if (source[i] === ']') { i += 1; return; }
    while (i < source.length) {
      value(); ws();
      if (source[i] === ']') { i += 1; return; }
      if (source[i++] !== ',') error('expected comma or closing bracket');
    }
    error('unterminated array');
  }
  function mapping() {
    i += 1; ws();
    const keys = new Set();
    if (source[i] === '}') { i += 1; return; }
    while (i < source.length) {
      const key = string();
      if (keys.has(key)) error(`duplicate key ${JSON.stringify(key)}`);
      keys.add(key); ws();
      if (source[i++] !== ':') error('expected colon');
      value(); ws();
      if (source[i] === '}') { i += 1; return; }
      if (source[i++] !== ',') error('expected comma or closing brace');
      ws();
    }
    error('unterminated object');
  }
  value(); ws();
  if (i !== source.length) error('unexpected trailing content');
  try { return JSON.parse(source); } catch (errorObject) {
    throw new RunnerError('invalid_config', `${sourceName}: invalid JSON: ${errorObject.message}`);
  }
}

async function workspaceRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    try {
      await access(path.join(current, CONFIG_PATH), fsConstants.R_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new RunnerError('workspace_not_found', `unable to find ${CONFIG_PATH}`);
      current = parent;
    }
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

function validateConfig(raw) {
  requireObject(raw, 'configuration');
  requireKeys(raw, ['version', 'defaults', 'commands'], 'configuration');
  if (raw.version !== 1) throw new RunnerError('invalid_config', 'configuration.version must be 1');
  const defaults = raw.defaults ?? {};
  requireObject(defaults, 'configuration.defaults');
  requireKeys(defaults, ['timeoutMs', 'maxOutputBytes'], 'configuration.defaults');
  const base = {
    timeoutMs: defaults.timeoutMs === undefined ? DEFAULTS.timeoutMs : requireInteger(defaults.timeoutMs, 'defaults.timeoutMs', 1, 3_600_000),
    maxOutputBytes: defaults.maxOutputBytes === undefined ? DEFAULTS.maxOutputBytes : requireInteger(defaults.maxOutputBytes, 'defaults.maxOutputBytes', 1, 16_777_216),
  };
  requireObject(raw.commands, 'configuration.commands');
  if (!Object.keys(raw.commands).length) throw new RunnerError('invalid_config', 'configuration.commands must not be empty');
  const commands = {};
  for (const [id, command] of Object.entries(raw.commands)) {
    if (!ID_RE.test(id)) throw new RunnerError('invalid_config', `invalid command ID: ${id}`);
    requireObject(command, `commands.${id}`);
    requireKeys(command, ['description', 'run', 'cwd', 'arguments', 'timeoutMs', 'maxOutputBytes'], `commands.${id}`);
    if (!Array.isArray(command.run) || !command.run.length || command.run.some((item) => !safeString(item))) {
      throw new RunnerError('invalid_config', `commands.${id}.run must be a non-empty safe string array`);
    }
    const cwd = command.cwd ?? '.';
    if (!safeString(cwd) || path.isAbsolute(cwd)) throw new RunnerError('invalid_config', `commands.${id}.cwd must be workspace-relative`);
    const args = command.arguments ?? {};
    requireObject(args, `commands.${id}.arguments`);
    for (const [name, spec] of Object.entries(args)) {
      if (!NAME_RE.test(name)) throw new RunnerError('invalid_config', `invalid parameter name: ${name}`);
      validateArgument(spec, `commands.${id}.arguments.${name}`);
    }
    const executable = path.basename(command.run[0]).toLowerCase();
    const first = command.run[1]?.toLowerCase();
    if (Object.keys(args).length && INLINE_CODE.has(`${executable}\0${first}`)) {
      throw new RunnerError('invalid_config', `commands.${id} connects dynamic arguments to an inline-code execution form`);
    }
    commands[id] = {
      description: requireString(command.description, `commands.${id}.description`, 500),
      run: [...command.run], cwd, arguments: args,
      timeoutMs: command.timeoutMs === undefined ? base.timeoutMs : requireInteger(command.timeoutMs, `commands.${id}.timeoutMs`, 1, 3_600_000),
      maxOutputBytes: command.maxOutputBytes === undefined ? base.maxOutputBytes : requireInteger(command.maxOutputBytes, `commands.${id}.maxOutputBytes`, 1, 16_777_216),
    };
  }
  return { version: 1, commands };
}

async function loadConfig(root) {
  return validateConfig(parseStrictJson(await readFile(path.join(root, CONFIG_PATH), 'utf8')));
}

function publicCommand(id, command) {
  return {
    id,
    description: command.description,
    arguments: Object.entries(command.arguments).map(([name, spec]) => ({
      name, kind: spec.kind, required: spec.required === true, repeatable: spec.repeatable === true,
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
    if (total > LIMITS.totalLength) throw new RunnerError('invalid_argument', 'total parameter length exceeds the limit');
    const separator = token.indexOf('=');
    const name = token.slice(0, separator);
    if (separator <= 0 || !NAME_RE.test(name)) throw new RunnerError('invalid_argument', `parameter must use safe name=value syntax: ${token}`);
    let value;
    try { value = decodeURIComponent(token.slice(separator + 1)); } catch { throw new RunnerError('invalid_argument', `invalid percent encoding: ${name}`); }
    if (value.length > LIMITS.valueLength || CONTROL_RE.test(value)) throw new RunnerError('invalid_argument', `invalid value: ${name}`);
    result.set(name, [...(result.get(name) ?? []), value]);
  }
  return result;
}

async function workspacePath(root, value, spec, kind) {
  if (path.isAbsolute(value) || value.startsWith('-')) throw new RunnerError('invalid_argument', 'workspace paths must be relative and must not begin with a hyphen');
  const lexical = path.resolve(root, value);
  if (!inside(root, lexical)) throw new RunnerError('invalid_argument', 'workspace path escapes the workspace root');
  const mustExist = spec.mustExist !== false;
  let canonical;
  try { canonical = await realpath(lexical); } catch {
    if (mustExist) throw new RunnerError('invalid_argument', `workspace path does not exist: ${value}`);
    canonical = path.join(await realpath(path.dirname(lexical)), path.basename(lexical));
  }
  const canonicalRoot = await realpath(root);
  if (!inside(canonicalRoot, canonical)) throw new RunnerError('invalid_argument', 'workspace path resolves outside the workspace root');
  if (mustExist) {
    const info = await stat(canonical);
    if ((kind === 'file' && !info.isFile()) || (kind === 'directory' && !info.isDirectory())) {
      throw new RunnerError('invalid_argument', `workspace path is not a ${kind}: ${value}`);
    }
  }
  if (spec.extensions && !spec.extensions.some((extension) => value.endsWith(extension))) {
    throw new RunnerError('invalid_argument', `workspace path has a disallowed extension: ${value}`);
  }
  return path.relative(root, canonical) || '.';
}

async function valueFor(raw, spec, root, name) {
  if (spec.type === 'boolean') {
    if (!['true', 'false'].includes(raw)) throw new RunnerError('invalid_argument', `${name} must be true or false`);
    return raw === 'true';
  }
  if (spec.type === 'integer') {
    if (!/^-?(?:0|[1-9]\d*)$/u.test(raw)) throw new RunnerError('invalid_argument', `${name} must be an integer`);
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < spec.min || number > spec.max) {
      throw new RunnerError('invalid_argument', `${name} must be between ${spec.min} and ${spec.max}`);
    }
    return String(number);
  }
  if (spec.type === 'choice') {
    if (!spec.values.includes(raw)) throw new RunnerError('invalid_argument', `${name} must be one of the registered choices`);
    return raw;
  }
  if (spec.type === 'string') {
    if (raw.length > spec.maxLength) throw new RunnerError('invalid_argument', `${name} exceeds maxLength`);
    return raw;
  }
  if (spec.type === 'workspace-file') return workspacePath(root, raw, spec, 'file');
  if (spec.type === 'workspace-directory') return workspacePath(root, raw, spec, 'directory');
  throw new RunnerError('invalid_config', `unsupported value type for ${name}`);
}

async function invocation(id, command, supplied, root) {
  for (const name of supplied.keys()) if (!(name in command.arguments)) throw new RunnerError('invalid_argument', `unregistered parameter: ${name}`);
  const args = command.run.slice(1);
  const normalized = {};
  for (const [name, spec] of Object.entries(command.arguments)) {
    const rawValues = supplied.get(name) ?? [];
    if (spec.required && !rawValues.length) throw new RunnerError('invalid_argument', `required parameter is missing: ${name}`);
    const max = spec.repeatable ? spec.maxItems : 1;
    if (rawValues.length > max) throw new RunnerError('invalid_argument', `parameter appears too many times: ${name}`);
    if (spec.kind === 'flag') {
      if (!rawValues.length) continue;
      if (!['true', 'false'].includes(rawValues[0])) throw new RunnerError('invalid_argument', `${name} must be true or false`);
      normalized[name] = rawValues[0] === 'true';
      if (normalized[name]) args.push(spec.token);
      continue;
    }
    const values = [];
    for (const raw of rawValues) values.push(await valueFor(raw, spec.value, root, name));
    if (!values.length) continue;
    normalized[name] = spec.repeatable ? values : values[0];
    for (const value of values) spec.kind === 'option' ? args.push(spec.token, String(value)) : args.push(String(value));
  }
  const lexicalCwd = path.resolve(root, command.cwd);
  if (!inside(root, lexicalCwd)) throw new RunnerError('invalid_config', `commands.${id}.cwd escapes the workspace root`);
  const canonicalRoot = await realpath(root);
  const cwd = await realpath(lexicalCwd);
  if (!inside(canonicalRoot, cwd) || !(await stat(cwd)).isDirectory()) throw new RunnerError('invalid_config', `commands.${id}.cwd is outside the workspace or not a directory`);
  return { executable: command.run[0], args, cwd, normalized };
}

function append(chunks, state, chunk, max) {
  const remaining = max - state.bytes;
  if (remaining <= 0) { state.truncated = true; return; }
  chunks.push(chunk.subarray(0, remaining));
  state.bytes += Math.min(chunk.length, remaining);
  if (chunk.length > remaining) state.truncated = true;
}

function execute(id, command, job, root) {
  return new Promise((resolve, reject) => {
    const out = [], err = [], outState = { bytes: 0 }, errState = { bytes: 0 };
    const started = Date.now();
    let timedOut = false, settled = false;
    const child = spawn(job.executable, job.args, { cwd: job.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, command.timeoutMs).unref();
    child.stdout.on('data', (chunk) => append(out, outState, chunk, command.maxOutputBytes));
    child.stderr.on('data', (chunk) => append(err, errState, chunk, command.maxOutputBytes));
    child.on('error', (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(new RunnerError('execution_failed', `unable to start command ${id}: ${error.message}`));
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const completed = Date.now();
      resolve({
        status: timedOut ? 'timed_out' : 'completed', commandId: id, arguments: job.normalized,
        cwd: path.relative(root, job.cwd) || '.', exitCode, signal, timedOut,
        stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        truncated: Boolean(outState.truncated || errState.truncated), durationMs: completed - started,
      });
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const root = await workspaceRoot();
  const config = await loadConfig(root);
  const [operation, id, ...tokens] = argv;
  if (operation === 'list' && id === undefined) {
    emit({ status: 'ok', commands: Object.entries(config.commands).map(([key, command]) => publicCommand(key, command)) });
    return 0;
  }
  if (!ID_RE.test(id ?? '') || !(id in config.commands)) throw new RunnerError('unknown_command', `unknown command ID: ${id ?? ''}`);
  if (operation === 'describe' && !tokens.length) {
    emit({ status: 'ok', command: publicCommand(id, config.commands[id]) });
    return 0;
  }
  if (operation === 'run') {
    const command = config.commands[id];
    const result = await execute(id, command, await invocation(id, command, parseArguments(tokens), root), root);
    emit(result);
    if (result.timedOut) return 124;
    return Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 125 ? result.exitCode : 1;
  }
  throw new RunnerError('invalid_usage', 'usage: command-runner.mjs list | describe <command-id> | run <command-id> [name=encoded-value ...]');
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { process.exitCode = fail(error); });
}

export { RunnerError, main, parseStrictJson, validateConfig };
