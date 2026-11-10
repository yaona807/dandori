#!/usr/bin/env node
// Registration-free worker facade. The legacy management API remains internal.
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { scriptFingerprint, scriptRunArgs } from './script-guard.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(process.env.COPILOT_HOME ? path.resolve(process.env.COPILOT_HOME) : path.join(os.homedir(), '.copilot'), 'command-runner');
const CONFIG = path.join(HOME, 'workspaces.json');
const PROPOSALS = path.join(HOME, 'proposals');
const COMMAND = /^[a-z][a-z0-9_-]{0,63}$/u;
const PROPOSAL = /^prop-[0-9a-f]{32}$/u;
const MAX_AGE = 24 * 60 * 60 * 1000;
const LIMIT = 12_288;

function error(code, message) { const e = new Error(message); e.code = code; return e; }
function emit(data) {
  const output = JSON.stringify(data) + '\n';
  if (Buffer.byteLength(output) > LIMIT) throw error('response_too_large', 'bounded output exceeded');
  process.stdout.write(output);
}
function core(name, args) {
  const result = spawnSync(process.execPath, [path.join(DIR, name), ...args], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8',
    // Run Core enforces each command's configured timeout (up to one hour).
    // Reserve extra time for process-tree termination and response persistence.
    timeout: args[0] === 'run' ? 3_750_000 : 120_000,
    maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw error('runner_unavailable', result.error.message);
  if (result.status !== 0) {
    let data;
    try { data = JSON.parse(result.stderr); } catch { /* reporting only */ }
    throw error(data?.error?.code ?? 'runner_error', data?.error?.message ?? String(result.stderr).slice(0, 350));
  }
  try { return JSON.parse(result.stdout); }
  catch { throw error('runner_protocol_error', 'runner returned invalid JSON'); }
}
const runCore = (args) => core('runner.mjs', args);
const runInterface = (args) => core('gateway.mjs', args);
const encode = (v) => encodeURIComponent(v);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = (v) => 'sha256-' + createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const within = (root, full) => {
  const relative = path.relative(root, full);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
function safeParams(tokens) {
  if (tokens.length > 50) throw error('invalid_argument', 'too many parameters');
  const values = new Map();
  for (const token of tokens) {
    const index = token.indexOf('=');
    if (index < 1 || !/^[a-z][A-Za-z0-9_-]{0,63}$/u.test(token.slice(0, index))) {
      throw error('invalid_argument', 'parameters must be name=encoded-value');
    }
    const key = token.slice(0, index);
    if (values.has(key)) throw error('invalid_argument', 'duplicate option ' + key);
    let value;
    try { value = decodeURIComponent(token.slice(index + 1)); }
    catch { throw error('invalid_argument', 'invalid percent encoding'); }
    if (value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) throw error('invalid_argument', 'unsafe option');
    values.set(key, value);
  }
  return values;
}
async function init() {
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  try {
    await writeFile(CONFIG, JSON.stringify({ version: 1, defaults: { timeoutMs: 300000, maxOutputBytes: 1048576 }, workspaces: [] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) { if (e?.code !== 'EEXIST') throw e; }
}
async function current() {
  const selected = runCore(['list']);
  if (!COMMAND.test(selected.workspaceId)) throw error('runner_protocol_error', 'workspace identity unavailable');
  return selected;
}
async function selectedConfig() {
  const selected = await current();
  const state = await lstat(CONFIG);
  if (!state.isFile() || state.isSymbolicLink()) throw error('unsafe_configuration_path', 'unsafe registry');
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const matches = config.workspaces.filter(v => v.id === selected.workspaceId);
  if (matches.length !== 1) throw error('invalid_config', 'ambiguous workspace');
  return {selected, workspace: matches[0]};
}
async function ensure() {
  await init();
  try {
    const existing = await current();
    return { status: 'ready', workspace: 'current', registered: false, commandCount: existing.commands.length };
  } catch (e) {
    if (!['workspace_not_registered'].includes(e.code)) throw e;
  }
  // Never walk upward or infer a parent root from a package/monorepo file.
  // An unregistered session must be launched in the exact project root.
  const here = await realpath(process.cwd());
  let marker = false;
  for (const name of ['.git', 'package.json']) {
    try { const st = await lstat(path.join(here, name)); if (!st.isSymbolicLink() && (st.isFile() || st.isDirectory())) marker = true; }
    catch (e) { if (e?.code !== 'ENOENT') throw e; }
  }
  if (!marker) throw error('workspace_root_unverified', 'launch the CommandRunner from the exact project root containing package.json or .git');
  const id = 'ws-' + randomUUID().replaceAll('-', '').slice(0, 24);
  // The existing interface handles config locking, overlap and canonical-root checks.
  try { runInterface(['workspace-register', id]); }
  catch (e) {
    // An equivalent concurrent ensure is idempotent; unrelated registration is not.
    if (!['workspace_overlap', 'workspace_already_registered', 'configuration_changed'].includes(e.code)) throw e;
    await current();
  }
  const selected = await current();
  return { status: 'ready', workspace: 'current', registered: true, commandCount: selected.commands.length };
}
async function readProposal(id) {
  if (!PROPOSAL.test(id)) throw error('invalid_argument', 'invalid proposal ID');
  const file = path.join(PROPOSALS, id + '.json');
  const state = await lstat(file);
  if (!state.isFile() || state.isSymbolicLink() || state.size > 32_768) {
    throw error('invalid_proposal', 'proposal must be an ordinary bounded file');
  }
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (record.id !== id || ![1, 2, 3, 4].includes(record.version) || !COMMAND.test(record.commandId)
    || (record.version === 3 && record.kind !== 'fixed')
    || (record.version === 4 && (record.kind !== 'update'
      || !record.patch || typeof record.patch !== 'object' || Array.isArray(record.patch)
      || !record.previous || typeof record.previous !== 'object' || Array.isArray(record.previous)
      || !/^sha256-[0-9a-f]{64}$/u.test(record.expectedHash)))
    || !Number.isFinite(record.expiresAt) || Date.now() > record.expiresAt
    || (record.runtimeIdentity !== undefined && !/^sha256-[0-9a-f]{64}$/u.test(record.runtimeIdentity))
    || record.approvalDigest !== digest([...(record.version === 1
      ? [record.workspaceIdentity, record.commandId, record.definition, record.scriptPreview, record.expectedHash ?? null]
      : record.version === 2
        ? [record.workspaceIdentity, record.commandId, record.definition, record.scriptPreview, record.expectedHash ?? null, record.previousAllow]
        : record.version === 3
          ? [record.workspaceIdentity, record.commandId, record.definition, record.scriptPreview, record.expectedHash ?? null, record.previousAllow, record.kind]
          : [record.workspaceIdentity, record.commandId, record.definition, record.scriptPreview, record.expectedHash, record.previousAllow, record.kind, record.patch, record.previous]),
      ...(record.runtimeIdentity === undefined ? [] : [record.runtimeIdentity])]) {
    throw error('stale_proposal', 'proposal is expired or was modified');
  }
  return record;
}

function parseAllowParam(encoded) {
  if (encoded === undefined) return undefined;
  let entries;
  try { entries = JSON.parse(encoded); }
  catch { throw error('invalid_argument', 'allow must be a JSON array of rule strings'); }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 50) {
    throw error('invalid_argument', 'allow must contain between 1 and 50 rules');
  }
  const names = new Set();
  let filesGroup = false;
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length > 256) throw error('invalid_argument', 'invalid allow rule');
    let option = entry;
    if (entry.endsWith(' path...')) {
      option = entry.slice(0, -' path...'.length);
      if (filesGroup) throw error('invalid_argument', 'only one path... group is supported');
      filesGroup = true;
    } else if (entry.endsWith('=value')) option = entry.slice(0, -'=value'.length);
    else if (entry.endsWith('=path')) option = entry.slice(0, -'=path'.length);
    if (!/^(?:--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z0-9])$/u.test(option) || names.has(option)) {
      throw error('invalid_argument', 'unsupported or duplicate allow rule: ' + entry);
    }
    names.add(option);
  }
  return entries;
}
function scriptDiscoveryError(cause) {
  switch (cause?.message) {
    case 'package.json is missing':
      return error('package_manifest_missing', 'package.json is missing from the selected packageDir');
    case 'the requested package script is unavailable':
      return error('script_missing', 'the requested script is not defined in the selected package.json');
    case 'ambiguous package manager: no declaration or lockfile inside workspace':
      return error('package_manager_undetermined', 'set packageManager or provide one lockfile family inside the workspace');
    case 'ambiguous package manager: competing lockfile families':
      return error('package_manager_ambiguous', 'competing lockfile families exist at the same directory');
    case 'unsupported packageManager declaration':
      return error('invalid_package_manager', 'packageManager must declare npm, pnpm, yarn, or bun');
    case 'package scripts contain non-string definitions':
      return error('invalid_package_metadata', 'package.json scripts must contain string values');
    default:
      if (cause instanceof SyntaxError) {
        return error('invalid_package_json', 'package.json must contain valid JSON');
      }
      if (typeof cause?.message === 'string' && cause.message.startsWith('invalid package manager metadata path: ')) {
        return error('invalid_package_metadata', 'package.json and lockfiles must be regular non-symlink files; package.json must be at most 1 MiB');
      }
      return error('script_discovery_failed', 'unable to read or validate the package script metadata');
  }
}

function checkedDescription(value, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() !== value || value.length < 20
    || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw error('invalid_description', 'description must be a specific 20-500 character single-line explanation of purpose, scope, effects, and result');
  }
  return value;
}

// The fixed proposal is deliberately smaller than the owner management schema.
// No dynamic arguments, shell wrappers, or alternate package-script launchers.
async function fixedDefinition(input, root) {
  let candidate = input;
  if (typeof input === 'string') {
    try { candidate = JSON.parse(input); }
    catch { throw error('invalid_definition', 'definition must be a JSON object'); }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || Object.keys(candidate).some(k => !['description', 'run', 'cwd', 'arguments', 'timeoutMs', 'maxOutputBytes'].includes(k))) {
    throw error('invalid_definition', 'fixed definition accepts only description, run, cwd, empty arguments, timeoutMs and maxOutputBytes');
  }
  const description = checkedDescription(candidate.description, true);
  if (!Array.isArray(candidate.run) || candidate.run.length < 1 || candidate.run.length > 32
    || candidate.run.some(v => typeof v !== 'string' || !v || v.length > 1024 || /[\u0000-\u001f\u007f]/u.test(v))) {
    throw error('invalid_definition', 'run must be a bounded non-empty fixed argv array');
  }
  const argv = candidate.run;
  const executable = path.basename(argv[0]).toLowerCase();
  if (new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe',
    'pwsh', 'pwsh.exe', 'env', 'sudo', 'su', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'corepack']).has(executable)) {
    throw error('unsupported_fixed_launcher', 'shell/proxy launchers and package script managers are not supported by fixed proposals');
  }
  const inline = argv.slice(1);
  if ((/^node(?:js)?(?:\.exe)?$/u.test(executable)
      && inline.some(v => ['-e', '-p', '--eval', '--print', '-r', '--require'].includes(v)
        || /^(?:--eval|--print|--require)=/u.test(v)))
    || (/^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/u.test(executable)
      && inline.some(v => v === '-c' || v === '-'))
    || (/^(?:ruby|perl|php)(?:\.exe)?$/u.test(executable)
      && inline.some(v => ['-e', '-r', '-c'].includes(v)))) {
    throw error('unsupported_fixed_launcher', 'inline interpreter execution is not supported by fixed proposals');
  }
  if (candidate.arguments !== undefined && (candidate.arguments === null
    || typeof candidate.arguments !== 'object' || Array.isArray(candidate.arguments)
    || Object.keys(candidate.arguments).length !== 0)) {
    throw error('invalid_definition', 'fixed proposals cannot accept variable arguments');
  }
  const requestedCwd = candidate.cwd ?? '.';
  if (typeof requestedCwd !== 'string' || !requestedCwd || path.isAbsolute(requestedCwd)
    || requestedCwd.includes('\\') || requestedCwd.split('/').includes('..')
    || /[\u0000-\u001f\u007f]/u.test(requestedCwd)) {
    throw error('invalid_definition', 'cwd must be a workspace-relative existing directory');
  }
  let cwd;
  try { cwd = await realpath(path.resolve(root, requestedCwd)); }
  catch { throw error('invalid_definition', 'cwd must identify an existing directory'); }
  if (!within(root, cwd)) throw error('path_escape', 'fixed command cwd escapes workspace');
  if (!(await lstat(cwd)).isDirectory()) throw error('invalid_definition', 'cwd must identify a directory');
  for (const [key, ceiling] of [['timeoutMs', 3_600_000], ['maxOutputBytes', 16_777_216]]) {
    if (candidate[key] !== undefined && (!Number.isInteger(candidate[key]) || candidate[key] < 1 || candidate[key] > ceiling)) {
      throw error('invalid_definition', key + ' must be a bounded positive integer');
    }
  }
  return {description, run: [...argv], cwd: path.relative(root, cwd) || '.', arguments: {},
    timeoutMs: candidate.timeoutMs ?? 300000, maxOutputBytes: candidate.maxOutputBytes ?? 1048576};
}

async function propose(commandId, params) {
  if (!COMMAND.test(commandId)) throw error('invalid_argument', 'invalid command ID');
  if (commandId.startsWith('builtin-')) throw error('builtin_immutable', 'built-in command IDs cannot be proposed');
  const fixed = params.has('definition');
  const allowedKeys = fixed ? ['definition'] : ['packageDir', 'script', 'allow', 'description'];
  if ([...params.keys()].some(k => !allowedKeys.includes(k))) {
    throw error('invalid_argument', fixed ? 'definition cannot be combined with package-script parameters'
      : 'only packageDir/script/allow/description are supported');
  }
  const {selected, workspace} = await selectedConfig();
  const root = await realpath(selected.runtimeRoot ?? workspace.root);
  let definition;
  let scriptPreview = null;
  let kind = 'fixed';
  if (fixed) {
    definition = await fixedDefinition(params.get('definition'), root);
  } else {
    kind = 'package';
    const allow = parseAllowParam(params.get('allow'));
    const packageDir = params.get('packageDir') ?? '.';
    if (!packageDir || path.isAbsolute(packageDir) || packageDir.includes('..') || packageDir.includes('\\')) {
      throw error('invalid_argument', 'packageDir must be a workspace-relative directory');
    }
    const dir = await realpath(path.resolve(root, packageDir));
    if (!within(root, dir)) throw error('path_escape', 'packageDir escapes workspace');
    const scriptName = params.get('script') ?? commandId;
    let selectedScript;
    for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
      try { selectedScript = { manager, ...(await scriptFingerprint(dir, manager, scriptName, root)) }; break; }
      catch (cause) {
        if (cause?.message !== 'package manager changed since command approval') {
          throw scriptDiscoveryError(cause);
        }
      }
    }
    if (!selectedScript) throw error('script_discovery_failed', 'unable to identify a supported package manager');
    const cwd = path.relative(root, dir) || '.';
    // Legacy callers without description remain supported, but agents must supply
    // an evidence-based description instead of relying on this limited fallback.
    const description = checkedDescription(params.get('description'))
      ?? `Run ${selectedScript.manager} package script "${scriptName}" in ${cwd}. Review script lifecycle hooks and effects before execution.`;
    definition = {
      description,
      run: scriptRunArgs(selectedScript.manager, scriptName),
      cwd, arguments: {},
      ...(allow === undefined ? {} : { allow }),
      scriptGuard: {manager: selectedScript.manager, script: scriptName, fingerprint: selectedScript.fingerprint},
      timeoutMs: 300000, maxOutputBytes: 1048576,
    };
    scriptPreview = Object.fromEntries(
      [`pre${scriptName}`, scriptName, `post${scriptName}`]
        .filter(name => Object.hasOwn(selectedScript.scripts, name))
        .map(name => [name, selectedScript.scripts[name]]),
    );
  }
  if (fixed && Buffer.byteLength(JSON.stringify(definition)) > 5000) {
    throw error('invalid_definition', 'fixed proposal is too large for a complete human approval preview');
  }
  const original = workspace.commands[commandId] ?? null;
  const id = 'prop-' + randomUUID().replaceAll('-', '');
  const record = {version: fixed ? 3 : 2, id, commandId, workspaceIdentity: selected.workspaceIdentity,
    ...(selected.runtimeIdentity ? {runtimeIdentity: selected.runtimeIdentity} : {}),
    ...(fixed ? {kind} : {}), definition, scriptPreview, previousAllow: original?.allow ?? null,
    expectedHash: original ? digest(original) : null, expiresAt: Date.now() + MAX_AGE};
  const subject = [record.workspaceIdentity, record.commandId, record.definition, record.scriptPreview,
    record.expectedHash, record.previousAllow];
  record.approvalDigest = digest([...(fixed ? [...subject, kind] : subject),
    ...(record.runtimeIdentity ? [record.runtimeIdentity] : [])]);
  await mkdir(PROPOSALS, {recursive: true, mode: 0o700});
  await writeFile(path.join(PROPOSALS, id + '.json'), JSON.stringify(record) + '\n', {flag: 'wx', mode: 0o600});
  return {status: 'pending_approval', proposalId: id, commandId, proposalType: kind,
    description: definition.description, argv: definition.run, cwd: definition.cwd,
    arguments: definition.arguments, timeoutMs: definition.timeoutMs, maxOutputBytes: definition.maxOutputBytes,
    ...(fixed ? {} : {scriptGuard: definition.scriptGuard, scriptPreview}),
    approvalDigest: record.approvalDigest, action: original ? 'update' : 'register'};
}

// Modify an existing command without reconstructing unrelated execution settings.
// Execution-bearing changes must obey the same constrained paths as new proposals.
function parseUpdatePatch(text) {
  let patch;
  try { patch = JSON.parse(text); }
  catch { throw error('invalid_argument', 'patch must be a JSON object'); }
  const allowed = new Set(['description', 'run', 'cwd', 'allow', 'timeoutMs', 'maxOutputBytes', 'script', 'packageDir']);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).length === 0
    || Object.keys(patch).some(key => !allowed.has(key))) {
    throw error('invalid_argument', 'patch may modify only description, run, cwd, allow, timeoutMs, maxOutputBytes, script and packageDir');
  }
  return patch;
}
function previousFields(original, patch) {
  return Object.fromEntries(Object.keys(patch).map(key => [key, key === 'script'
    ? original.scriptGuard?.script ?? null
    : key === 'packageDir' ? original.cwd
      : original[key] ?? null]));
}
async function updatedDefinition(original, patch, root) {
  const next = {...original};
  if (Object.hasOwn(patch, 'description')) next.description = checkedDescription(patch.description, true);
  for (const [key, ceiling] of [['timeoutMs', 3_600_000], ['maxOutputBytes', 16_777_216]]) {
    if (!Object.hasOwn(patch, key)) continue;
    if (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > ceiling) {
      throw error('invalid_argument', key + ' must be a bounded positive integer');
    }
    next[key] = patch[key];
  }

  const packageScript = original.scriptGuard !== undefined;
  const changesPackageScript = Object.hasOwn(patch, 'script') || Object.hasOwn(patch, 'packageDir');
  const changesFixedExecution = Object.hasOwn(patch, 'run') || Object.hasOwn(patch, 'cwd');
  let scriptPreview = null;

  if (packageScript) {
    if (changesFixedExecution) {
      throw error('invalid_argument', 'package script execution must be updated using script/packageDir');
    }
    if (Object.hasOwn(patch, 'allow')) {
      if (patch.allow === null) delete next.allow;
      else next.allow = parseAllowParam(JSON.stringify(patch.allow));
      if (next.allow && Object.keys(next.arguments ?? {}).length !== 0) {
        throw error('invalid_definition', 'an allowlist cannot be combined with legacy named arguments');
      }
    }
    if (changesPackageScript) {
      const packageDir = patch.packageDir ?? original.cwd ?? '.';
      const scriptName = patch.script ?? original.scriptGuard.script;
      if (typeof packageDir !== 'string' || !packageDir || path.isAbsolute(packageDir)
        || packageDir.includes('..') || packageDir.includes('\\')) {
        throw error('invalid_argument', 'packageDir must be a workspace-relative directory');
      }
      if (typeof scriptName !== 'string' || !scriptName || scriptName.length > 256) {
        throw error('invalid_argument', 'script must be an explicit bounded package script name');
      }
      let dir;
      try { dir = await realpath(path.resolve(root, packageDir)); }
      catch { throw error('invalid_argument', 'packageDir does not exist'); }
      if (!within(root, dir)) throw error('path_escape', 'packageDir escapes workspace');
      let selected;
      for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
        try { selected = {manager, ...(await scriptFingerprint(dir, manager, scriptName, root))}; break; }
        catch (cause) {
          if (cause?.message !== 'package manager changed since command approval') throw scriptDiscoveryError(cause);
        }
      }
      if (!selected) throw error('script_discovery_failed', 'unable to identify a supported package manager');
      next.run = scriptRunArgs(selected.manager, scriptName);
      next.cwd = path.relative(root, dir) || '.';
      next.scriptGuard = {manager: selected.manager, script: scriptName, fingerprint: selected.fingerprint};
      scriptPreview = Object.fromEntries(
        ['pre' + scriptName, scriptName, 'post' + scriptName]
          .filter(name => Object.hasOwn(selected.scripts, name))
          .map(name => [name, selected.scripts[name]]),
      );
    }
  } else {
    if (Object.hasOwn(patch, 'allow') || changesPackageScript) {
      throw error('invalid_argument', 'allow/script/packageDir updates require a registered package script');
    }
    if (changesFixedExecution) {
      if (original.allow !== undefined || Object.keys(original.arguments ?? {}).length !== 0) {
        throw error('invalid_definition', 'legacy dynamic-argument commands cannot change run or cwd through Worker proposals');
      }
      const validated = await fixedDefinition({...next, ...patch}, root);
      if (Object.hasOwn(patch, 'run')) next.run = validated.run;
      if (Object.hasOwn(patch, 'cwd')) next.cwd = validated.cwd;
    }
  }
  if (digest(original) === digest(next)) throw error('unchanged_definition', 'patch does not change the registered command');
  return {definition: next, scriptPreview};
}

async function proposeUpdate(commandId, params) {
  if (!COMMAND.test(commandId)) throw error('invalid_argument', 'invalid command ID');
  if (commandId.startsWith('builtin-')) throw error('builtin_immutable', 'built-in command definitions are immutable');
  if (params.size !== 1 || !params.has('patch')) {
    throw error('invalid_argument', 'propose.update accepts only patch=<encoded-json>');
  }
  const patch = parseUpdatePatch(params.get('patch'));
  const {selected, workspace} = await selectedConfig();
  const original = workspace.commands?.[commandId];
  if (!original) throw error('command_not_registered', 'update requires an existing registered command');
  const root = await realpath(selected.runtimeRoot ?? workspace.root);
  const {definition, scriptPreview} = await updatedDefinition(original, patch, root);
  const id = 'prop-' + randomUUID().replaceAll('-', '');
  const record = {version: 4, kind: 'update', id, commandId,
    workspaceIdentity: selected.workspaceIdentity,
    ...(selected.runtimeIdentity ? {runtimeIdentity: selected.runtimeIdentity} : {}),
    definition, scriptPreview,
    patch, previous: previousFields(original, patch), previousAllow: original.allow ?? null,
    expectedHash: digest(original), expiresAt: Date.now() + MAX_AGE};
  record.approvalDigest = digest([
    record.workspaceIdentity, record.commandId, record.definition, record.scriptPreview,
    record.expectedHash, record.previousAllow, record.kind, record.patch, record.previous,
    ...(record.runtimeIdentity ? [record.runtimeIdentity] : []),
  ]);
  if (Buffer.byteLength(JSON.stringify(record)) > 32_768) {
    throw error('invalid_definition', 'update proposal exceeds the bounded proposal size');
  }
  await mkdir(PROPOSALS, {recursive: true, mode: 0o700});
  await writeFile(path.join(PROPOSALS, id + '.json'), JSON.stringify(record) + '\n', {flag: 'wx', mode: 0o600});
  return {status: 'pending_approval', proposalId: id, commandId,
    proposalType: 'update', action: 'update', previous: record.previous,
    changes: patch, description: definition.description,
    argv: definition.run, cwd: definition.cwd ?? '.', allow: definition.allow ?? null,
    arguments: definition.arguments ?? {}, timeoutMs: definition.timeoutMs,
    maxOutputBytes: definition.maxOutputBytes, scriptPreview,
    approvalDigest: record.approvalDigest};
}

async function activate(id) {
  const record = await readProposal(id);
  const {selected, workspace} = await selectedConfig();
  if (selected.workspaceIdentity !== record.workspaceIdentity) throw error('workspace_identity_changed', 'proposal workspace has changed');
  if (record.runtimeIdentity && selected.runtimeIdentity !== record.runtimeIdentity) {
    throw error('workspace_identity_changed', 'proposal was created in a different worktree');
  }
  const root = await realpath(selected.runtimeRoot ?? workspace.root);
  const cwd = await realpath(path.join(root, record.definition.cwd ?? '.'));
  if (!within(root, cwd)) throw error('path_escape', 'candidate script directory escaped workspace');
  const existing = workspace.commands[record.commandId] ?? null;
  if ((existing ? digest(existing) : null) !== record.expectedHash) {
    throw error('stale_proposal', 'registered command changed since proposal');
  }
  if (record.version === 4 && record.kind === 'update') {
    // Recompute and revalidate the entire proposal from the registered definition.
    // A manipulated proposal cannot introduce unauthorized execution fields.
    if (!existing || digest(record.previous) !== digest(previousFields(existing, record.patch))) {
      throw error('stale_proposal', 'registered command changed since proposal');
    }
    let updated;
    try { updated = await updatedDefinition(existing, parseUpdatePatch(JSON.stringify(record.patch)), root); }
    catch { throw error('stale_proposal', 'update proposal no longer validates'); }
    if (digest(updated.definition) !== digest(record.definition)
      || digest(updated.scriptPreview) !== digest(record.scriptPreview)) {
      throw error('stale_proposal', 'update proposal does not match the reviewed command');
    }
  } else if (record.version === 3 && record.kind === 'fixed') {
    if (record.definition.scriptGuard !== undefined || record.scriptPreview !== null
      || digest(await fixedDefinition(record.definition, root)) !== digest(record.definition)) {
      throw error('stale_proposal', 'fixed proposal is invalid or was modified');
    }
  } else {
    const currentFingerprint = await scriptFingerprint(cwd, record.definition.scriptGuard.manager, record.definition.scriptGuard.script, root);
    if (currentFingerprint.fingerprint !== record.definition.scriptGuard.fingerprint) {
      throw error('stale_script_definition', 'package scripts changed before activation');
    }
  }
  const args = [existing ? 'update' : 'register', record.commandId, '--expected-workspace=' + selected.workspaceId];
  if (existing) args.push('expected=' + encode(record.expectedHash));
  args.push('definition=' + encode(JSON.stringify(record.definition)));
  return { ...runInterface(args), proposalId: id, approvalEnforcement: 'external-host-policy' };
}
async function main() {
  const [op, id, ...tokens] = process.argv.slice(2);
  if (op === 'context') {
    if (id !== undefined) throw error('invalid_argument', 'context takes no arguments');
    const selected = await current();
    return {status: 'ready', workspace: 'current', commandCount: selected.commands.length};
  }
  if (op === 'workspace.ensure') {
    if (id !== undefined) throw error('invalid_argument', 'workspace.ensure takes no arguments');
    return ensure();
  }
  if (op === 'workspace.worktrees.enable') {
    if (id !== undefined) throw error('invalid_argument', 'workspace.worktrees.enable takes no arguments');
    const selected = await current();
    return runInterface(['workspace-worktrees-enable', '--expected-workspace=' + selected.workspaceId]);
  }
  if (op === 'propose') return propose(id, safeParams(tokens));
  if (op === 'propose.update') return proposeUpdate(id, safeParams(tokens));
  if (op === 'activate') {
    if (tokens.length) throw error('invalid_argument', 'activate accepts one proposal ID');
    return activate(id);
  }
  if (!['list', 'describe', 'inspect', 'run', 'output'].includes(op)) throw error('usage', 'unknown worker interface operation');
  const selected = await current();
  const guard = '--expected-workspace=' + selected.workspaceId;
  if (op === 'list') {
    const params = id === undefined ? tokens : [id, ...tokens];
    return runInterface([op, guard, ...params]);
  }
  if (!id) throw error('invalid_argument', op + ' requires an exact ID');
  return runInterface([op, id, guard, ...tokens]);
}
try { emit(await main()); }
catch (e) { process.stderr.write(JSON.stringify({status:'error', error:{code:e.code ?? 'internal_error',message:e.message}})+'\n');process.exitCode=2; }
