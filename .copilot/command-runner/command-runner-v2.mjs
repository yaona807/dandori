#!/usr/bin/env node
// Registration-free worker facade. The legacy management API remains internal.
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { scriptFingerprint } from './script-guard.mjs';

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
const runCore = (args) => core('command-runner.mjs', args);
const runInterface = (args) => core('command-runner-interface.mjs', args);
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
  if (record.id !== id || record.version !== 1 || !COMMAND.test(record.commandId)
    || !Number.isFinite(record.expiresAt) || Date.now() > record.expiresAt
    || record.approvalDigest !== digest([record.workspaceIdentity, record.commandId, record.definition, record.expectedHash ?? null])) {
    throw error('stale_proposal', 'proposal is expired or was modified');
  }
  return record;
}
async function propose(commandId, params) {
  if (!COMMAND.test(commandId)) throw error('invalid_argument', 'invalid command ID');
  if ([...params.keys()].some(k => !['packageDir', 'script'].includes(k))) throw error('invalid_argument', 'only packageDir/script are supported');
  const {selected, workspace} = await selectedConfig();
  const packageDir = params.get('packageDir') ?? '.';
  if (!packageDir || path.isAbsolute(packageDir) || packageDir.includes('..') || packageDir.includes('\\')) {
    throw error('invalid_argument', 'packageDir must be a workspace-relative directory');
  }
  const dir = await realpath(path.resolve(workspace.root, packageDir));
  const root = await realpath(workspace.root);
  if (!within(root, dir)) throw error('path_escape', 'packageDir escapes workspace');
  const scriptName = params.get('script') ?? commandId;
  let selectedScript;
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
    try { selectedScript = { manager, ...(await scriptFingerprint(dir, manager, scriptName)) }; break; }
    catch { /* try known package-manager candidates; do not execute anything */ }
  }
  if (!selectedScript) throw error('script_not_discoverable', 'unable to identify a unique package script/manager');
  const definition = {
    description: 'Approved ' + selectedScript.manager + ' script: ' + commandId,
    run: [selectedScript.manager, 'run', scriptName, '--'],
    cwd: path.relative(root, dir) || '.', arguments: {},
    scriptGuard: {manager: selectedScript.manager, script: scriptName, fingerprint: selectedScript.fingerprint},
    timeoutMs: 300000, maxOutputBytes: 1048576,
  };
  const original = workspace.commands[commandId] ?? null;
  const id = 'prop-' + randomUUID().replaceAll('-', '');
  const record = { version: 1, id, commandId, workspaceIdentity: selected.workspaceIdentity,
    definition, expectedHash: original ? digest(original) : null,
    expiresAt: Date.now() + MAX_AGE,
  };
  record.approvalDigest = digest([record.workspaceIdentity, record.commandId, record.definition, record.expectedHash]);
  await mkdir(PROPOSALS, { recursive: true, mode: 0o700 });
  await writeFile(path.join(PROPOSALS, id + '.json'), JSON.stringify(record) + '\n', {flag: 'wx', mode: 0o600});
  return {status: 'pending_approval', proposalId: id, commandId, argv: definition.run, cwd: definition.cwd,
    arguments: definition.arguments, timeoutMs: definition.timeoutMs, scriptGuard: definition.scriptGuard,
    scripts: selectedScript.scripts, approvalDigest: record.approvalDigest,
    action: original ? 'update' : 'register'};
}
async function activate(id) {
  const record = await readProposal(id);
  const {selected, workspace} = await selectedConfig();
  if (selected.workspaceIdentity !== record.workspaceIdentity) throw error('workspace_identity_changed', 'proposal workspace has changed');
  const cwd = await realpath(path.join(workspace.root, record.definition.cwd));
  if (!within(await realpath(workspace.root), cwd)) throw error('path_escape', 'candidate script directory escaped workspace');
  const currentFingerprint = await scriptFingerprint(cwd, record.definition.scriptGuard.manager, record.definition.scriptGuard.script);
  if (currentFingerprint.fingerprint !== record.definition.scriptGuard.fingerprint) {
    throw error('stale_script_definition', 'package scripts changed before activation');
  }
  const existing = workspace.commands[record.commandId] ?? null;
  if ((existing ? digest(existing) : null) !== record.expectedHash) {
    throw error('stale_proposal', 'registered command changed since proposal');
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
  if (op === 'propose') return propose(id, safeParams(tokens));
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
