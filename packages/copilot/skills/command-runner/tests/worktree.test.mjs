import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function invoke(fixture, cwd, script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(fixture.installed, script), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, COPILOT_HOME: fixture.home, ...env },
  });
}

function result(processResult) {
  return JSON.parse(processResult.stdout || processResult.stderr);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dandori-worktree-'));
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const home = path.join(root, 'home');
  const installed = path.join(home, 'skills/command-runner/scripts');
  await mkdir(installed, { recursive: true });
  await mkdir(path.join(home, 'command-runner'), { recursive: true });
  await mkdir(main, { recursive: true });
  git(root, 'init', '-b', 'main', main);
  git(main, 'config', 'user.name', 'Test');
  git(main, 'config', 'user.email', 'test@example.invalid');
  await mkdir(path.join(main, 'tools'));
  await writeFile(path.join(main, 'tools/echo.mjs'), 'process.stdout.write(process.cwd());\n');
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'initial');
  git(main, 'worktree', 'add', '-b', 'feature', linked);
  for (const name of ['runner.mjs', 'gateway.mjs', 'cli.mjs', 'hook.mjs', 'github-mcp-approval.mjs', 'builtins.mjs', 'script-guard.mjs']) {
    await writeFile(path.join(installed, name), await readFile(path.join(scripts, name)));
  }
  const configuration = {
    version: 1, defaults: { timeoutMs: 10000, maxOutputBytes: 16384 },
    workspaces: [{ id: 'app', root: main, commands: {
      probe: { description: 'Print the process working directory.', run: [process.execPath, 'tools/echo.mjs'], cwd: '.', arguments: {} },
      create: { description: 'Validate file targets within worktree.', run: [process.execPath, 'tools/echo.mjs'], cwd: '.',
        arguments: { output: {kind: 'positional', required: true,
          value: {type: 'workspace-file', extensions: ['.txt'], mustExist: false}}} },
    } }],
  };
  await writeFile(path.join(home, 'command-runner/workspaces.json'), JSON.stringify(configuration));
  return { root, main, linked, home, installed };
}

async function enable(f) {
  const r = invoke(f, f.main, 'cli.mjs', ['workspace.worktrees.enable']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(result(r).inheritWorktrees, true);
}

test('registered Git worktrees inherit command definitions without configuration changes', { skip: !gitAvailable }, async () => {
  const f = await fixture();
  try {
    const before = invoke(f, f.linked, 'runner.mjs', ['list']);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(result(before).runtimeRoot, f.linked);
    const configured = JSON.parse(await readFile(path.join(f.home, 'command-runner/workspaces.json'), 'utf8'));
    assert.equal(configured.workspaces.length, 1);
    assert.equal(configured.workspaces[0].inheritWorktrees, undefined);
    const origin = result(invoke(f, f.main, 'runner.mjs', ['list']));
    const derived = result(invoke(f, f.linked, 'runner.mjs', ['list']));
    assert.equal(derived.workspaceId, 'app');
    assert.equal(derived.registeredRoot, f.main);
    assert.equal(derived.runtimeRoot, f.linked);
    assert.equal(derived.workspaceIdentity, origin.workspaceIdentity);
    assert.notEqual(derived.runtimeIdentity, origin.runtimeIdentity);
    assert.deepEqual(derived.commands.map(v => v.id), origin.commands.map(v => v.id));
    const run = invoke(f, f.linked, 'cli.mjs', ['run', 'probe']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(result(run).stdoutPreview, f.linked);
    const output = invoke(f, f.linked, 'cli.mjs', ['output', result(run).executionId, 'stream=stdout']);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(result(output).data, f.linked);
    const cross = invoke(f, f.main, 'cli.mjs', ['output', result(run).executionId, 'stream=stdout']);
    assert.equal(cross.status, 2);
    assert.equal(result(cross).error.code, 'execution_not_found');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('worktree selection rejects unrelated clones, nested repos and path escape', { skip: !gitAvailable }, async () => {
  const f = await fixture();
  try {
    const copy = path.join(f.root, 'copy');
    git(f.root, 'clone', '--quiet', f.main, copy);
    assert.equal(result(invoke(f, copy, 'runner.mjs', ['list'])).error.code, 'workspace_not_registered');
    const nested = path.join(f.linked, 'nested');
    await mkdir(nested);
    git(nested, 'init', '-b', 'main');
    assert.equal(result(invoke(f, nested, 'runner.mjs', ['list'])).error.code, 'workspace_not_registered');
    const escaped = invoke(f, f.linked, 'cli.mjs', ['run', 'create', 'output=..%2Fmain%2Fx.txt']);
    assert.equal(escaped.status, 2);
    assert.equal(result(escaped).error.code, 'invalid_argument');
    await symlink(f.main, path.join(f.linked, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const throughLink = invoke(f, f.linked, 'cli.mjs', ['run', 'create', 'output=outside%2Fx.txt']);
    assert.equal(throughLink.status, 2);
    assert.equal(result(throughLink).error.code, 'invalid_argument');
    const injectedEnv = invoke(f, f.linked, 'runner.mjs', ['list'], { GIT_DIR: path.join(copy, '.git') });
    assert.equal(injectedEnv.status, 0, injectedEnv.stderr);
    assert.equal(result(injectedEnv).runtimeRoot, f.linked);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('approval proposals are tied to the exact worktree that created them', { skip: !gitAvailable }, async () => {
  const f = await fixture();
  try {
    const definition = {
      description: 'Inspect the working directory with the fixed Node script.',
      run: [process.execPath, 'tools/echo.mjs'], cwd: '.', arguments: {},
    };
    const proposed = invoke(f, f.linked, 'cli.mjs', ['propose', 'inspectcwd',
      'definition=' + encodeURIComponent(JSON.stringify(definition))]);
    assert.equal(proposed.status, 0, proposed.stderr);
    const proposalId = result(proposed).proposalId;
    const cross = invoke(f, f.main, 'cli.mjs', ['activate', proposalId]);
    assert.equal(cross.status, 2);
    assert.equal(result(cross).error.code, 'workspace_identity_changed');
    const approved = invoke(f, f.linked, 'cli.mjs', ['activate', proposalId]);
    assert.equal(approved.status, 0, approved.stderr);
    const config = JSON.parse(await readFile(path.join(f.home, 'command-runner/workspaces.json'), 'utf8'));
    assert.ok(config.workspaces[0].commands.inspectcwd);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('hook recognizes inherited worktrees without asking to register a new workspace', { skip: !gitAvailable }, async () => {
  const f = await fixture();
  try {
    const input = {
      tool_name: 'run_in_terminal',
      tool_input: { command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs workspace.ensure' },
    };
    const hook = spawnSync(process.execPath, [path.join(f.installed, 'hook.mjs')], {
      cwd: f.linked, encoding: 'utf8',
      env: { ...process.env, COPILOT_HOME: f.home }, input: JSON.stringify(input),
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(result(hook).permissionDecision, 'allow');
    const noRegistration = invoke(f, f.linked, 'cli.mjs', ['workspace.ensure']);
    assert.equal(noRegistration.status, 0, noRegistration.stderr);
    assert.equal(result(noRegistration).registered, false);
    const illegalEnable = invoke(f, f.linked, 'cli.mjs', ['workspace.worktrees.enable']);
    assert.equal(illegalEnable.status, 2);
    assert.equal(result(illegalEnable).error.code, 'workspace_scope_mismatch');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('legacy root-scoped proposals cannot be activated in a linked worktree', { skip: !gitAvailable }, async () => {
  const f = await fixture();
  try {
    const definition = {
      description: 'Inspect the working directory with the fixed Node script.',
      run: [process.execPath, 'tools/echo.mjs'], cwd: '.', arguments: {},
    };
    const proposed = invoke(f, f.main, 'cli.mjs', ['propose', 'legacycmd',
      'definition=' + encodeURIComponent(JSON.stringify(definition))]);
    assert.equal(proposed.status, 0, proposed.stderr);
    const proposalFile = path.join(f.home, 'command-runner/proposals', result(proposed).proposalId + '.json');
    const record = JSON.parse(await readFile(proposalFile, 'utf8'));
    delete record.runtimeIdentity;
    const subject = [record.workspaceIdentity, record.commandId, record.definition,
      record.scriptPreview, record.expectedHash, record.previousAllow, record.kind];
    const canonical = (value) => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
        : value;
    record.approvalDigest = 'sha256-' + createHash('sha256')
      .update(JSON.stringify(canonical(subject))).digest('hex');
    await writeFile(proposalFile, JSON.stringify(record));
    const linked = invoke(f, f.linked, 'cli.mjs', ['activate', record.id]);
    assert.equal(linked.status, 2);
    assert.equal(result(linked).error.code, 'workspace_identity_changed');
    const original = invoke(f, f.main, 'cli.mjs', ['activate', record.id]);
    assert.equal(original.status, 0, original.stderr);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a worktree nested inside its parent checkout uses its own runtime and output', { skip: !gitAvailable }, async () => {
  const f = await fixture();
  try {
    const nested = path.join(f.main, '.worktrees', 'nested-feature');
    await mkdir(path.dirname(nested), { recursive: true });
    git(f.main, 'worktree', 'add', '-b', 'nested-feature', nested);
    const before = invoke(f, nested, 'runner.mjs', ['list']);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(result(before).runtimeRoot, nested);

    const scope = invoke(f, nested, 'runner.mjs', ['list']);
    assert.equal(scope.status, 0, scope.stderr);
    assert.equal(result(scope).runtimeRoot, nested);
    assert.equal(result(scope).registeredRoot, f.main);
    const fromSubdirectory = invoke(f, path.join(nested, 'tools'), 'runner.mjs', ['list']);
    assert.equal(fromSubdirectory.status, 0, fromSubdirectory.stderr);
    assert.equal(result(fromSubdirectory).runtimeRoot, nested);

    const ran = invoke(f, nested, 'cli.mjs', ['run', 'probe']);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(result(ran).stdoutPreview, nested);
    const localOutput = invoke(f, nested, 'cli.mjs', ['output', result(ran).executionId, 'stream=stdout']);
    assert.equal(localOutput.status, 0, localOutput.stderr);
    assert.equal(result(localOutput).data, nested);
    const parentOutput = invoke(f, f.main, 'cli.mjs', ['output', result(ran).executionId, 'stream=stdout']);
    assert.equal(parentOutput.status, 2);
    assert.equal(result(parentOutput).error.code, 'execution_not_found');

    const unrelated = path.join(f.main, 'unrelated-repo');
    await mkdir(unrelated);
    git(unrelated, 'init', '-b', 'main');
    const notInherited = invoke(f, unrelated, 'runner.mjs', ['list']);
    assert.equal(notInherited.status, 2);
    assert.equal(result(notInherited).error.code, 'workspace_not_registered');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('only the exact registered checkout may authorize inheritance', { skip: !gitAvailable }, async () => {
  const f = await fixture();
  try {
    const child = path.join(f.main, 'tools');
    const rejected = invoke(f, child, 'cli.mjs', ['workspace.worktrees.enable']);
    assert.equal(rejected.status, 2);
    assert.equal(result(rejected).error.code, 'workspace_scope_mismatch');
    const config = JSON.parse(await readFile(path.join(f.home, 'command-runner/workspaces.json'), 'utf8'));
    assert.notEqual(config.workspaces[0].inheritWorktrees, true);
    const hook = spawnSync(process.execPath, [path.join(f.installed, 'hook.mjs')], {
      cwd: child, encoding: 'utf8',
      env: { ...process.env, COPILOT_HOME: f.home },
      input: JSON.stringify({
        tool_name: 'run_in_terminal',
        tool_input: { command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs workspace.worktrees.enable' },
      }),
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(result(hook).permissionDecision, 'deny');
    assert.match(result(hook).permissionDecisionReason, /exact registered repository root/);
    await enable(f);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('explicit false disables Git worktree inheritance until explicitly re-enabled', { skip: !gitAvailable }, async () => {
  const f = await fixture();
  try {
    const filename = path.join(f.home, 'command-runner/workspaces.json');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.workspaces[0].inheritWorktrees = false;
    await writeFile(filename, JSON.stringify(config));
    const blocked = invoke(f, f.linked, 'runner.mjs', ['list']);
    assert.equal(blocked.status, 2);
    assert.equal(result(blocked).error.code, 'workspace_not_registered');
    const parent = invoke(f, f.main, 'runner.mjs', ['list']);
    assert.equal(parent.status, 0, parent.stderr);

    const review = spawnSync(process.execPath, [path.join(f.installed, 'hook.mjs')], {
      cwd: f.main, encoding: 'utf8', env: { ...process.env, COPILOT_HOME: f.home },
      input: JSON.stringify({
        tool_name: 'run_in_terminal',
        tool_input: { command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs workspace.worktrees.enable' },
      }),
    });
    assert.equal(review.status, 0, review.stderr);
    assert.equal(result(review).permissionDecision, 'ask');
    await enable(f);
    const reenabled = invoke(f, f.linked, 'runner.mjs', ['list']);
    assert.equal(reenabled.status, 0, reenabled.stderr);
    assert.equal(result(reenabled).runtimeRoot, f.linked);
    const updated = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(updated.workspaces[0].inheritWorktrees, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
