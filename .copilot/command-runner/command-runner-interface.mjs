#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const COMMAND_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const QUERY_RE = /^[a-z0-9_-]{1,64}$/;
const NAME_RE = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const DEFINITION_HASH_RE = /^sha256-[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const EXECUTION_ID_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const LIMITS = {
  responseBytes: 12_288,
  describeBytes: 10_000,
  listPageSize: 100,
  previewBytes: 512,
  outputChunkBytes: 1_536,
  parameterCount: 50,
  parameterTotalLength: 65_536,
  parameterValueLength: 8_192,
  managementDefinitionBytes: 16_384,
  coreResponseBytes: 256 * 1024 * 1024,
  executionTtlMs: 24 * 60 * 60 * 1000,
  executionCacheBytes: 256 * 1024 * 1024,
  maxExecutionReserveBytes: 32 * 1024 * 1024,
  activeGraceMs: 61 * 60 * 1000,
  staleLockMs: 5 * 60 * 1000,
};

class InterfaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function interfaceHome() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function corePath() {
  return path.join(interfaceHome(), 'command-runner.mjs');
}

function copilotHome() {
  return process.env.COPILOT_HOME
    ? path.resolve(process.env.COPILOT_HOME)
    : path.join(os.homedir(), '.copilot');
}

function configurationPath() {
  return path.join(copilotHome(), 'command-runner', 'workspaces.json');
}

function configurationLockPath() {
  return path.join(copilotHome(), 'command-runner', 'workspaces.lock');
}

function executionsRoot() {
  return path.join(copilotHome(), 'command-runner', 'executions');
}

function serialize(value) {
  return `${JSON.stringify(value)}\n`;
}

function emit(value, stream = process.stdout) {
  const source = serialize(value);
  if (Buffer.byteLength(source) > LIMITS.responseBytes) {
    throw new InterfaceError('response_too_large', 'bounded command-runner response exceeded its limit');
  }
  stream.write(source);
}

function fail(error) {
  const normalized = error instanceof InterfaceError
    ? error
    : new InterfaceError('internal_error', error instanceof Error ? error.message : String(error));
  const source = serialize({ status: 'error', error: { code: normalized.code, message: normalized.message } });
  process.stderr.write(
    Buffer.byteLength(source) <= LIMITS.responseBytes
      ? source
      : '{"status":"error","error":{"code":"response_too_large","message":"error response exceeded limit"}}\n',
  );
  return 2;
}

function parseArguments(tokens, valueByteLimit = LIMITS.parameterValueLength) {
  if (tokens.length > LIMITS.parameterCount) {
    throw new InterfaceError('invalid_argument', 'too many parameters');
  }
  const result = new Map();
  let total = 0;
  for (const token of tokens) {
    total += token.length;
    if (total > LIMITS.parameterTotalLength) {
      throw new InterfaceError('invalid_argument', 'parameter input is too large');
    }
    const separator = token.indexOf('=');
    if (separator <= 0) {
      throw new InterfaceError('invalid_argument', `parameters must use name=encoded-value: ${token}`);
    }
    const name = token.slice(0, separator);
    if (!NAME_RE.test(name)) {
      throw new InterfaceError('invalid_argument', `invalid parameter name: ${name}`);
    }
    let value;
    try {
      value = decodeURIComponent(token.slice(separator + 1));
    } catch {
      throw new InterfaceError('invalid_argument', `invalid percent encoding for parameter: ${name}`);
    }
    if (CONTROL_RE.test(value) || Buffer.byteLength(value) > valueByteLimit) {
      throw new InterfaceError('invalid_argument', `parameter value is unsafe or too large: ${name}`);
    }
    const values = result.get(name) ?? [];
    values.push(value);
    result.set(name, values);
  }
  return result;
}

function one(provided, name, required = false) {
  const values = provided.get(name) ?? [];
  if (values.length > 1) throw new InterfaceError('invalid_argument', `${name} accepts one value`);
  if (required && values.length !== 1) throw new InterfaceError('invalid_argument', `${name} is required`);
  return values[0];
}

function allowOnly(provided, names) {
  const unknown = [...provided.keys()].filter((name) => !names.has(name));
  if (unknown.length) {
    throw new InterfaceError('invalid_argument', `unregistered parameter(s): ${unknown.join(', ')}`);
  }
}

function offset(value) {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new InterfaceError('invalid_argument', 'offset must be a non-negative integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InterfaceError('invalid_argument', 'offset is too large');
  return parsed;
}

async function runCore(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [corePath(), ...args], {
      cwd: process.cwd(),
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let oversized = false;
    const collect = (chunks, chunk) => {
      if (oversized) return;
      totalBytes += chunk.length;
      if (totalBytes > LIMITS.coreResponseBytes) {
        oversized = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => { collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { collect(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (oversized) {
        reject(new InterfaceError('core_response_too_large', 'fixed runner response exceeded internal capture limit'));
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stderrText);
          reject(new InterfaceError(parsed?.error?.code ?? 'runner_error', parsed?.error?.message ?? 'fixed runner failed'));
        } catch (error) {
          if (error instanceof InterfaceError) reject(error);
          else reject(new InterfaceError('runner_error', stderrText.trim() || `fixed runner exited ${code}`));
        }
        return;
      }
      try {
        resolve(JSON.parse(stdoutText));
      } catch {
        reject(new InterfaceError('runner_protocol_error', 'fixed runner returned invalid JSON'));
      }
    });
  });
}

function parseStrictJson(source, code, sourceName) {
  let index = 0;
  const syntaxError = (message) => {
    throw new InterfaceError(code, `${sourceName}: ${message} at byte ${index}`);
  };
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(source[index] ?? '')) index += 1;
  };
  function parseString() {
    if (source[index] !== '"') syntaxError('expected string');
    const start = index++;
    while (index < source.length) {
      if (source[index] === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          syntaxError('invalid string');
        }
      }
      if (source[index] === '\\') {
        index += 1;
        if (source[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(index + 1, index + 5))) {
            syntaxError('invalid unicode escape');
          }
          index += 5;
        } else if ('"\\/bfnrt'.includes(source[index] ?? '')) {
          index += 1;
        } else {
          syntaxError('invalid escape');
        }
      } else {
        if (source.charCodeAt(index) < 0x20) syntaxError('unescaped control character');
        index += 1;
      }
    }
    syntaxError('unterminated string');
  }
  function parseValue() {
    whitespace();
    if (source[index] === '{') return parseMapping();
    if (source[index] === '[') return parseArray();
    if (source[index] === '"') return parseString();
    const match = source.slice(index).match(
      /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u,
    );
    if (!match) syntaxError('expected JSON value');
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
      if (source[index++] !== ',') syntaxError('expected comma or closing bracket');
    }
    syntaxError('unterminated array');
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
      if (keys.has(key)) syntaxError(`duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (source[index++] !== ':') syntaxError('expected colon');
      parseValue();
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      if (source[index++] !== ',') syntaxError('expected comma or closing brace');
      whitespace();
    }
    syntaxError('unterminated object');
  }
  parseValue();
  whitespace();
  if (index !== source.length) syntaxError('unexpected trailing content');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new InterfaceError(code, `${sourceName}: invalid JSON: ${error.message}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function definitionHash(definition) {
  return `sha256-${createHash('sha256')
    .update(JSON.stringify(canonicalize(definition)))
    .digest('hex')}`;
}

function publicConfiguredCommand(id, command) {
  const argumentsDefinition = command.arguments ?? {};
  return {
    id,
    description: command.description,
    arguments: Object.entries(argumentsDefinition).map(([name, spec]) => ({
      name,
      kind: spec.kind,
      required: spec.required === true,
      repeatable: spec.repeatable === true,
      ...(spec.maxItems === undefined ? {} : { maxItems: spec.maxItems }),
      ...(spec.kind === 'flag' ? { type: 'boolean' } : { ...spec.value }),
    })),
  };
}

async function readConfigurationSource() {
  const file = configurationPath();
  let info;
  try {
    info = await lstat(file);
  } catch {
    throw new InterfaceError('configuration_not_found', `unable to read ${file}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new InterfaceError('unsafe_configuration_path', 'workspaces.json must be a regular non-symlink file for management operations');
  }
  const source = await readFile(file, 'utf8');
  return {
    source,
    raw: parseStrictJson(source, 'invalid_config', file),
  };
}

async function readStableConfiguration() {
  const before = await readConfigurationSource();
  const selected = await runCore(['list']);
  const afterSource = await readFile(configurationPath(), 'utf8');
  if (afterSource !== before.source) {
    throw new InterfaceError('configuration_changed', 'workspaces.json changed while it was being inspected');
  }
  if (typeof selected.workspaceId !== 'string' || !COMMAND_ID_RE.test(selected.workspaceId)) {
    throw new InterfaceError('runner_protocol_error', 'fixed runner returned an invalid workspace ID');
  }
  const matches = Array.isArray(before.raw?.workspaces)
    ? before.raw.workspaces.filter((workspace) => workspace?.id === selected.workspaceId)
    : [];
  if (matches.length !== 1) {
    throw new InterfaceError('invalid_config', 'selected workspace is not uniquely present in workspaces.json');
  }
  return { ...before, workspaceId: selected.workspaceId, workspace: matches[0] };
}

async function validateCandidateConfiguration(configuration, expectedWorkspaceId) {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dandori-command-runner-config-'));
  try {
    const directory = path.join(temporaryHome, 'command-runner');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, 'workspaces.json'),
      `${JSON.stringify(configuration, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const result = await runCore(['list'], { ...process.env, COPILOT_HOME: temporaryHome });
    if (result?.workspaceId !== expectedWorkspaceId) {
      throw new InterfaceError('workspace_identity_changed', 'candidate configuration changes the selected workspace identity');
    }
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

async function writeConfigurationAtomically(source, configuration) {
  const file = configurationPath();
  const current = await readFile(file, 'utf8');
  if (current !== source) {
    throw new InterfaceError('configuration_changed', 'workspaces.json changed before the update could be committed');
  }
  const temporary = path.join(path.dirname(file), `.workspaces.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

async function withConfigurationLock(callback) {
  const lockPath = configurationLockPath();
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs >= LIMITS.staleLockMs) {
        throw new InterfaceError(
          'stale_configuration_lock',
          `stale command-runner configuration lock requires manual removal: ${lockPath}`,
        );
      }
    } catch (statError) {
      if (statError instanceof InterfaceError) throw statError;
      if (statError?.code === 'ENOENT') {
        throw new InterfaceError('configuration_busy', 'command-runner configuration changed concurrently; retry the exact operation');
      }
      throw statError;
    }
    throw new InterfaceError('configuration_busy', 'another command-runner management operation is in progress');
  }
  try {
    await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8');
    await handle.sync();
    return await callback();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function describeConfiguredCommand(id) {
  const snapshot = await readStableConfiguration();
  const command = snapshot.workspace.commands?.[id];
  if (!command) {
    throw new InterfaceError(
      'command_not_registered',
      `command is not registered for workspace ${snapshot.workspaceId}: ${id}`,
    );
  }
  return {
    workspaceId: snapshot.workspaceId,
    command: publicConfiguredCommand(id, command),
    definitionHash: definitionHash(command),
  };
}

function parseCommandDefinition(id, definitionSource) {
  const definition = parseStrictJson(
    definitionSource,
    'invalid_definition',
    `command definition ${id}`,
  );
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new InterfaceError('invalid_definition', 'command definition must be a JSON object');
  }
  return definition;
}

async function registerConfiguredCommand(id, definitionSource) {
  return withConfigurationLock(async () => {
    const snapshot = await readStableConfiguration();
    if (snapshot.workspace.commands?.[id]) {
      throw new InterfaceError(
        'command_already_registered',
        `command is already registered for workspace ${snapshot.workspaceId}: ${id}`,
      );
    }
    const definition = parseCommandDefinition(id, definitionSource);
    const candidate = JSON.parse(JSON.stringify(snapshot.raw));
    const workspace = candidate.workspaces.find((entry) => entry.id === snapshot.workspaceId);
    workspace.commands[id] = definition;
    await validateCandidateConfiguration(candidate, snapshot.workspaceId);
    await writeConfigurationAtomically(snapshot.source, candidate);
    return {
      status: 'completed',
      workspaceId: snapshot.workspaceId,
      commandId: id,
      definitionHash: definitionHash(definition),
    };
  });
}

async function updateConfiguredCommand(id, expectedHash, definitionSource) {
  if (!DEFINITION_HASH_RE.test(expectedHash)) {
    throw new InterfaceError('invalid_argument', 'expected must be a sha256 definition hash returned by describe');
  }
  return withConfigurationLock(async () => {
    const snapshot = await readStableConfiguration();
    const current = snapshot.workspace.commands?.[id];
    if (!current) {
      throw new InterfaceError(
        'command_not_registered',
        `command is not registered for workspace ${snapshot.workspaceId}: ${id}`,
      );
    }
    const currentHash = definitionHash(current);
    if (currentHash !== expectedHash) {
      throw new InterfaceError('stale_definition', 'registered command changed after it was described');
    }
    const definition = parseCommandDefinition(id, definitionSource);
    const candidate = JSON.parse(JSON.stringify(snapshot.raw));
    const workspace = candidate.workspaces.find((entry) => entry.id === snapshot.workspaceId);
    workspace.commands[id] = definition;
    await validateCandidateConfiguration(candidate, snapshot.workspaceId);
    await writeConfigurationAtomically(snapshot.source, candidate);
    return {
      status: 'completed',
      workspaceId: snapshot.workspaceId,
      commandId: id,
      previousDefinitionHash: currentHash,
      definitionHash: definitionHash(definition),
    };
  });
}

async function unregisterConfiguredCommand(id, expectedHash) {
  if (!DEFINITION_HASH_RE.test(expectedHash)) {
    throw new InterfaceError('invalid_argument', 'expected must be a sha256 definition hash returned by describe');
  }
  return withConfigurationLock(async () => {
    const snapshot = await readStableConfiguration();
    const command = snapshot.workspace.commands?.[id];
    if (!command) {
      throw new InterfaceError(
        'command_not_registered',
        `command is not registered for workspace ${snapshot.workspaceId}: ${id}`,
      );
    }
    const currentHash = definitionHash(command);
    if (currentHash !== expectedHash) {
      throw new InterfaceError('stale_definition', 'registered command changed after it was described');
    }
    if (Object.keys(snapshot.workspace.commands).length <= 1) {
      throw new InterfaceError('last_command', 'cannot remove the last command from a registered workspace');
    }
    const candidate = JSON.parse(JSON.stringify(snapshot.raw));
    const workspace = candidate.workspaces.find((entry) => entry.id === snapshot.workspaceId);
    delete workspace.commands[id];
    await validateCandidateConfiguration(candidate, snapshot.workspaceId);
    await writeConfigurationAtomically(snapshot.source, candidate);
    return {
      status: 'completed',
      workspaceId: snapshot.workspaceId,
      commandId: id,
      removedDefinitionHash: currentHash,
    };
  });
}

function executionId(now = new Date()) {
  return `${now.toISOString().replaceAll('-', '').replaceAll(':', '')}_${randomUUID()}`;
}

function executionCreatedAt(id) {
  const match = EXECUTION_ID_RE.exec(id);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second), Number(millisecond),
  );
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isUtf8Continuation(byte) {
  return (byte & 0xc0) === 0x80;
}

async function managedExecutions() {
  const root = executionsRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const entries = [];
  for (const workspace of await readdir(root, { withFileTypes: true })) {
    if (!workspace.isDirectory() || !COMMAND_ID_RE.test(workspace.name)) continue;
    const workspaceRoot = path.join(root, workspace.name);
    for (const execution of await readdir(workspaceRoot, { withFileTypes: true })) {
      if (!execution.isDirectory()) continue;
      const createdAt = executionCreatedAt(execution.name);
      if (createdAt === null) continue;
      const directory = path.join(workspaceRoot, execution.name);
      let size = 0;
      for (const name of ['stdout.log', 'stderr.log']) {
        try {
          const info = await stat(path.join(directory, name));
          if (info.isFile()) size += info.size;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      entries.push({ directory, createdAt, age: Math.max(0, now - createdAt), size });
    }
  }
  return entries;
}

async function cleanupExecutions(reserveBytes = 0) {
  let entries = await managedExecutions();
  for (const entry of entries.filter(({ age }) => age >= LIMITS.executionTtlMs)) {
    await rm(entry.directory, { recursive: true, force: true });
  }
  entries = await managedExecutions();
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const target = LIMITS.executionCacheBytes - reserveBytes;
  const removable = entries
    .filter(({ age }) => age >= LIMITS.activeGraceMs)
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const entry of removable) {
    if (total <= target) break;
    await rm(entry.directory, { recursive: true, force: true });
    total -= entry.size;
  }
  if (total > target) {
    throw new InterfaceError(
      'execution_cache_full',
      'execution cache is full with recent results; retry after older results become removable',
    );
  }
}

async function workspaceId() {
  const result = await runCore(['list']);
  if (typeof result.workspaceId !== 'string' || !COMMAND_ID_RE.test(result.workspaceId)) {
    throw new InterfaceError('runner_protocol_error', 'fixed runner returned an invalid workspace ID');
  }
  return result.workspaceId;
}

function tail(value) {
  const buffer = Buffer.from(typeof value === 'string' ? value : '', 'utf8');
  if (buffer.length <= LIMITS.previewBytes) return buffer.toString('utf8');
  let start = buffer.length - LIMITS.previewBytes;
  while (start < buffer.length && isUtf8Continuation(buffer[start])) start += 1;
  return buffer.subarray(start).toString('utf8');
}

async function storeExecution(workspace, coreResult) {
  const id = executionId();
  const root = path.join(executionsRoot(), workspace);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, id);
  await mkdir(directory, { mode: 0o700 });
  const stdout = typeof coreResult.stdout === 'string' ? coreResult.stdout : '';
  const stderr = typeof coreResult.stderr === 'string' ? coreResult.stderr : '';
  await Promise.all([
    writeFile(path.join(directory, 'stdout.log'), stdout, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    writeFile(path.join(directory, 'stderr.log'), stderr, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  ]);
  return {
    status: coreResult.status,
    workspaceId: workspace,
    commandId: coreResult.commandId,
    executionId: id,
    cwd: coreResult.cwd,
    exitCode: coreResult.exitCode,
    signal: coreResult.signal,
    timedOut: coreResult.timedOut === true,
    outputTruncated: coreResult.outputTruncated === true,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdoutPreview: tail(stdout),
    stderrPreview: tail(stderr),
  };
}

async function readOutput(workspace, id, provided) {
  allowOnly(provided, new Set(['stream', 'offset']));
  const stream = one(provided, 'stream', true);
  if (!['stdout', 'stderr'].includes(stream)) {
    throw new InterfaceError('invalid_argument', 'stream must be stdout or stderr');
  }
  const start = offset(one(provided, 'offset'));
  const createdAt = executionCreatedAt(id);
  if (createdAt === null) throw new InterfaceError('invalid_argument', 'invalid execution ID');
  if (Date.now() - createdAt >= LIMITS.executionTtlMs) {
    throw new InterfaceError('execution_expired', `execution has expired: ${id}`);
  }

  const root = path.join(executionsRoot(), workspace);
  let canonicalRoot;
  let directory;
  try {
    canonicalRoot = await realpath(root);
    directory = await realpath(path.join(root, id));
  } catch {
    throw new InterfaceError('execution_not_found', `execution is unavailable: ${id}`);
  }
  if (!inside(canonicalRoot, directory) || path.basename(directory) !== id) {
    throw new InterfaceError('execution_not_found', `execution is unavailable: ${id}`);
  }
  const requested = path.join(directory, `${stream}.log`);
  let file;
  try {
    file = await realpath(requested);
  } catch {
    throw new InterfaceError('execution_not_found', `execution output is unavailable: ${id}`);
  }
  if (!inside(directory, file)) {
    throw new InterfaceError('execution_not_found', `execution output is unavailable: ${id}`);
  }
  const info = await stat(file);
  if (!info.isFile()) throw new InterfaceError('execution_not_found', `execution output is unavailable: ${id}`);
  if (start > info.size) throw new InterfaceError('invalid_argument', `offset exceeds ${stream} size`);

  const handle = await open(file, 'r');
  let end = Math.min(start + LIMITS.outputChunkBytes, info.size);
  let buffer;
  try {
    if (start < info.size) {
      const boundary = Buffer.alloc(1);
      await handle.read(boundary, 0, 1, start);
      if (isUtf8Continuation(boundary[0])) {
        throw new InterfaceError('invalid_argument', 'offset must be at a UTF-8 character boundary');
      }
    }
    if (end < info.size) {
      const boundary = Buffer.alloc(1);
      await handle.read(boundary, 0, 1, end);
      while (end > start && isUtf8Continuation(boundary[0])) {
        end -= 1;
        await handle.read(boundary, 0, 1, end);
      }
    }
    const count = end - start;
    buffer = Buffer.alloc(count);
    if (count) await handle.read(buffer, 0, count, start);
  } finally {
    await handle.close();
  }
  return {
    workspaceId: workspace,
    executionId: id,
    stream,
    offset: start,
    nextOffset: end,
    eof: end >= info.size,
    data: buffer.toString('utf8'),
  };
}

async function main() {
  const [operation, subject, ...rest] = process.argv.slice(2);
  if (!['list', 'describe', 'register', 'update', 'unregister', 'run', 'output'].includes(operation)) {
    throw new InterfaceError(
      'usage',
      'usage: command-runner-interface.mjs list [query=<value>] [offset=<n>] | describe <id> | register <id> definition=<encoded-json> | update <id> expected=<definition-hash> definition=<encoded-json> | unregister <id> expected=<definition-hash> | run <id> [name=encoded-value ...] | output <execution-id> stream=stdout|stderr [offset=<n>]',
    );
  }

  if (operation === 'list') {
    const tokens = subject === undefined ? rest : [subject, ...rest];
    const provided = parseArguments(tokens);
    allowOnly(provided, new Set(['query', 'offset']));
    const query = one(provided, 'query');
    if (query !== undefined && !QUERY_RE.test(query)) {
      throw new InterfaceError('invalid_argument', 'query must use command-ID characters');
    }
    const start = offset(one(provided, 'offset'));
    const result = await runCore(['list']);
    const ids = (Array.isArray(result.commands) ? result.commands : [])
      .map((command) => command?.id)
      .filter((id) => typeof id === 'string' && COMMAND_ID_RE.test(id))
      .sort()
      .filter((id) => query === undefined || id.includes(query));
    if (start > ids.length) throw new InterfaceError('invalid_argument', 'offset exceeds matching command count');
    const page = ids.slice(start, start + LIMITS.listPageSize);
    const nextOffset = start + page.length;
    emit({
      workspaceId: result.workspaceId,
      commandIds: page,
      offset: start,
      nextOffset: nextOffset < ids.length ? nextOffset : null,
      total: ids.length,
    });
    return 0;
  }

  if (operation === 'describe') {
    if (!COMMAND_ID_RE.test(subject ?? '') || rest.length) {
      throw new InterfaceError('usage', 'describe accepts exactly one safe command ID');
    }
    const response = await describeConfiguredCommand(subject);
    if (Buffer.byteLength(serialize(response)) > LIMITS.describeBytes) {
      throw new InterfaceError('definition_too_large', 'command definition is too large to return safely');
    }
    emit(response);
    return 0;
  }

  if (operation === 'register') {
    if (!COMMAND_ID_RE.test(subject ?? '')) {
      throw new InterfaceError('usage', 'register requires a safe command ID');
    }
    const provided = parseArguments(rest, LIMITS.managementDefinitionBytes);
    allowOnly(provided, new Set(['definition']));
    emit(await registerConfiguredCommand(subject, one(provided, 'definition', true)));
    return 0;
  }

  if (operation === 'update') {
    if (!COMMAND_ID_RE.test(subject ?? '')) {
      throw new InterfaceError('usage', 'update requires a safe command ID');
    }
    const provided = parseArguments(rest, LIMITS.managementDefinitionBytes);
    allowOnly(provided, new Set(['expected', 'definition']));
    emit(await updateConfiguredCommand(
      subject,
      one(provided, 'expected', true),
      one(provided, 'definition', true),
    ));
    return 0;
  }

  if (operation === 'unregister') {
    if (!COMMAND_ID_RE.test(subject ?? '')) {
      throw new InterfaceError('usage', 'unregister requires a safe command ID');
    }
    const provided = parseArguments(rest);
    allowOnly(provided, new Set(['expected']));
    emit(await unregisterConfiguredCommand(subject, one(provided, 'expected', true)));
    return 0;
  }

  if (operation === 'run') {
    if (!COMMAND_ID_RE.test(subject ?? '')) {
      throw new InterfaceError('usage', 'run requires a safe command ID');
    }
    parseArguments(rest);
    const workspace = await workspaceId();
    await cleanupExecutions(LIMITS.maxExecutionReserveBytes);
    const result = await runCore(['run', subject, ...rest]);
    if (result?.workspaceId !== workspace || result?.commandId !== subject) {
      throw new InterfaceError(
        'runner_protocol_error',
        'fixed runner identity changed during execution',
      );
    }
    emit(await storeExecution(workspace, result));
    return 0;
  }

  if (!EXECUTION_ID_RE.test(subject ?? '')) {
    throw new InterfaceError('usage', 'output requires a safe execution ID');
  }
  const workspace = await workspaceId();
  emit(await readOutput(workspace, subject, parseArguments(rest)));
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.exitCode = fail(error);
}
