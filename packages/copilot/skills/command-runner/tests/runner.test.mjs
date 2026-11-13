import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  link,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// Keep the existing fixed test-suite inventory while exercising Git worktree inheritance.
import './worktree.test.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIRECTORY = path.join(SOURCE_DIRECTORY, '..', 'scripts');
const RUNNER_SOURCE = path.join(SCRIPT_DIRECTORY, 'runner.mjs');
const BUILTIN_SOURCE = path.join(SCRIPT_DIRECTORY, 'builtins.mjs');
const SCRIPT_GUARD_SOURCE = path.join(SCRIPT_DIRECTORY, 'script-guard.mjs');
const CLI_SOURCE = path.join(SCRIPT_DIRECTORY, 'cli.mjs');
const INTERFACE_SOURCE = path.join(SCRIPT_DIRECTORY, 'gateway.mjs');
const HOOK_SOURCE = path.join(SCRIPT_DIRECTORY, 'hook.mjs');
const GITHUB_APPROVAL_SOURCE = path.join(SCRIPT_DIRECTORY, 'github-mcp-approval.mjs');
const AGENT_SOURCES = ['Researcher', 'Writer'].map(name => path.join(SOURCE_DIRECTORY, '..', '..', '..', 'agents', `${name}.agent.md`));

async function makeFixture(configure = (configuration) => configuration) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-runner-test-'));
  const home = path.join(root, 'copilot-home');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');

  await mkdir(path.join(home, 'command-runner'), { recursive: true });
  await mkdir(path.join(home, 'skills', 'command-runner', 'scripts'), { recursive: true });
  await mkdir(path.join(home, 'agents'), { recursive: true });
  await mkdir(path.join(alpha, 'tests'), { recursive: true });
  await mkdir(beta, { recursive: true });

  await writeFile(
    path.join(home, 'skills', 'command-runner', 'scripts', 'runner.mjs'),
    await readFile(RUNNER_SOURCE),
  );
  await writeFile(
    path.join(home, 'skills', 'command-runner', 'scripts', 'builtins.mjs'),
    await readFile(BUILTIN_SOURCE),
  );
  await writeFile(path.join(home, 'skills', 'command-runner', 'scripts', 'script-guard.mjs'), await readFile(SCRIPT_GUARD_SOURCE));
  await writeFile(path.join(home, 'skills', 'command-runner', 'scripts', 'cli.mjs'), await readFile(CLI_SOURCE));
  await writeFile(
    path.join(home, 'skills', 'command-runner', 'scripts', 'gateway.mjs'),
    await readFile(INTERFACE_SOURCE),
  );
  await writeFile(
    path.join(home, 'skills', 'command-runner', 'scripts', 'hook.mjs'),
    await readFile(HOOK_SOURCE),
  );
  await writeFile(
    path.join(home, 'skills', 'command-runner', 'scripts', 'github-mcp-approval.mjs'),
    await readFile(GITHUB_APPROVAL_SOURCE),
  );
  for (const agentSource of AGENT_SOURCES) {
    await writeFile(path.join(home, 'agents', path.basename(agentSource)), await readFile(agentSource));
  }
  await writeFile(
    path.join(alpha, 'echo-args.mjs'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
  );
  await writeFile(
    path.join(beta, 'echo-args.mjs'),
    'process.stdout.write(JSON.stringify(["beta", ...process.argv.slice(2)]));\n',
  );
  await writeFile(
    path.join(alpha, 'sleep.mjs'),
    'setTimeout(() => process.stdout.write("done"), 500);\n',
  );
  await writeFile(
    path.join(alpha, 'stubborn-parent.mjs'),
    [
      "import { spawn } from 'node:child_process';",
      "spawn(process.execPath, ['stubborn-descendant.mjs'], { stdio: 'ignore' });",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(alpha, 'stubborn-descendant.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      "process.on('SIGTERM', () => {});",
      "setTimeout(() => writeFileSync('stubborn-survived.txt', 'survived'), 1500);",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(alpha, 'tests', 'sample.test.js'),
    'export {};\n',
  );

  const configuration = configure({
    version: 1,
    defaults: { timeoutMs: 10_000, maxOutputBytes: 16_384 },
    workspaces: [
      {
        id: 'alpha',
        root: alpha,
        commands: {
          sample: {
            description: 'Echo validated arguments.',
            run: [process.execPath, 'echo-args.mjs', '--'],
            cwd: '.',
            arguments: {
              enabled: { kind: 'flag', token: '--enabled' },
              count: {
                kind: 'option',
                token: '--count',
                value: { type: 'integer', min: 1, max: 8 },
              },
              mode: {
                kind: 'option',
                token: '--mode',
                value: { type: 'choice', values: ['fast', 'safe'] },
              },
              file: {
                kind: 'positional',
                value: {
                  type: 'workspace-file',
                  extensions: ['.test.js'],
                  mustExist: true,
                },
              },
              text: {
                kind: 'positional',
                value: { type: 'string', maxLength: 100 },
              },
            },
          },
          create: {
            description: 'Echo a validated non-existing output path.',
            run: [process.execPath, 'echo-args.mjs', '--'],
            cwd: '.',
            arguments: {
              output: {
                kind: 'positional',
                required: true,
                value: {
                  type: 'workspace-file',
                  extensions: ['.txt'],
                  mustExist: false,
                },
              },
            },
          },
          timeout: {
            description: 'Exercise timeout reporting.',
            run: [process.execPath, 'sleep.mjs'],
            cwd: '.',
            timeoutMs: 25,
            arguments: {},
          },
          'tree-timeout': {
            description: 'Exercise process-group timeout termination.',
            run: [process.execPath, 'stubborn-parent.mjs'],
            cwd: '.',
            timeoutMs: 100,
            arguments: {},
          },
        },
      },
      {
        id: 'beta',
        root: beta,
        commands: {
          beta: {
            description: 'Run only in beta.',
            run: [process.execPath, 'echo-args.mjs'],
            cwd: '.',
            arguments: {},
          },
        },
      },
    ],
  });

  await writeFile(
    path.join(home, 'command-runner', 'workspaces.json'),
    `${JSON.stringify(configuration, null, 2)}\n`,
  );
  return { root, home, alpha, beta };
}

function digest(value) {
  const canonical = (v) => Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])]))
      : v;
  return `sha256-${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function executionHash(command, defaults = {}) {
  const { description: _description, ...executableCommand } = command;
  return digest({
    ...executableCommand,
    timeoutMs: command.timeoutMs ?? defaults.timeoutMs ?? 300_000,
    maxOutputBytes: command.maxOutputBytes ?? defaults.maxOutputBytes ?? 1_048_576,
  });
}

function guarded(fixture, cwd, args) {
  if (args[0] !== 'run' || args[3]?.startsWith('--expected-identity=')) return args;
  const expectedId = args[2]?.startsWith('--expected-workspace=')
    ? args[2].slice('--expected-workspace='.length) : 'alpha';
  const config = JSON.parse(readFileSync(path.join(fixture.home, 'command-runner', 'workspaces.json'), 'utf8'));
  const workspace = config.workspaces.find((w) => w.id === expectedId);
  const identity = digest([expectedId, realpathSync(workspace.root), workspace.registrationId ?? null]);
  const definition = executionHash(workspace.commands[args[1]] ?? {}, config.defaults);
  const remaining = args[2]?.startsWith('--expected-workspace=') ? args.slice(3) : args.slice(2);
  return [args[0], args[1], `--expected-workspace=${expectedId}`,
    `--expected-identity=${identity}`, `--expected-definition=${definition}`, ...remaining];
}

function runRunner(fixture, cwd, args) {
  const guardedArgs = guarded(fixture, cwd, args);
  return spawnSync(
    process.execPath,
    [path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'runner.mjs'), ...guardedArgs],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, COPILOT_HOME: fixture.home },
    },
  );
}

function runRunnerWithoutHashes(fixture, cwd, args) {
  return spawnSync(
    process.execPath,
    [path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'runner.mjs'), ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, COPILOT_HOME: fixture.home } },
  );
}

function runInterface(fixture, cwd, args) {
  const scoped = new Set(['list', 'describe', 'inspect', 'register', 'update', 'unregister', 'output']);
  let scopedArgs = args;
  if (scoped.has(args[0])) {
    const index = args[0] === 'list' ? 1 : 2;
    if (!args[index]?.startsWith('--expected-workspace=')) {
      const configuration = JSON.parse(readFileSync(path.join(fixture.home, 'command-runner', 'workspaces.json'), 'utf8'));
      const selectedCwd = realpathSync(cwd);
      const selected = configuration.workspaces.find((workspace) => {
        const root = realpathSync(workspace.root);
        return selectedCwd === root || selectedCwd.startsWith(`${root}${path.sep}`);
      });
      scopedArgs = [...args.slice(0, index), `--expected-workspace=${selected?.id ?? 'alpha'}`, ...args.slice(index)];
    }
  }
  const guardedArgs = guarded(fixture, cwd, scopedArgs);
  return spawnSync(
    process.execPath,
    [path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'gateway.mjs'), ...guardedArgs],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, COPILOT_HOME: fixture.home },
    },
  );
}

function runHook(fixture, input, envOverrides = {}) {
  return spawnSync(
    process.execPath,
    [path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'hook.mjs')],
    {
      cwd: fixture.alpha,
      encoding: 'utf8',
      env: { ...process.env, COPILOT_HOME: fixture.home, ...envOverrides },
      input: JSON.stringify(input),
    },
  );
}

async function withFixture(callback, configure) {
  const fixture = await makeFixture(configure);
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test('distributed Researcher and Writer share the fixed runner CLI hook', async () => {
  for (const agentSource of AGENT_SOURCES) {
    const source = await readFile(agentSource, 'utf8');
    assert.match(source, /^user-invocable: false$/mu);
    assert.match(source, /^disable-model-invocation: true$/mu);
    assert.match(source, /  - execute\/runInTerminal\n  - execute\n(?:  - browser\/readPage\n  - browser\/screenshotPage\n)?(?:  - github\/[a-z_]+\n)+agents: \[\]\nhooks:/u);
    assert.match(source, /hook\.mjs/u);
    assert.match(source, /node ~\/\.copilot\/skills\/command-runner\/scripts\/cli\.mjs/u);
    assert.match(source, /request synchronous execution/u);
    assert.match(source, /omit the terminal `timeout` option/u);
    assert.match(source, /Do not execute raw project commands/u);
    assert.doesNotMatch(source, /\b(?:DANDORI|Orchestrator|Task Card|TFR|TFC|Flow Ledger)\b/u);
  }
});

test('list exposes commands only for the current workspace', async () => {
  await withFixture(async (fixture) => {
    const alpha = runRunner(fixture, fixture.alpha, ['list']);
    assert.equal(alpha.status, 0, alpha.stderr);
    const alphaOutput = JSON.parse(alpha.stdout);
    assert.equal(alphaOutput.workspaceId, 'alpha');
    assert.deepEqual(
      alphaOutput.commands.filter(({ id }) => !id.startsWith('builtin-')).map(({ id }) => id),
      ['sample', 'create', 'timeout', 'tree-timeout'],
    );
    assert.equal('run' in alphaOutput.commands[0], false);

    const beta = runRunner(fixture, fixture.beta, ['list']);
    assert.equal(beta.status, 0, beta.stderr);
    const betaOutput = JSON.parse(beta.stdout);
    assert.equal(betaOutput.workspaceId, 'beta');
    assert.deepEqual(betaOutput.commands.filter(({ id }) => !id.startsWith('builtin-')).map(({ id }) => id), ['beta']);
  });
});

test('filtered command misses do not imply absence from selected workspace', async () => {
  await withFixture(async (fixture) => {
    const filtered = runInterface(fixture, fixture.alpha, ['list', 'query=nonexistent-term']);
    assert.equal(filtered.status, 0, filtered.stderr);
    const filteredResult = JSON.parse(filtered.stdout);
    assert.equal(filteredResult.workspaceId, 'alpha');
    assert.equal(filteredResult.total, 0);
    assert.deepEqual(filteredResult.commandIds, []);
    assert.equal(filteredResult.nextOffset, null);

    const unfiltered = runInterface(fixture, fixture.alpha, ['list']);
    assert.equal(unfiltered.status, 0, unfiltered.stderr);
    const unfilteredResult = JSON.parse(unfiltered.stdout);
    assert.equal(unfilteredResult.workspaceId, 'alpha');
    assert.ok(unfilteredResult.total > 0);
    assert.ok(unfilteredResult.commandIds.includes('sample'));

    const exact = runInterface(fixture, fixture.alpha, ['describe', 'sample']);
    assert.equal(exact.status, 0, exact.stderr);
    assert.equal(JSON.parse(exact.stdout).command.id, 'sample');

    const wrongWorkspace = runInterface(fixture, fixture.beta, ['describe', 'sample']);
    assert.equal(wrongWorkspace.status, 2);
    assert.match(wrongWorkspace.stderr, /command is not registered for workspace beta: sample/u);
    const inBeta = runInterface(fixture, fixture.beta, ['list', 'query=beta']);
    assert.equal(inBeta.status, 0, inBeta.stderr);
    assert.deepEqual(JSON.parse(inBeta.stdout).commandIds, ['beta']);
  });
});

test('delegated workspace assertion gates command discovery without requiring cwd inspection by the worker', async () => {
  await withFixture(async (fixture) => {
    const accepted = runInterface(fixture, fixture.alpha, ['list', '--expected-workspace=alpha']);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).workspaceId, 'alpha');

    for (const args of [
      ['list', '--expected-workspace=alpha'],
      ['describe', 'beta', '--expected-workspace=alpha'],
      ['output', '20260829T010203.004Z_00000000-0000-4000-8000-000000000000', '--expected-workspace=alpha', 'stream=stdout'],
    ]) {
      const result = runInterface(fixture, fixture.beta, args);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error.code, 'workspace_scope_mismatch');
      assert.doesNotMatch(result.stderr, /commandIds|arguments|definitionHash|beta/u);
    }

    const withoutScope = spawnSync(process.execPath, [
      path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'gateway.mjs'), 'list',
    ], { cwd: fixture.alpha, encoding: 'utf8', env: { ...process.env, COPILOT_HOME: fixture.home } });
    assert.equal(withoutScope.status, 2);
    assert.equal(JSON.parse(withoutScope.stderr).error.code, 'invalid_argument');
    assert.equal(withoutScope.stdout, '');
  });
});

test('command beyond first page remains discoverable in the selected workspace', async () => {
  await withFixture(async (fixture) => {
    const first = runInterface(fixture, fixture.alpha, ['list']);
    assert.equal(first.status, 0, first.stderr);
    const start = JSON.parse(first.stdout);
    assert.equal(start.workspaceId, 'alpha');
    assert.equal(start.commandIds.length, 100);
    assert.ok(start.total > 100);
    assert.equal(start.commandIds.includes('zz-last-command'), false);
    assert.ok(Number.isInteger(start.nextOffset));

    const second = runInterface(fixture, fixture.alpha, ['list', `offset=${start.nextOffset}`, `revision=${start.revision}`]);
    assert.equal(second.status, 0, second.stderr);
    const last = JSON.parse(second.stdout);
    assert.equal(last.workspaceId, 'alpha');
    assert.equal(last.nextOffset, null);
    assert.ok(last.commandIds.includes('zz-last-command'));
    assert.equal(start.commandIds.length + last.commandIds.length, start.total);

    const search = runInterface(fixture, fixture.alpha, ['list', 'query=LAST%20COMMAND']);
    assert.equal(search.status, 0, search.stderr);
    const matching = JSON.parse(search.stdout);
    assert.equal(matching.workspaceId, 'alpha');
    assert.deepEqual(matching.commandIds, ['zz-last-command']);
    assert.equal(matching.nextOffset, null);
    assert.equal(matching.total, 1);
  }, (configuration) => {
    const commands = configuration.workspaces[0].commands;
    for (let i = 0; i < 108; i += 1) {
      commands[`batch-${String(i).padStart(3, '0')}`] = {
        description: 'Batch command for paginated discovery.',
        run: [process.execPath, 'echo-args.mjs'],
        cwd: '.',
        arguments: {},
      };
    }
    commands['zz-last-command'] = {
      description: 'Last command for specific search.',
      run: [process.execPath, 'echo-args.mjs'],
      cwd: '.',
      arguments: {},
    };
    return configuration;
  });
});

test('unregistered workspace fails closed', async () => {
  await withFixture(async (fixture) => {
    const outside = path.join(fixture.root, 'outside');
    await mkdir(outside);
    const result = runRunner(fixture, outside, ['list']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /workspace is not registered/u);
  });
});

test('empty workspace collection is valid and runtime selection still fails closed', async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      path.join(fixture.home, 'command-runner', 'workspaces.json'),
      `${JSON.stringify({
        version: 1,
        defaults: { timeoutMs: 10_000, maxOutputBytes: 16_384 },
        workspaces: [],
      }, null, 2)}\n`,
    );
    const result = runRunner(fixture, fixture.alpha, ['list']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /workspace is not registered/u);
    assert.doesNotMatch(result.stderr, /non-empty array/u);
  });
});

test('registered workspace may have an empty command map', async () => {
  await withFixture(async (fixture) => {
    const result = runRunner(fixture, fixture.alpha, ['list']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).commands.filter(({ id }) => !id.startsWith('builtin-')), []);
  }, (configuration) => {
    configuration.workspaces[0].commands = {};
    return configuration;
  });
});

test('symlinked working-directory alias selects the registered real workspace', async (t) => {
  await withFixture(async (fixture) => {
    const alias = path.join(fixture.root, 'alpha-alias');
    try {
      await symlink(fixture.alpha, alias, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip('directory symlink creation unavailable');
        return;
      }
      throw error;
    }

    const listed = runRunner(fixture, alias, ['list']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).workspaceId, 'alpha');

    const publicList = runInterface(fixture, alias, ['list']);
    assert.equal(publicList.status, 0, publicList.stderr);
    assert.equal(JSON.parse(publicList.stdout).workspaceId, 'alpha');

    const executed = runRunner(fixture, alias, [
      'run', 'sample', 'file=tests%2Fsample.test.js',
    ]);
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).workspaceId, 'alpha');
  });
});

test('configured symlink workspace root is canonicalized, and removing that resolution fails', async (t) => {
  await withFixture(async (fixture) => {
    const alias = path.join(fixture.root, 'configured-alpha-alias');
    try {
      await symlink(fixture.alpha, alias, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip('directory symlink creation unavailable');
        return;
      }
      throw error;
    }

    const configPath = path.join(fixture.home, 'command-runner', 'workspaces.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.workspaces[0].root = alias;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    // The physical cwd cannot match a symlink-spelled root by string comparison.
    const normal = runRunner(fixture, fixture.alpha, ['list']);
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(JSON.parse(normal.stdout).workspaceId, 'alpha');

    // Mutate only the throwaway fixture, never repository sources. Without root
    // canonicalization this same case must fail, proving the test detects regressions.
    const corePath = path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'runner.mjs');
    const core = await readFile(corePath, 'utf8');
    const canonicalization = 'canonical = await realpath(value);';
    assert.equal(core.split(canonicalization).length, 2);
    await writeFile(corePath, core.replace(canonicalization, 'canonical = path.resolve(value);'));

    const broken = runRunner(fixture, fixture.alpha, ['list']);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /workspace is not registered/u);
  });
});

test('workspace registration from symlink alias saves one canonical root', async (t) => {
  await withFixture(async (fixture) => {
    const actual = path.join(fixture.root, 'gamma');
    const alias = path.join(fixture.root, 'gamma-alias');
    await mkdir(actual);
    try {
      await symlink(actual, alias, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip('directory symlink creation unavailable');
        return;
      }
      throw error;
    }

    const registered = runInterface(fixture, alias, ['workspace-register', 'gamma']);
    assert.equal(registered.status, 0, registered.stderr);
    const result = JSON.parse(registered.stdout);
    assert.equal(result.workspaceId, 'gamma');
    assert.equal(result.root, await realpath(actual));

    const direct = runInterface(fixture, actual, ['list']);
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(JSON.parse(direct.stdout).workspaceId, 'gamma');

    const duplicate = runInterface(fixture, alias, ['workspace-register', 'other_gamma']);
    assert.equal(duplicate.status, 2);
    assert.match(duplicate.stderr, /workspace_overlap/u);

    const configured = JSON.parse(await readFile(
      path.join(fixture.home, 'command-runner', 'workspaces.json'),
      'utf8',
    ));
    assert.equal(configured.workspaces.filter((item) => item.root === result.root).length, 1);
  });
});

test('deepest registered root wins for nested workspaces', async () => {
  await withFixture(async (fixture) => {
    const nested = path.join(fixture.alpha, 'nested');
    await mkdir(nested);
    await writeFile(
      path.join(nested, 'echo-args.mjs'),
      'process.stdout.write("nested");\n',
    );
    const configPath = path.join(
      fixture.home,
      'command-runner',
      'workspaces.json',
    );
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.workspaces.push({
      id: 'nested',
      root: nested,
      commands: {
        nested: {
          description: 'Nested command.',
          run: [process.execPath, 'echo-args.mjs'],
          cwd: '.',
          arguments: {},
        },
      },
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const result = runRunner(fixture, nested, ['list']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).workspaceId, 'nested');
  });
});

test('core denies a mismatched expected workspace before command side effects', async () => {
  await withFixture(async (fixture) => {
    const actual = runRunner(fixture, fixture.beta, [
      'run', 'sample', '--expected-workspace=alpha',
    ]);
    assert.equal(actual.status, 2);
    assert.match(actual.stderr, /command is not registered|workspace.*differs/u);

    const configPath = path.join(fixture.home, 'command-runner', 'workspaces.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.workspaces[1].commands.sample = {
      description: 'Beta writes a detectable file.',
      run: [process.execPath, '-e', "require('fs').writeFileSync('wrong-workspace.txt','unexpected')"],
      cwd: '.',
      arguments: {},
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const mismatch = runRunner(fixture, fixture.beta, [
      'run', 'sample', '--expected-workspace=alpha',
    ]);
    assert.equal(mismatch.status, 2);
    assert.match(mismatch.stderr, /workspace_scope_mismatch/u);
    await assert.rejects(readFile(path.join(fixture.beta, 'wrong-workspace.txt')), { code: 'ENOENT' });
  });
});

test('workspace identity and executable changes are guarded but metadata changes are allowed', async () => {
  await withFixture(async (fixture) => {
    const configPath = path.join(fixture.home, 'command-runner', 'workspaces.json');
    const initial = JSON.parse(readFileSync(configPath, 'utf8'));
    const command = structuredClone(initial.workspaces[0].commands.sample);
    const originalIdentity = digest(['alpha', realpathSync(fixture.alpha), null]);
    const expectedDefinition = executionHash(command, initial.defaults);
    const bound = ['run', 'sample', '--expected-workspace=alpha',
      `--expected-identity=${originalIdentity}`, `--expected-definition=${expectedDefinition}`];
    initial.workspaces[0].registrationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`);
    const reused = runRunner(fixture, fixture.alpha, bound);
    assert.equal(reused.status, 2);
    assert.match(reused.stderr, /workspace_identity_changed/u);

    initial.workspaces[0].registrationId = undefined;
    initial.workspaces[0].commands.sample.description = 'Changed after discovery';
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`);
    const descriptionOnly = runRunner(fixture, fixture.alpha, bound);
    assert.equal(descriptionOnly.status, 0, descriptionOnly.stderr);
    initial.workspaces[0].commands.sample.run = [process.execPath, 'echo-args.mjs', '--modified'];
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`);
    const changed = runRunner(fixture, fixture.alpha, bound);
    assert.equal(changed.status, 2);
    assert.match(changed.stderr, /stale_definition/u);
    initial.workspaces[0].commands.sample = command;
    initial.defaults.timeoutMs = (initial.defaults.timeoutMs ?? 300_000) + 1;
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`);
    const inherited = runRunner(fixture, fixture.alpha, bound);
    assert.equal(inherited.status, 2);
    assert.match(inherited.stderr, /stale_definition/u);
    initial.defaults.timeoutMs -= 1;
    initial.defaults.maxOutputBytes = (initial.defaults.maxOutputBytes ?? 1_048_576) + 1;
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`);
    const outputDefault = runRunner(fixture, fixture.alpha, bound);
    assert.equal(outputDefault.status, 2);
    assert.match(outputDefault.stderr, /stale_definition/u);
  });
});

test('run needs only a selected workspace guard and resolves the current registered command', async () => {
  await withFixture(async (fixture) => {
    const invoke = (args, cwd = fixture.alpha) => runRunnerWithoutHashes(fixture, cwd, [
      'run', 'sample', '--expected-workspace=alpha', ...args,
    ]);
    const first = invoke(['text=before']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /before/u);

    const configPath = path.join(fixture.home, 'command-runner', 'workspaces.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.workspaces[0].commands.sample.run = [process.execPath, 'echo-args.mjs', '--updated'];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const updated = invoke(['text=after']);
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /--updated/u);
    assert.match(updated.stdout, /after/u);

    const wrongWorkspace = invoke([], fixture.beta);
    assert.equal(wrongWorkspace.status, 2);
    assert.match(wrongWorkspace.stderr, /workspace_scope_mismatch/u);

    const unknown = runRunnerWithoutHashes(fixture, fixture.alpha, [
      'run', 'absent', '--expected-workspace=alpha',
    ]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /command_not_registered/u);

    const invalidArgument = invoke(['not-registered=value']);
    assert.equal(invalidArgument.status, 2);
    assert.match(invalidArgument.stderr, /invalid_argument/u);

    const halfLegacy = invoke(['--expected-identity=sha256-' + 'a'.repeat(64)]);
    assert.equal(halfLegacy.status, 2);
    assert.match(halfLegacy.stderr, /invalid_argument/u);
  });
});

test('run builds deterministic argv and reports normalized execution metadata', async () => {
  await withFixture(async (fixture) => {
    const result = runRunner(fixture, fixture.alpha, [
      'run',
      'sample',
      'text=hello%20world',
      'file=tests%2Fsample.test.js',
      'mode=safe',
      'count=4',
      'enabled=true',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.workspaceId, 'alpha');
    assert.equal(output.commandId, 'sample');
    assert.equal(output.cwd, '.');
    assert.equal(output.timedOut, false);
    assert.equal(output.outputTruncated, false);
    assert.deepEqual(output.arguments, {
      enabled: true,
      count: '4',
      mode: 'safe',
      file: 'tests/sample.test.js',
      text: 'hello world',
    });
    assert.deepEqual(JSON.parse(output.stdout), [
      '--',
      '--enabled',
      '--count',
      '4',
      '--mode',
      'safe',
      'tests/sample.test.js',
      'hello world',
    ]);
  });
});

test('shell-looking string stays one argv value', async () => {
  await withFixture(async (fixture) => {
    const result = runRunner(
      fixture,
      fixture.alpha,
      ['run', 'sample', 'text=%24%28touch%20owned%29'],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(JSON.parse(result.stdout).stdout),
      ['--', '$(touch owned)'],
    );
  });
});

test('unknown arguments and out-of-range values are denied', async () => {
  await withFixture(async (fixture) => {
    const unknown = runRunner(
      fixture,
      fixture.alpha,
      ['run', 'sample', 'other=value'],
    );
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unregistered parameter/u);

    const range = runRunner(
      fixture,
      fixture.alpha,
      ['run', 'sample', 'count=99'],
    );
    assert.equal(range.status, 2);
    assert.match(range.stderr, /must be between 1 and 8/u);
  });
});

test('positional values beginning with a hyphen are denied', async () => {
  await withFixture(async (fixture) => {
    const result = runRunner(
      fixture,
      fixture.alpha,
      ['run', 'sample', 'text=-danger'],
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must not start with '-'/u);
  });
});

test('workspace traversal and existing symlink escapes are denied', async (t) => {
  await withFixture(async (fixture) => {
    const traversal = runRunner(
      fixture,
      fixture.alpha,
      ['run', 'sample', 'file=..%2Foutside.test.js'],
    );
    assert.equal(traversal.status, 2);
    assert.match(traversal.stderr, /escapes the workspace root/u);

    const target = path.join(fixture.alpha, 'tests', 'secret.txt');
    const alias = path.join(fixture.alpha, 'tests', 'alias.test.js');
    await writeFile(target, 'secret\n');
    try {
      await symlink(target, alias);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation unavailable');
        return;
      }
      throw error;
    }

    const disguised = runRunner(
      fixture,
      fixture.alpha,
      ['run', 'sample', 'file=tests%2Falias.test.js'],
    );
    assert.equal(disguised.status, 2);
    assert.match(disguised.stderr, /disallowed extension/u);

    const outside = path.join(fixture.root, 'outside.test.js');
    await writeFile(outside, 'export {};\n');
    await symlink(
      outside,
      path.join(fixture.alpha, 'tests', 'linked.test.js'),
    );
    const escaped = runRunner(
      fixture,
      fixture.alpha,
      ['run', 'sample', 'file=tests%2Flinked.test.js'],
    );
    assert.equal(escaped.status, 2);
    assert.match(escaped.stderr, /resolves outside the workspace root/u);
  });
});

test('non-existing paths below an escaping symlink ancestor are denied', async (t) => {
  await withFixture(async (fixture) => {
    const outside = path.join(fixture.root, 'outside-directory');
    const link = path.join(fixture.alpha, 'linked-directory');
    await mkdir(outside);
    try {
      await symlink(outside, link, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('directory symlink creation unavailable');
        return;
      }
      throw error;
    }

    const result = runRunner(
      fixture,
      fixture.alpha,
      ['run', 'create', 'output=linked-directory%2Fnew.txt'],
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /resolves outside the workspace root/u);
  });
});

test('duplicate configuration keys fail closed', async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      path.join(fixture.home, 'command-runner', 'workspaces.json'),
      '{"version":1,"version":1,"workspaces":[]}',
    );
    const result = runRunner(fixture, fixture.alpha, ['list']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /duplicate key/u);
  });
});

test('dynamic arguments cannot be attached to known inline-code forms', async () => {
  await withFixture(async (fixture) => {
    const result = runRunner(fixture, fixture.alpha, ['list']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /inline-code execution form/u);
  }, (configuration) => {
    configuration.workspaces[0].commands.sample.run = [
      'node',
      '-e',
      'console.log(process.argv[1])',
    ];
    return configuration;
  });
});

test('timeout is reported separately from exit and signal state', async () => {
  await withFixture(async (fixture) => {
    const result = runRunner(fixture, fixture.alpha, ['run', 'timeout']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'failed');
    assert.equal(output.timedOut, true);
    assert.equal(output.outputTruncated, false);
    assert.notEqual(output.signal, null);
  });
});

test('timeout terminates stubborn descendants in the command process group', async () => {
  await withFixture(async (fixture) => {
    const result = runRunner(fixture, fixture.alpha, ['run', 'tree-timeout']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'failed');
    assert.equal(output.timedOut, true);
    assert.notEqual(output.signal, null);

    await new Promise((resolve) => setTimeout(resolve, 600));
    await assert.rejects(
      readFile(path.join(fixture.alpha, 'stubborn-survived.txt')),
      { code: 'ENOENT' },
    );
  });
});

test('hook permits canonical bounded-interface calls and denies direct core or compound commands', async () => {
  await withFixture(async (fixture) => {
    const allowed = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      cwd: fixture.alpha,
      tool_name: 'execute/runInTerminal',
      tool_input: {
        command: 'node ~/.copilot/skills/command-runner/scripts/gateway.mjs run sample --expected-workspace=alpha --expected-identity=sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --expected-definition=sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb count=4',
      },
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(
      JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision,
      'allow',
    );

    const hashFree = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      cwd: fixture.alpha,
      tool_name: 'execute/runInTerminal',
      tool_input: {
        command: 'node ~/.copilot/skills/command-runner/scripts/gateway.mjs run sample --expected-workspace=alpha count=4',
      },
    });
    assert.equal(hashFree.status, 0, hashFree.stderr);
    assert.equal(JSON.parse(hashFree.stdout).hookSpecificOutput.permissionDecision, 'allow');

    for (const partial of [
      '--expected-identity=sha256-' + 'a'.repeat(64),
      '--expected-definition=sha256-' + 'b'.repeat(64),
    ]) {
      const blocked = runHook(fixture, {
        hook_event_name: 'PreToolUse',
        cwd: fixture.alpha,
        tool_name: 'execute/runInTerminal',
        tool_input: {
          command: `node ~/.copilot/skills/command-runner/scripts/gateway.mjs run sample --expected-workspace=alpha ${partial}`,
        },
      });
      assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }

    const directCore = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      cwd: fixture.alpha,
      tool_name: 'execute/runInTerminal',
      tool_input: { command: 'node ~/.copilot/skills/command-runner/scripts/runner.mjs list' },
    });
    assert.equal(
      JSON.parse(directCore.stdout).hookSpecificOutput.permissionDecision,
      'deny',
    );

    const raw = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      cwd: fixture.alpha,
      tool_name: 'execute/runInTerminal',
      tool_input: { command: 'npm test' },
    });
    assert.equal(
      JSON.parse(raw.stdout).hookSpecificOutput.permissionDecision,
      'deny',
    );

    const compound = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      cwd: fixture.alpha,
      tool_name: 'execute/runInTerminal',
      tool_input: {
        command:
          'node ~/.copilot/skills/command-runner/scripts/gateway.mjs list && npm publish',
      },
    });
    assert.equal(
      JSON.parse(compound.stdout).hookSpecificOutput.permissionDecision,
      'deny',
    );
  });
});

test('hook applies the same fixed-interface policy to the Copilot harness tool envelope', async () => {
  await withFixture(async (fixture) => {
    const accepted = 'node ~/.copilot/skills/command-runner/scripts/gateway.mjs list --expected-workspace=alpha';
    for (const [toolName, args] of [
      ['Bash', { command: accepted }],
      ['bash', { command: accepted }],
      ['powershell', { command: accepted }],
    ]) {
      const result = runHook(fixture, {
        hook_event_name: 'PreToolUse',
        cwd: fixture.alpha,
        tool_name: toolName,
        tool_input: args,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).permissionDecision, 'allow');
    }

    const unsafe = runHook(fixture, {
      sessionId: 'copilot-session',
      toolName: 'bash',
      toolArgs: JSON.stringify({ command: `${accepted} && npm publish` }),
    });
    assert.equal(unsafe.status, 0, unsafe.stderr);
    assert.equal(JSON.parse(unsafe.stdout).permissionDecision, 'deny');

    const raw = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    assert.equal(JSON.parse(raw.stdout).permissionDecision, 'deny');

    const protectedWrite = runHook(fixture, {
      toolName: 'Edit',
      toolArgs: { path: '~/.copilot/command-runner/workspaces.json', content: '{}' },
    });
    assert.equal(JSON.parse(protectedWrite.stdout).permissionDecision, 'deny');
  });
});

test('hook validates actual Local and Copilot terminal aliases instead of rejecting the fixed runner', async () => {
  await withFixture(async (fixture) => {
    const accepted = 'node ~/.copilot/skills/command-runner/scripts/gateway.mjs list --expected-workspace=alpha';
    const localEnvelopes = [
      (command) => ({
        hook_event_name: 'PreToolUse',
        tool_name: 'execute',
        tool_input: { command },
      }),
      (command) => ({
        sessionId: 'local-session',
        toolName: 'terminal/execute',
        toolArgs: JSON.stringify({ command }),
      }),
      (command) => ({
        hook_event_name: 'PreToolUse',
        tool_name: 'run_in_terminal',
        tool_input: { command },
      }),
      (command) => ({
        sessionId: 'copilot-session',
        toolName: 'run_in_terminal',
        toolArgs: JSON.stringify({ command }),
      }),
    ];

    for (const envelope of localEnvelopes) {
      const allowed = runHook(fixture, envelope(accepted));
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal(JSON.parse(allowed.stdout).permissionDecision, 'allow');
      assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, 'allow');

      for (const command of ['npm test', `${accepted} && npm publish`]) {
        const denied = runHook(fixture, envelope(command));
        assert.equal(denied.status, 0, denied.stderr);
        assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
      }
    }

    for (const name of ['execute', 'run_in_terminal']) {
      const overridden = runHook(fixture, {
        tool_name: name,
        tool_input: { command: accepted, cwd: fixture.beta },
      });
      assert.equal(JSON.parse(overridden.stdout).permissionDecision, 'deny');
    }

    const vscodeSync = runHook(fixture, {
      tool_name: 'run_in_terminal',
      tool_input: { command: accepted, mode: 'sync', explanation: 'Inspect registered commands', goal: 'Read command list' },
    });
    assert.equal(JSON.parse(vscodeSync.stdout).permissionDecision, 'allow');

    // Reproduce the observed CLI inspect call under both Local and Copilot hook envelopes.
    const cliInspect = 'node ~/.copilot/skills/command-runner/scripts/cli.mjs inspect builtin-git-diff';
    for (const input of [
      { tool_name: 'run_in_terminal', tool_input: { command: cliInspect, mode: 'sync', explanation: 'Inspect diff' } },
      { toolName: 'run_in_terminal', toolArgs: JSON.stringify({ command: cliInspect, mode: 'sync' }) },
      { tool_name: 'execute/runInTerminal', tool_input: { command: cliInspect, mode: 'sync', timeout: 0 } },
    ]) {
      const permitted = runHook(fixture, input);
      assert.equal(permitted.status, 0, permitted.stderr);
      assert.equal(JSON.parse(permitted.stdout).permissionDecision, 'allow');
    }

    for (const [options, reason] of [
      [{ mode: 'async' }, /terminal mode must be sync or omitted/u],
      [{ mode: 'background' }, /terminal mode must be sync or omitted/u],
      [{ mode: null }, /terminal mode must be sync or omitted/u],
      [{ timeout: 5000 }, /terminal timeout must be 0 or omitted/u],
      [{ timeout: '0' }, /terminal timeout must be 0 or omitted/u],
    ]) {
      const denied = runHook(fixture, {
        toolName: 'run_in_terminal',
        toolArgs: JSON.stringify({ command: cliInspect, ...options }),
      });
      const payload = JSON.parse(denied.stdout);
      assert.equal(payload.permissionDecision, 'deny');
      assert.match(payload.permissionDecisionReason, reason);
    }

    for (const options of [
      { mode: 'async' },
      { timeout: 5_000 },
      { requestUnsandboxedExecution: true },
      { requestAllowNetwork: true },
    ]) {
      const denied = runHook(fixture, {
        tool_name: 'run_in_terminal',
        tool_input: { command: accepted, ...options },
      });
      assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
    }
  });
});

test('hook denies terminal execution overrides and background execution', async () => {
  await withFixture(async (fixture) => {
    for (const toolInput of [
      {
        command: 'node ~/.copilot/skills/command-runner/scripts/gateway.mjs list --expected-workspace=alpha',
        cwd: fixture.beta,
      },
      {
        command: 'node ~/.copilot/skills/command-runner/scripts/gateway.mjs list --expected-workspace=alpha',
        env: { TEST: '1' },
      },
      {
        command: 'node ~/.copilot/skills/command-runner/scripts/gateway.mjs list --expected-workspace=alpha',
        isBackground: true,
      },
    ]) {
      const result = runHook(fixture, {
        hook_event_name: 'PreToolUse',
        cwd: fixture.alpha,
        tool_name: 'execute/runInTerminal',
        tool_input: toolInput,
      });
      assert.equal(
        JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
        'deny',
      );
    }
  });
});

test('shared hook allows ordinary read, search and edit tools while protecting runner config', async () => {
  await withFixture(async (fixture) => {
    for (const toolName of ['read/readFile', 'Read', 'view', 'read', 'search', 'search/codebase', 'web', 'edit', 'Edit', 'edit/createFile', 'edit/createDirectory']) {
      const read = runHook(fixture, {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: { path: 'README.md' },
      });
      assert.deepEqual(JSON.parse(read.stdout), { continue: true });
    }

    for (const protectedPath of [
      '~/.copilot/command-runner/workspaces.json',
      '~/.copilot/skills/command-runner/scripts/builtins.mjs',
      '~/.copilot/skills/command-runner/SKILL.md',
      '~/.copilot/skills/command-runner/references/commands.md',
      '~/.copilot/skills/command-runner/scripts/future-tool.mjs',
    ]) {
      const localWrite = runHook(fixture, {
        hook_event_name: 'PreToolUse',
        tool_name: 'edit/editFiles',
        tool_input: { files: [{ path: protectedPath, replacement: 'unsafe' }] },
      });
      assert.equal(
        JSON.parse(localWrite.stdout).hookSpecificOutput.permissionDecision,
        'deny',
        protectedPath,
      );
      const copilotWrite = runHook(fixture, {
        sessionId: 'copilot-session',
        toolName: 'Edit',
        toolArgs: { path: protectedPath, content: 'unsafe' },
      });
      assert.equal(
        JSON.parse(copilotWrite.stdout).permissionDecision,
        'deny',
        protectedPath,
      );
    }

    const unrelated = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      tool_name: 'edit/editFiles',
      tool_input: {
        files: [{ path: 'src/example.js', replacement: 'export {};' }],
      },
    });
    assert.deepEqual(JSON.parse(unrelated.stdout), { continue: true });
    const copilotRead = runHook(fixture, {
      sessionId: 'copilot-session',
      toolName: 'Read',
      toolArgs: { path: 'README.md' },
    });
    assert.deepEqual(JSON.parse(copilotRead.stdout), {});
  });
});

test('native file and text search aliases remain read-only under Local and Copilot hooks', async () => {
  await withFixture(async (fixture) => {
    for (const toolName of ['glob', 'Glob', 'grep', 'rg', 'Grep']) {
      const local = runHook(fixture, {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: { pattern: '**/*.ts' },
      });
      assert.equal(local.status, 0, local.stderr);
      assert.deepEqual(JSON.parse(local.stdout), { continue: true }, toolName);

      const copilot = runHook(fixture, {
        sessionId: 'copilot-session',
        toolName,
        toolArgs: JSON.stringify({ pattern: '**/*.ts' }),
      });
      assert.equal(copilot.status, 0, copilot.stderr);
      assert.deepEqual(JSON.parse(copilot.stdout), {}, toolName);
    }

    // Unknown delegation, shell, and other tools remain denied.
    for (const toolName of ['task', 'Agent', 'unrecognized_shell']) {
      const denied = runHook(fixture, {
        sessionId: 'copilot-session',
        toolName,
        toolArgs: '{}',
      });
      assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny', toolName);
    }
    const shell = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      tool_name: 'run_in_terminal',
      tool_input: { command: 'rg example src' },
    });
    assert.equal(JSON.parse(shell.stdout).permissionDecision, 'deny');
  });
});

test('native Copilot web and file-creation aliases defer permission checks to Host', async () => {
  await withFixture(async (fixture) => {
    for (const toolName of ['create', 'Write', 'web_search', 'WebSearch', 'web_fetch', 'WebFetch']) {
      const args = toolName === 'create' || toolName === 'Write'
        ? { path: 'src/new-file.ts', content: 'export {};' }
        : { query: 'bounded research', url: 'https://example.com' };
      const local = runHook(fixture, {
        hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: args,
      });
      assert.equal(local.status, 0, local.stderr);
      assert.deepEqual(JSON.parse(local.stdout), { continue: true }, toolName);

      const copilot = runHook(fixture, {
        sessionId: 'copilot-session', toolName, toolArgs: JSON.stringify(args),
      });
      assert.equal(copilot.status, 0, copilot.stderr);
      assert.deepEqual(JSON.parse(copilot.stdout), {}, toolName);
    }
    for (const toolName of ['create', 'Write']) {
      const denied = runHook(fixture, {
        sessionId: 'copilot-session', toolName,
        toolArgs: JSON.stringify({
          path: path.join(fixture.home, 'agents', 'Writer.agent.md'), content: 'unsafe',
        }),
      });
      assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny', toolName);
    }
  });
});

test('installed control identity is protected without blocking same-suffix repo sources', async () => {
  await withFixture(async (fixture) => {
    const sourceFile = path.join(fixture.alpha, '.copilot', 'agents', 'Writer.agent.md');
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, 'source-only');
    const linkedFile = path.join(fixture.alpha, 'linked-control.md');
    const linkedDirectory = path.join(fixture.alpha, 'linked-agent-directory');
    const linkedHardFile = path.join(fixture.alpha, 'hardlinked-control.md');
    await symlink(path.join(fixture.home, 'agents', 'Writer.agent.md'), linkedFile);
    await symlink(path.join(fixture.home, 'agents'), linkedDirectory, 'dir');
    await link(path.join(fixture.home, 'agents', 'Writer.agent.md'), linkedHardFile);
    const linkedParentTraversal = linkedDirectory + path.sep + '..' + path.sep
      + 'agents' + path.sep + 'Writer.agent.md';
    // This raw filesystem path reaches the installed control through the link.
    assert.equal(await readFile(linkedParentTraversal, 'utf8'),
      await readFile(path.join(fixture.home, 'agents', 'Writer.agent.md'), 'utf8'));

    const skillSource = path.join(fixture.alpha, '.copilot', 'skills', 'command-runner', 'SKILL.md');
    await mkdir(path.dirname(skillSource), { recursive: true });
    await writeFile(skillSource, 'workspace skill source');
    for (const target of [
      sourceFile, '.copilot/agents/Writer.agent.md', pathToFileURL(sourceFile).href,
      skillSource,
    ]) {
      const result = runHook(fixture, {
        sessionId: 'copilot-session', toolName: 'Edit',
        toolArgs: JSON.stringify({ path: target, content: 'authorized source change' }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {}, target);
    }
    for (const target of [
      '~/.copilot/agents/Writer.agent.md',
      path.join(fixture.home, 'agents', 'Writer.agent.md'),
      pathToFileURL(path.join(fixture.home, 'agents', 'Writer.agent.md')).href,
      path.join(fixture.home, 'agents', 'CommandRunner.agent.md'),
      linkedFile,
      linkedHardFile,
      linkedParentTraversal,
      path.join(linkedDirectory, 'Writer.agent.md'),
      path.join(fixture.alpha, '..', 'copilot-home', 'skills', 'command-runner', 'scripts', 'hook.mjs'),
    ]) {
      const result = runHook(fixture, {
        sessionId: 'copilot-session', toolName: 'Edit',
        toolArgs: JSON.stringify({ path: target, content: 'unsafe change' }),
      });
      assert.equal(JSON.parse(result.stdout).permissionDecision, 'deny', target);
    }
  });
});

test('custom COPILOT_HOME protects both the installed root and runner data', async () => {
  await withFixture(async (fixture) => {
    const dataHome = path.join(fixture.root, 'separate-runner-data');
    const config = path.join(dataHome, 'command-runner', 'workspaces.json');
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, '{"version":1,"workspaces":[]}');
    const source = path.join(fixture.alpha, '.copilot', 'agents', 'Writer.agent.md');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'project copy');
    for (const target of [
      '~/.copilot/agents/Writer.agent.md',
      path.join(fixture.home, 'agents', 'Writer.agent.md'),
      path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'hook.mjs'),
      path.join(fixture.home, 'command-runner', 'workspaces.json'),
      config,
    ]) {
      const result = runHook(fixture, {
        sessionId: 'copilot-session', toolName: 'Write',
        toolArgs: JSON.stringify({ path: target, content: 'not allowed' }),
      }, { COPILOT_HOME: dataHome });
      assert.equal(JSON.parse(result.stdout).permissionDecision, 'deny', target);
    }
    const ordinary = runHook(fixture, {
      sessionId: 'copilot-session', toolName: 'Write',
      toolArgs: JSON.stringify({ path: source, content: 'source edit' }),
    }, { COPILOT_HOME: dataHome });
    assert.deepEqual(JSON.parse(ordinary.stdout), {});
  });
});

test('long single-line edit content is never probed as a path', async () => {
  await withFixture(async (fixture) => {
    const longLine = 'x'.repeat(500);
    for (const toolName of ['Edit', 'Write', 'create', 'str_replace_editor']) {
      const args = { path: 'src/normal.ts', content: longLine,
        old_str: longLine, new_str: longLine, replacement: longLine };
      const result = runHook(fixture, {
        sessionId: 'copilot-session', toolName, toolArgs: JSON.stringify(args),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {}, toolName);
    }
    for (const toolArgs of [
      '~/.copilot/agents/Writer.agent.md',
      { files: [{ path: '~/.copilot/agents/Writer.agent.md',
        content: longLine }] },
    ]) {
      const result = runHook(fixture, {
        sessionId: 'copilot-session', toolName: 'Edit', toolArgs,
      });
      assert.equal(JSON.parse(result.stdout).permissionDecision, 'deny');
    }
  });
});

test('native patch editing works with exact file-path protection in both hook envelopes', async () => {
  await withFixture(async (fixture) => {
    const patch = ['*** Begin Patch', '*** Update File: src/example.js',
      '@@', '-old', '+new', '*** End Patch'].join('\n');
    for (const [toolName, input, expected] of [
      ['apply_patch', {
        hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: patch,
      }, { continue: true }],
      ['apply_patch', {
        sessionId: 'copilot-session', toolName: 'apply_patch', toolArgs: patch,
      }, {}],
      ['apply_patch', {
        sessionId: 'copilot-session', toolName: 'apply_patch',
        toolArgs: JSON.stringify({ patch }),
      }, {}],
      ['str_replace_editor', {
        sessionId: 'copilot-session', toolName: 'str_replace_editor',
        toolArgs: JSON.stringify({ path: 'src/example.js', replacement: 'new' }),
      }, {}],
    ]) {
      const result = runHook(fixture, input);
      assert.equal(result.status, 0, result.stderr + toolName);
      assert.deepEqual(JSON.parse(result.stdout), expected, toolName);
    }

    const control = '~/.copilot/command-runner/workspaces.json';
    for (const directive of [
      '*** Update File: ' + control,
      '*** Add File: ' + control,
      '*** Delete File: ' + control,
      '*** Update File: src/example.js\n*** Move to: ' + control,
    ]) {
      const unsafePatch = ['*** Begin Patch', directive, '@@', '-old', '+new',
        '*** End Patch'].join('\n');
      for (const input of [
        { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: unsafePatch },
        { sessionId: 'copilot-session', toolName: 'apply_patch', toolArgs: unsafePatch },
        { sessionId: 'copilot-session', toolName: 'Edit', toolArgs: unsafePatch },
      ]) {
        const denied = runHook(fixture, input);
        assert.equal(denied.status, 0, denied.stderr);
        assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny', directive);
      }
    }
    // A native parser accepts indented file directives; protect those too.
    for (const leading of ['  ', '\t', ' \t']) {
      const bypass = ['*** Begin Patch', '*** Add File: examples/ok.txt',
        '+ok', leading + '*** Add File: ' + control, '+blocked',
        '*** End Patch'].join('\n');
      for (const toolArgs of [bypass, JSON.stringify({ patch: bypass })]) {
        const denied = runHook(fixture, {
          sessionId: 'copilot-session', toolName: 'apply_patch', toolArgs,
        });
        assert.equal(denied.status, 0, denied.stderr);
        assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny', leading);
      }
      const move = ['*** Begin Patch', '*** Update File: examples/ok.txt',
        leading + '*** Move to: ' + control, '@@', '-old', '+new',
        '*** End Patch'].join('\n');
      const moved = runHook(fixture, {
        sessionId: 'copilot-session', toolName: 'apply_patch', toolArgs: move,
      });
      assert.equal(JSON.parse(moved.stdout).permissionDecision, 'deny', leading);
    }
    // An explicit target may normalize through an unusual relative directory
    // spelling; source-text exemptions must not apply to real targets.
    const disguisedControl = path.join(fixture.alpha, '..', 'copilot-home',
      'command-runner', 'workspaces.json');
    const disguisedPatch = ['*** Begin Patch',
      '*** Add File: examples/safe.txt', '+safe',
      '*** Add File: ' + disguisedControl, '+unsafe', '*** End Patch'].join('\n');
    const disguised = runHook(fixture, {
      sessionId: 'copilot-session', toolName: 'apply_patch', toolArgs: disguisedPatch,
    });
    assert.equal(JSON.parse(disguised.stdout).permissionDecision, 'deny');
    const disguisedEdit = runHook(fixture, {
      sessionId: 'copilot-session', toolName: 'Edit',
      toolArgs: JSON.stringify({ path: disguisedControl, content: 'safe' }),
    });
    assert.equal(JSON.parse(disguisedEdit.stdout).permissionDecision, 'deny');

    // The leading space below is a hunk context marker, not a file directive.
    const quotedPathPatch = ['*** Begin Patch',
      '*** Update File: examples/change.patch', '@@',
      ' *** Update File: ' + control, '-old', '+new', '*** End Patch'].join('\n');
    const quoted = runHook(fixture, {
      sessionId: 'copilot-session', toolName: 'apply_patch', toolArgs: quotedPathPatch,
    });
    assert.deepEqual(JSON.parse(quoted.stdout), {});

    for (const patchText of ['bad patch', '*** Begin Patch\n*** End Patch',
      '*** Begin Patch\n*** Update File: src/example.js\n*** Unknown: x\n*** End Patch']) {
      const denied = runHook(fixture, {
        sessionId: 'copilot-session', toolName: 'apply_patch', toolArgs: patchText,
      });
      assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
    }
    const deniedReplace = runHook(fixture, {
      sessionId: 'copilot-session', toolName: 'str_replace_editor',
      toolArgs: JSON.stringify({ path: control, replacement: 'unsafe' }),
    });
    assert.equal(JSON.parse(deniedReplace.stdout).permissionDecision, 'deny');

    // Patch documentation is data, not a request to execute that patch.
    for (const [toolName, args] of [
      ['str_replace_editor', { path: 'examples/change.patch',
        old_str: '*** Begin Patch', new_str: '*** Update File: ' + control }],
      ['Edit', { path: 'examples/change.patch', content: [
        '*** Begin Patch', '*** Update File: ' + control, '*** End Patch',
      ].join('\n') }],
      ['edit/editFiles', { files: [{ path: 'examples/change.patch',
        replacement: '*** Begin Patch' }] }],
    ]) {
      const ordinaryEdit = runHook(fixture, {
        sessionId: 'copilot-session', toolName,
        toolArgs: JSON.stringify(args),
      });
      assert.equal(ordinaryEdit.status, 0, ordinaryEdit.stderr);
      assert.deepEqual(JSON.parse(ordinaryEdit.stdout), {}, toolName);
    }

    // A patch-bearing Edit argument must still protect actual patch targets.
    for (const args of [
      { patch: ['*** Begin Patch', '*** Update File: ' + control,
        '@@', '-old', '+new', '*** End Patch'].join('\n') },
    ]) {
      const denied = runHook(fixture, {
        sessionId: 'copilot-session', toolName: 'Edit', toolArgs: JSON.stringify(args),
      });
      assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
    }
  });
});

test('hook fails closed for unknown terminal names in both harness envelopes', async () => {
  await withFixture(async (fixture) => {
    const accepted = 'node ~/.copilot/skills/command-runner/scripts/gateway.mjs list --expected-workspace=alpha';
    for (const input of [
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'execute/unrecognizedTerminal',
        tool_input: { command: accepted },
      },
      {
        sessionId: 'copilot-session',
        toolName: 'terminal/unrecognizedExecute',
        toolArgs: JSON.stringify({ command: accepted }),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'run_in_terminal_unrecognized',
        tool_input: { command: accepted },
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'edit/unrecognizedTool',
        tool_input: { files: [{ path: 'src/example.js', replacement: 'unsafe' }] },
      },
    ]) {
      const result = runHook(fixture, input);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).permissionDecision, 'deny');
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }
  });
});


test('P0 built-ins are discoverable, immutable, and safely manage one file at a time', async () => {
  await withFixture(async (fixture) => {
    const run = (id, params = []) => {
      const result = runRunnerWithoutHashes(fixture, fixture.alpha, [
        'run', id, '--expected-workspace=alpha', ...params,
      ]);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const listed = JSON.parse(runRunner(fixture, fixture.alpha, ['list']).stdout);
    const ids = listed.commands.map(({ id }) => id);
    for (const id of [
      'builtin-fs-move', 'builtin-fs-copy', 'builtin-fs-trash',
      'builtin-fs-restore', 'builtin-fs-trash-list',
      'builtin-git-status', 'builtin-git-diff', 'builtin-git-log',
      'builtin-git-show', 'builtin-git-ls-files', 'builtin-git-branch-info',
    ]) assert.ok(ids.includes(id), id);

    const described = runInterface(fixture, fixture.alpha, ['describe', 'builtin-fs-move']);
    assert.equal(described.status, 0, described.stderr);
    const inspected = runInterface(fixture, fixture.alpha, ['inspect', 'builtin-fs-move']);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).source, 'built-in');
    // Public descriptions must make effects and recovery clear without source-code inspection.
    const requiredDescriptions = {
      'builtin-fs-move': ['workspace-relative', 'No overwrite', 'symlink'],
      'builtin-fs-copy': ['workspace-relative', 'No overwrite', 'symlink'],
      'builtin-fs-trash': ['.agent-trash/<itemId>/payload', 'not the OS trash', 'itemId', 'no overwrite or permanent deletion'],
      'builtin-fs-restore': ['.agent-trash', 'original workspace-relative', 'No overwrite'],
      'builtin-fs-trash-list': ['.agent-trash', 'itemId', 'Read-only'],
      'builtin-git-status': ['repository root equals current workspace', 'No index refresh'],
      'builtin-git-diff': ['workspace-relative', 'staged', 'No index refresh'],
      'builtin-git-log': ['100', 'no repository changes'],
      'builtin-git-show': ['40-character SHA', 'no writes'],
      'builtin-git-ls-files': ['workspace-relative', 'Read-only'],
      'builtin-git-branch-info': ['repository root matches', 'does not switch branches'],
    };
    for (const [id, phrases] of Object.entries(requiredDescriptions)) {
      const response = runInterface(fixture, fixture.alpha, ['describe', id]);
      assert.equal(response.status, 0, response.stderr);
      const description = JSON.parse(response.stdout).command.description;
      assert.ok(description.length <= 500, id);
      for (const phrase of phrases) assert.ok(description.includes(phrase), `${id}: ${phrase}`);
    }
    const denied = runInterface(fixture, fixture.alpha, [
      'register', 'builtin-fs-move', 'definition=%7B%7D',
    ]);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /builtin_immutable/u);

    assert.equal(run('builtin-fs-copy', [
      'source=tests%2Fsample.test.js', 'destination=tests%2Fcopy.test.js',
    ]).status, 'completed');
    assert.equal(await readFile(path.join(fixture.alpha, 'tests', 'copy.test.js'), 'utf8'), 'export {};\n');
    assert.equal(run('builtin-fs-copy', [
      'source=tests%2Fsample.test.js', 'destination=tests%2Fcopy.test.js',
    ]).status, 'failed');
    assert.equal(run('builtin-fs-move', [
      'source=tests%2Fcopy.test.js', 'destination=tests%2Frenamed.test.js',
    ]).status, 'completed');

    const moved = run('builtin-fs-trash', ['source=tests%2Frenamed.test.js']);
    assert.equal(moved.status, 'completed');
    const { itemId } = JSON.parse(moved.stdout);
    assert.match(itemId, /^[0-9a-f-]{36}$/u);
    const ignored = await readFile(path.join(fixture.alpha, '.agent-trash', '.gitignore'), 'utf8');
    assert.equal(ignored, '*\n');
    const items = run('builtin-fs-trash-list');
    assert.equal(items.status, 'completed');
    assert.equal(JSON.parse(items.stdout).items[0].itemId, itemId);
    const restored = run('builtin-fs-restore', ['itemId=' + itemId]);
    assert.equal(restored.status, 'completed');
    assert.equal(await readFile(path.join(fixture.alpha, 'tests', 'renamed.test.js'), 'utf8'), 'export {};\n');
    assert.equal(run('builtin-fs-restore', ['itemId=' + itemId]).status, 'failed');

    await writeFile(path.join(fixture.alpha, 'tests', 'manifest.json'), '{"data":true}\n');
    const special = run('builtin-fs-trash', ['source=tests%2Fmanifest.json']);
    assert.equal(special.status, 'completed');
    const specialId = JSON.parse(special.stdout).itemId;
    assert.equal(run('builtin-fs-restore', ['itemId=' + specialId]).status, 'completed');
    assert.equal(await readFile(path.join(fixture.alpha, 'tests', 'manifest.json'), 'utf8'), '{"data":true}\n');
    await writeFile(path.join(fixture.alpha, 'tests', 'a.txt'), 'a');
    await writeFile(path.join(fixture.alpha, 'tests', 'b.txt'), 'b');
    assert.equal(run('builtin-fs-trash', ['source=tests%2Fa.txt']).status, 'completed');
    assert.equal(run('builtin-fs-trash', ['source=tests%2Fb.txt']).status, 'completed');
    const firstPage = JSON.parse(run('builtin-fs-trash-list', ['limit=1']).stdout);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.nextOffset, 1);
    const secondPage = JSON.parse(run('builtin-fs-trash-list', ['limit=1', 'offset=1']).stdout);
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0].itemId, firstPage.items[0].itemId);

        assert.equal(run('builtin-fs-trash', ['source=.git%2Fconfig']).status, 'failed');
    assert.equal(run('builtin-fs-copy', [
      'source=tests%2Fsample.test.js', 'destination=..%2Foutside.js',
    ]).status, 'failed');
    await symlink('sample.test.js', path.join(fixture.alpha, 'tests', 'alias.test.js'));
    assert.equal(run('builtin-fs-trash', ['source=tests%2Falias.test.js']).status, 'failed');
    assert.equal(await readFile(path.join(fixture.alpha, 'tests', 'sample.test.js'), 'utf8'), 'export {};\n');
  });
});

test('P0 Git built-ins only observe a repository rooted at the workspace', async () => {
  await withFixture(async (fixture) => {
    const execGit = (...args) => {
      const result = spawnSync('git', args, { cwd: fixture.alpha, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    execGit('init', '-q');
    execGit('config', 'user.name', 'Test Author');
    execGit('config', 'user.email', 'test@example.invalid');
    execGit('add', 'tests/sample.test.js');
    execGit('commit', '-qm', 'initial');
    const commit = execGit('rev-parse', 'HEAD');
    const run = (id, params = []) => {
      const result = runRunnerWithoutHashes(fixture, fixture.alpha, [
        'run', id, '--expected-workspace=alpha', ...params,
      ]);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(run('builtin-git-status').status, 'completed');
    assert.equal(run('builtin-git-diff', ['scope=staged']).status, 'completed');
    assert.equal(run('builtin-git-log', ['count=3']).status, 'completed');
    assert.equal(run('builtin-git-show', ['commit=' + commit]).status, 'completed');
    assert.equal(run('builtin-git-ls-files').status, 'completed');
    assert.equal(run('builtin-git-branch-info').status, 'completed');
    assert.equal(run('builtin-git-show', ['commit=HEAD']).status, 'completed');
    const indexBefore = await readFile(path.join(fixture.alpha, '.git', 'index'));
    assert.equal(run('builtin-fs-trash', ['source=tests%2Fsample.test.js']).status, 'completed');
    const ignore = spawnSync('git', ['check-ignore', '-q', '--no-index', '.agent-trash/.gitignore'],
      { cwd: fixture.alpha, encoding: 'utf8' });
    assert.equal(ignore.status, 0, ignore.stderr);
    const indexAfter = await readFile(path.join(fixture.alpha, '.git', 'index'));
    assert.deepEqual(indexAfter, indexBefore);
    assert.equal(execGit('status', '--porcelain').includes('?? .agent-trash'), false);
  });
});



test('read-only Git builtins support branch comparisons, history, search and safe argv', async () => {
  await withFixture(async (fixture) => {
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: fixture.alpha, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.name', 'Test Author');
    git('config', 'user.email', 'test@example.invalid');
    git('add', 'tests/sample.test.js');
    git('commit', '-qm', 'initial');
    git('branch', 'main');
    git('checkout', '-qb', 'feature');
    await writeFile(path.join(fixture.alpha, 'tests/sample.test.js'), '// new-marker\nexport {};\n');
    git('add', 'tests/sample.test.js');
    git('commit', '-qm', 'feature change');

    const run = (id, parameters = []) => {
      const result = runRunnerWithoutHashes(fixture, fixture.alpha, [
        'run', id, '--expected-workspace=alpha', ...parameters,
      ]);
      // Rejected schemas exit 2 before launching a built-in, while rejected
      // Git invocations are returned as a failed execution with exit 0.
      if (result.status === 2) {
        const denial = JSON.parse(result.stderr);
        assert.equal(denial.status, 'error');
        return { status: 'failed', denial };
      }
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const output = (id, parameters = []) => {
      const result = run(id, parameters);
      assert.equal(result.status, 'completed', id + ': ' + result.stderr);
      return JSON.parse(result.stdout).output;
    };
    assert.match(output('builtin-git-diff', [
      'scope=commits', 'base=main', 'target=HEAD', 'comparison=merge-base', 'format=name-only',
    ]), /tests\/sample\.test\.js/u);
    assert.match(output('builtin-git-diff', [
      'scope=commits', 'base=main', 'target=HEAD', 'comparison=direct', 'format=stat',
    ]), /sample\.test\.js/u);
    assert.match(output('builtin-git-log', ['range=main..HEAD', 'format=oneline']), /feature change/u);
    assert.match(output('builtin-git-show', ['commit=HEAD', 'format=name-only']), /sample\.test\.js/u);
    assert.match(output('builtin-git-ls-files'), /sample\.test\.js/u);
    assert.match(output('builtin-git-branch', ['scope=all']), /feature/u);
    assert.match(output('builtin-git-blame', ['file=tests%2Fsample.test.js', 'start=1', 'end=1']), /new-marker/u);
    assert.match(output('builtin-git-grep', ['pattern=new-marker']), /sample\.test\.js/u);
    assert.equal(output('builtin-git-grep', ['pattern=not-there-anywhere']), '');
    assert.match(output('builtin-git-merge-base', ['left=main', 'right=HEAD']), /^[a-f0-9]{40}\n/u);
    assert.match(output('builtin-git-rev-parse', ['ref=HEAD']), /^[a-f0-9]{40}\n/u);
    assert.match(output('builtin-git-rev-list', ['range=main..HEAD']), /^[a-f0-9]{40}\n/u);
    assert.match(output('builtin-git-worktree', ['format=porcelain']), /worktree /u);
    assert.match(output('builtin-git-reflog'), /feature change/u);
    assert.match(output('builtin-git-range-diff', ['oldRange=main..HEAD', 'newRange=main..HEAD']), /feature change/u);
    assert.match(output('builtin-git-ls-tree', ['ref=HEAD', 'recursive=true', 'format=names']), /sample\.test\.js/u);

    // When a revision has the same name as a worktree path, Git requires
    // an explicit revision/path separator even without a file filter.
    git('branch', 'release');
    await mkdir(path.join(fixture.alpha, 'release'));
    await writeFile(path.join(fixture.alpha, 'release', 'untracked.txt'), 'untracked\n');
    assert.match(output('builtin-git-diff', [
      'scope=commits', 'base=main', 'target=release', 'format=name-only',
    ]), /sample\.test\.js/u);
    assert.match(output('builtin-git-log', [
      'range=main..release', 'format=oneline',
    ]), /feature change/u);
    assert.match(output('builtin-git-show', [
      'commit=release', 'format=name-only',
    ]), /sample\.test\.js/u);
    assert.match(output('builtin-git-ls-tree', [
      'ref=release', 'recursive=true', 'format=names',
    ]), /sample\.test\.js/u);

    // --check must retain actionable file/line diagnostics on failure.
    await writeFile(path.join(fixture.alpha, 'tests/sample.test.js'), '// new-marker\nexport {};\nlet bad = 1; \n');
    const checked = run('builtin-git-diff', ['format=check']);
    assert.equal(checked.status, 'failed');
    assert.match(checked.stderr, /trailing whitespace/u);

    // range-diff internally invokes Git log, which may spawn configured
    // textconv drivers. Reject those configs before running the command.
    git('config', 'diff.marker.textconv', 'touch converter-marker');
    await writeFile(path.join(fixture.alpha, '.gitattributes'), '*.js diff=marker\n');
    const blockedRangeDiff = run('builtin-git-range-diff', [
      'oldRange=main..HEAD', 'newRange=main..HEAD',
    ]);
    assert.equal(blockedRangeDiff.status, 'failed');
    assert.match(blockedRangeDiff.stderr, /textconv/u);
    await assert.rejects(readFile(path.join(fixture.alpha, 'converter-marker')));

    assert.equal(run('builtin-git-diff', ['scope=commits', 'base=main']).status, 'failed');
    assert.equal(run('builtin-git-diff', ['scope=unstaged', 'base=main']).status, 'failed');
    assert.equal(run('builtin-git-diff', ['format=--output=evil']).status, 'failed');
    assert.equal(run('builtin-git-diff', ['file=..%2Foutside']).status, 'failed');
    assert.equal(run('builtin-git-branch', ['scope=delete']).status, 'failed');
    assert.equal(run('builtin-git-worktree', ['format=remove']).status, 'failed');
    assert.equal(run('builtin-git-grep', ['arg=--open-files-in-pager']).status, 'failed');
    assert.equal(run('builtin-git-ls-tree', ['ref=--upload-pack=evil']).status, 'failed');
    const inspected = runInterface(fixture, fixture.alpha, ['inspect', 'builtin-git-merge-base']);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.match(inspected.stdout, /"left"/u);
  });
});


function runV2(fixture, cwd, args) {
  return spawnSync(process.execPath,
    [path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'cli.mjs'), ...args],
    {cwd, encoding: 'utf8', env: {...process.env, COPILOT_HOME: fixture.home}});
}

test('CLI self-onboarding registers only a project root, without caller-supplied workspace ID', async () => {
  await withFixture(async (fixture) => {
    const gamma = path.join(fixture.root, 'gamma');
    await mkdir(gamma);
    await writeFile(path.join(gamma, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {test: 'node -e "process.stdout.write(1)"'},
    }));
    let response = runV2(fixture, gamma, ['workspace.ensure']);
    assert.equal(response.status, 0, response.stderr);
    assert.equal(JSON.parse(response.stdout).registered, true);
    response = runV2(fixture, gamma, ['workspace.ensure']);
    assert.equal(response.status, 0, response.stderr);
    assert.equal(JSON.parse(response.stdout).registered, false);
    const config = JSON.parse(await readFile(path.join(fixture.home, 'command-runner', 'workspaces.json'), 'utf8'));
    assert.equal(config.workspaces.length, 3);
    assert.ok(config.workspaces.some(ws => ws.root === gamma && /^ws-[0-9a-f]{24}$/u.test(ws.id)));

    const unrelated = path.join(fixture.root, 'unrelated');
    await mkdir(unrelated);
    response = runV2(fixture, unrelated, ['workspace.ensure']);
    assert.equal(response.status, 2);
    assert.match(response.stderr, /workspace_root_unverified/u);
  });
});

test('CLI proposes inert npm scripts, activates exact candidate, and detects changed script definitions', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {test: 'node echo-args.mjs', pretest: 'node --version'},
    }));
    const original = await readFile(path.join(fixture.home, 'command-runner', 'workspaces.json'), 'utf8');
    const proposed = runV2(fixture, fixture.alpha, ['propose', 'test']);
    assert.equal(proposed.status, 0, proposed.stderr);
    const candidate = JSON.parse(proposed.stdout);
    assert.equal(candidate.status, 'pending_approval');
    assert.deepEqual(candidate.argv, ['npm', 'run', 'test', '--']);
    assert.equal(candidate.scriptPreview.test, 'node echo-args.mjs');
    assert.equal(await readFile(path.join(fixture.home, 'command-runner', 'workspaces.json'), 'utf8'), original);

    const accepted = runV2(fixture, fixture.alpha, ['activate', candidate.proposalId]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).commandId, 'test');
    const executed = runV2(fixture, fixture.alpha, ['run', 'test']);
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).status, 'completed');
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {test: 'node echo-args.mjs', pretest: 'npm publish'},
    }));
    const stopped = runV2(fixture, fixture.alpha, ['run', 'test']);
    assert.equal(stopped.status, 2);
    assert.match(stopped.stderr, /stale_script_definition/u);
    const copy = runRunnerWithoutHashes(fixture, fixture.alpha,
      ['run', 'test', '--expected-workspace=alpha']);
    assert.equal(copy.status, 2);
    assert.match(copy.stderr, /stale_script_definition/u);
  });
});

test('CLI fixed proposals require an explicit description and host approval before reuse', async () => {
  await withFixture(async (fixture) => {
    const description = 'Check the Node.js runtime version without changing project files; stdout reports the version and the exit code indicates success.';
    const definition = {description, run: ['node', '--version'], cwd: '.', arguments: {},
      timeoutMs: 300000, maxOutputBytes: 1048576};
    const encoded = 'definition=' + encodeURIComponent(JSON.stringify(definition));
    const source = await readFile(path.join(fixture.home, 'command-runner', 'workspaces.json'), 'utf8');
    const proposed = runV2(fixture, fixture.alpha, ['propose', 'node-version', encoded]);
    assert.equal(proposed.status, 0, proposed.stderr);
    const candidate = JSON.parse(proposed.stdout);
    assert.equal(candidate.proposalType, 'fixed');
    assert.equal(candidate.description, description);
    assert.deepEqual(candidate.argv, ['node', '--version']);
    assert.equal(candidate.status, 'pending_approval');
    assert.equal(await readFile(path.join(fixture.home, 'command-runner', 'workspaces.json'), 'utf8'), source);
    const beforeActivation = runV2(fixture, fixture.alpha, ['run', 'node-version']);
    assert.equal(beforeActivation.status, 2);
    assert.match(beforeActivation.stderr, /command_not_registered/u);

    const invoke = (command) => runHook(fixture, {
      hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal', tool_input: {command},
    });
    const proposalHook = invoke('node ~/.copilot/skills/command-runner/scripts/cli.mjs propose node-version ' + encoded);
    assert.equal(JSON.parse(proposalHook.stdout).permissionDecision, 'allow');
    const activatedHook = invoke('node ~/.copilot/skills/command-runner/scripts/cli.mjs activate ' + candidate.proposalId);
    assert.equal(JSON.parse(activatedHook.stdout).permissionDecision, 'ask');
    const review = JSON.parse(activatedHook.stdout).permissionDecisionReason;
    assert.match(review, /Check the Node.js runtime version/u);
    assert.match(review, /node-version/u);
    assert.match(review, /--version/u);
    assert.match(review, /timeoutMs/u);

    const activated = runV2(fixture, fixture.alpha, ['activate', candidate.proposalId]);
    assert.equal(activated.status, 0, activated.stderr);
    const executed = runV2(fixture, fixture.alpha, ['run', 'node-version']);
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).status, 'completed');
    const described = runV2(fixture, fixture.alpha, ['describe', 'node-version']);
    assert.equal(described.status, 0, described.stderr);
    assert.match(described.stdout, /Check the Node.js runtime version/u);
  });
});



test('CLI update proposals change only requested fields and require Host approval', async () => {
  await withFixture(async (fixture) => {
    const registry = path.join(fixture.home, 'command-runner', 'workspaces.json');
    const original = JSON.parse(await readFile(registry, 'utf8'));
    const before = structuredClone(original.workspaces[0].commands.sample);
    const description = 'Echo the existing validated arguments without changing execution settings; report arguments in the command output.';
    const patch = {description};
    const token = 'patch=' + encodeURIComponent(JSON.stringify(patch));
    const proposal = runV2(fixture, fixture.alpha, ['propose.update', 'sample', token]);
    assert.equal(proposal.status, 0, proposal.stderr);
    const candidate = JSON.parse(proposal.stdout);
    assert.equal(candidate.proposalType, 'update');
    assert.equal(candidate.previous.description, before.description);
    assert.equal(candidate.changes.description, description);
    assert.deepEqual(JSON.parse(await readFile(registry, 'utf8')), original);

    const invoke = command => runHook(fixture, {
      hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal', tool_input: {command},
    });
    const prefix = 'node ~/.copilot/skills/command-runner/scripts/cli.mjs ';
    const pending = invoke(prefix + 'propose.update sample ' + token);
    assert.equal(JSON.parse(pending.stdout).permissionDecision, 'allow');
    const review = invoke(prefix + 'activate ' + candidate.proposalId);
    assert.equal(JSON.parse(review.stdout).permissionDecision, 'ask');
    const reason = JSON.parse(review.stdout).permissionDecisionReason;
    assert.match(reason, /update_command/u);
    assert.match(reason, /Echo validated arguments/u);
    assert.match(reason, /Echo the existing validated arguments/u);
    assert.match(reason, /effectiveDefinition/u);

    const activated = runV2(fixture, fixture.alpha, ['activate', candidate.proposalId]);
    assert.equal(activated.status, 0, activated.stderr);
    const updated = JSON.parse(await readFile(registry, 'utf8'));
    assert.deepEqual(updated.workspaces[0].commands.sample, {...before, description});
    assert.equal(executionHash(updated.workspaces[0].commands.sample, updated.defaults),
      executionHash(before, original.defaults));
    const described = runV2(fixture, fixture.alpha, ['describe', 'sample']);
    assert.equal(described.status, 0, described.stderr);
    assert.equal(JSON.parse(described.stdout).command.description, description);
    const executed = runV2(fixture, fixture.alpha, ['run', 'sample', 'enabled=true']);
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).status, 'completed');
  });
});

test('CLI update keeps omitted cwd implicit for existing commands', async () => {
  await withFixture(async (fixture) => {
    const registry = path.join(fixture.home, 'command-runner', 'workspaces.json');
    const config = JSON.parse(await readFile(registry, 'utf8'));
    delete config.workspaces[0].commands.sample.cwd;
    delete config.workspaces[0].commands.timeout.cwd;
    await writeFile(registry, JSON.stringify(config, null, 2) + '\n');

    const description = 'Describe validation of optional command arguments without changing the registered working directory.';
    const request = runV2(fixture, fixture.alpha,
      ['propose.update', 'sample', 'patch=' + encodeURIComponent(JSON.stringify({description}))]);
    assert.equal(request.status, 0, request.stderr);
    const proposalId = JSON.parse(request.stdout).proposalId;
    const hook = runHook(fixture, {hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal',
      tool_input: {command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs activate ' + proposalId}});
    assert.equal(JSON.parse(hook.stdout).permissionDecision, 'ask');
    const applied = runV2(fixture, fixture.alpha, ['activate', proposalId]);
    assert.equal(applied.status, 0, applied.stderr);
    let after = JSON.parse(await readFile(registry, 'utf8'));
    assert.equal(Object.hasOwn(after.workspaces[0].commands.sample, 'cwd'), false);
    assert.equal(after.workspaces[0].commands.sample.description, description);

    const fixedPatch = {run: ['node', '--version'],
      description: 'Query the Node runtime version and report its result with no project file writes.'};
    const update = runV2(fixture, fixture.alpha, ['propose.update', 'timeout',
      'patch=' + encodeURIComponent(JSON.stringify(fixedPatch))]);
    assert.equal(update.status, 0, update.stderr);
    assert.equal(runV2(fixture, fixture.alpha, ['activate', JSON.parse(update.stdout).proposalId]).status, 0);
    after = JSON.parse(await readFile(registry, 'utf8'));
    assert.equal(Object.hasOwn(after.workspaces[0].commands.timeout, 'cwd'), false);
    assert.equal(runV2(fixture, fixture.alpha, ['run', 'timeout']).status, 0);
  });
});

test('CLI update proposals preserve npm guards and unrelated custom settings', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {check: 'node --version'},
    }));
    const proposed = runV2(fixture, fixture.alpha,
      ['propose', 'check', 'description=' + encodeURIComponent('Execute the project package check script and report its exit status without changing source files.'),
        'allow=' + encodeURIComponent(JSON.stringify(['--coverage']))]);
    assert.equal(proposed.status, 0, proposed.stderr);
    const activated = runV2(fixture, fixture.alpha, ['activate', JSON.parse(proposed.stdout).proposalId]);
    assert.equal(activated.status, 0, activated.stderr);
    const registry = path.join(fixture.home, 'command-runner', 'workspaces.json');
    const config = JSON.parse(await readFile(registry, 'utf8'));
    config.workspaces[0].commands.check.timeoutMs = 123456;
    config.workspaces[0].commands.check.maxOutputBytes = 234567;
    await writeFile(registry, JSON.stringify(config, null, 2) + '\n');
    const before = structuredClone(config.workspaces[0].commands.check);
    const description = 'Execute the existing package script without resetting custom execution limits or its guarded argument allowlist.';
    const request = runV2(fixture, fixture.alpha,
      ['propose.update', 'check', 'patch=' + encodeURIComponent(JSON.stringify({description}))]);
    assert.equal(request.status, 0, request.stderr);
    const updated = runV2(fixture, fixture.alpha, ['activate', JSON.parse(request.stdout).proposalId]);
    assert.equal(updated.status, 0, updated.stderr);
    let after = JSON.parse(await readFile(registry, 'utf8')).workspaces[0].commands.check;
    assert.deepEqual(after, {...before, description});
    assert.equal(executionHash(after), executionHash(before));

    const patch = {allow: ['--coverage', '--watch'], timeoutMs: 45000, maxOutputBytes: 13579};
    const changed = runV2(fixture, fixture.alpha,
      ['propose.update', 'check', 'patch=' + encodeURIComponent(JSON.stringify(patch))]);
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(runV2(fixture, fixture.alpha, ['activate', JSON.parse(changed.stdout).proposalId]).status, 0);
    after = JSON.parse(await readFile(registry, 'utf8')).workspaces[0].commands.check;
    assert.deepEqual(after, {...before, description, allow: patch.allow,
      timeoutMs: patch.timeoutMs, maxOutputBytes: patch.maxOutputBytes});
    assert.deepEqual(after.scriptGuard, before.scriptGuard);
  });
});

test('CLI update proposals support safe fixed argv changes and reviewed package-script refresh', async () => {
  await withFixture(async (fixture) => {
    const fixedPatch = {description: 'Show the installed Node runtime version for project diagnostics without modifying the workspace.',
      run: ['node', '--version'], timeoutMs: 60000};
    const fixed = runV2(fixture, fixture.alpha, ['propose.update', 'timeout',
      'patch=' + encodeURIComponent(JSON.stringify(fixedPatch))]);
    assert.equal(fixed.status, 0, fixed.stderr);
    const fixedProposal = JSON.parse(fixed.stdout);
    assert.deepEqual(fixedProposal.previous.run, [process.execPath, 'sleep.mjs']);
    assert.deepEqual(fixedProposal.argv, ['node', '--version']);
    assert.equal(runV2(fixture, fixture.alpha, ['activate', fixedProposal.proposalId]).status, 0);
    const fixedRun = runV2(fixture, fixture.alpha, ['run', 'timeout']);
    assert.equal(fixedRun.status, 0, fixedRun.stderr);
    assert.equal(JSON.parse(fixedRun.stdout).status, 'completed');

    const manifest = path.join(fixture.alpha, 'package.json');
    await writeFile(manifest, JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {check: 'node --version'},
    }));
    const initial = runV2(fixture, fixture.alpha, ['propose', 'check']);
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(runV2(fixture, fixture.alpha, ['activate', JSON.parse(initial.stdout).proposalId]).status, 0);
    await writeFile(manifest, JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {check: 'node echo-args.mjs'},
    }));
    const stopped = runV2(fixture, fixture.alpha, ['run', 'check']);
    assert.equal(stopped.status, 2);
    assert.match(stopped.stderr, /stale_script_definition/u);
    const refresh = runV2(fixture, fixture.alpha,
      ['propose.update', 'check', 'patch=' + encodeURIComponent(JSON.stringify({script: 'check'}))]);
    assert.equal(refresh.status, 0, refresh.stderr);
    const candidate = JSON.parse(refresh.stdout);
    assert.equal(candidate.scriptPreview.check, 'node echo-args.mjs');
    const invoke = runHook(fixture, {hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal',
      tool_input: {command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs activate ' + candidate.proposalId}});
    assert.equal(JSON.parse(invoke.stdout).permissionDecision, 'ask');
    assert.match(JSON.parse(invoke.stdout).permissionDecisionReason, /node echo-args.mjs/u);
    const accepted = runV2(fixture, fixture.alpha, ['activate', candidate.proposalId]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const executed = runV2(fixture, fixture.alpha, ['run', 'check']);
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).status, 'completed');
  });
});

test('CLI update proposals reject invalid, stale, and tampered command definitions', async () => {
  await withFixture(async (fixture) => {
    const update = (id, patch, extras = []) => runV2(fixture, fixture.alpha,
      ['propose.update', id, 'patch=' + encodeURIComponent(JSON.stringify(patch)), ...extras]);
    const description = 'Explain the existing command more precisely while retaining its exact runtime configuration.';
    for (const [id, patch, extras, code] of [
      ['builtin-git-status', {description}, [], 'builtin_immutable'],
      ['missing-command', {description}, [], 'command_not_registered'],
      ['sample', {description: 'short'}, [], 'invalid_description'],
      ['sample', {description}, ['script=test'], 'invalid_argument'],
      ['sample', {unknown: true}, [], 'invalid_argument'],
      ['sample', {run: ['node', '--version'], description}, [], 'invalid_definition'],
      ['sample', {timeoutMs: -5}, [], 'invalid_argument'],
      ['sample', {allow: ['--verbose']}, [], 'invalid_argument'],
      ['timeout', {description, run: ['node', '-e', 'process.exit(0)']}, [], 'unsupported_fixed_launcher'],
      ['timeout', {description, run: ['bash', '-c', 'true']}, [], 'unsupported_fixed_launcher'],
    ]) {
      const result = update(id, patch, extras);
      assert.equal(result.status, 2);
      assert.equal(JSON.parse(result.stderr).error.code, code);
    }
    const noPatch = runV2(fixture, fixture.alpha, ['propose.update', 'sample']);
    assert.equal(noPatch.status, 2);
    const noChange = update('sample', {description: 'Echo validated arguments.'});
    assert.equal(noChange.status, 2);
    assert.match(noChange.stderr, /unchanged_definition/u);

    const invalidHook = runHook(fixture, {
      hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal',
      tool_input: {command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs propose.update sample script=test'},
    });
    assert.equal(JSON.parse(invalidHook.stdout).permissionDecision, 'deny');

    const candidate = JSON.parse(update('sample', {description}).stdout);
    const proposalFile = path.join(fixture.home, 'command-runner', 'proposals', candidate.proposalId + '.json');
    const tampered = JSON.parse(await readFile(proposalFile, 'utf8'));
    tampered.definition.run = ['node', '--version'];
    tampered.approvalDigest = digest([
      tampered.workspaceIdentity, tampered.commandId, tampered.definition, tampered.scriptPreview,
      tampered.expectedHash, tampered.previousAllow, tampered.kind, tampered.patch, tampered.previous,
    ]);
    await writeFile(proposalFile, JSON.stringify(tampered));
    const rejected = runV2(fixture, fixture.alpha, ['activate', candidate.proposalId]);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /stale_proposal/u);

    const first = JSON.parse(update('sample', {description}).stdout);
    const nextDescription = 'Describe the original command another way without altering its executable specification or permission surface.';
    const second = JSON.parse(update('sample', {description: nextDescription}).stdout);
    assert.equal(runV2(fixture, fixture.alpha, ['activate', second.proposalId]).status, 0);
    const stale = runV2(fixture, fixture.alpha, ['activate', first.proposalId]);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /stale_proposal/u);
    const replay = runV2(fixture, fixture.alpha, ['activate', second.proposalId]);
    assert.equal(replay.status, 2);
    assert.match(replay.stderr, /stale_proposal/u);
  });
});

test('CLI fixed proposals reject dynamic arguments and unsafe launcher forms', async () => {
  await withFixture(async (fixture) => {
    const description = 'Run a bounded project verification command, returning its diagnostics without changing project source files.';
    const rejected = (definition, expected) => {
      const result = runV2(fixture, fixture.alpha, [
        'propose', 'check', 'definition=' + encodeURIComponent(JSON.stringify(definition)),
      ]);
      assert.equal(result.status, 2, result.stdout);
      assert.equal(JSON.parse(result.stderr).error.code, expected);
    };
    rejected({run: ['node', '--version']}, 'invalid_description');
    rejected({description, run: ['node', '-e', 'process.exit(0)']}, 'unsupported_fixed_launcher');
    rejected({description, run: ['bash', '-c', 'true']}, 'unsupported_fixed_launcher');
    rejected({description, run: ['npm', 'run', 'test']}, 'unsupported_fixed_launcher');
    rejected({description, run: ['node', '--version'], arguments: {free: {kind: 'positional'}}}, 'invalid_definition');
    rejected({description, run: ['node', '--version'], cwd: '..'}, 'invalid_definition');
    rejected({description, run: ['node', '--version'], cwd: fixture.beta}, 'invalid_definition');
    rejected({description, run: ['node', '--version'], allow: ['--anything=value']}, 'invalid_definition');
    const builtin = runV2(fixture, fixture.alpha, [
      'propose', 'builtin-git-status',
      'definition=' + encodeURIComponent(JSON.stringify({description, run: ['node', '--version']})),
    ]);
    assert.equal(builtin.status, 2);
    assert.equal(JSON.parse(builtin.stderr).error.code, 'builtin_immutable');
    const mixed = runV2(fixture, fixture.alpha, [
      'propose', 'check', 'definition=' + encodeURIComponent(JSON.stringify({description, run: ['node', '--version']})),
      'script=test',
    ]);
    assert.equal(mixed.status, 2);
    assert.match(mixed.stderr, /definition cannot be combined/u);
  });
});

test('CLI detects fixed proposal tampering and concurrent definition changes', async () => {
  await withFixture(async (fixture) => {
    const description = 'Check Node.js version for a preflight runtime verification, returning the version and exit status without filesystem writes.';
    const propose = () => runV2(fixture, fixture.alpha, [
      'propose', 'runtime-check',
      'definition=' + encodeURIComponent(JSON.stringify({description, run: ['node', '--version']})),
    ]);
    const first = propose();
    assert.equal(first.status, 0, first.stderr);
    const proposal = JSON.parse(first.stdout);
    const proposalFile = path.join(fixture.home, 'command-runner', 'proposals', proposal.proposalId + '.json');
    const modified = JSON.parse(await readFile(proposalFile, 'utf8'));
    modified.definition.description = 'This has changed after proposal and should be rejected.';
    await writeFile(proposalFile, JSON.stringify(modified));
    const denied = runV2(fixture, fixture.alpha, ['activate', proposal.proposalId]);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /stale_proposal/u);

    const clean = propose();
    assert.equal(clean.status, 0, clean.stderr);
    const cleanId = JSON.parse(clean.stdout).proposalId;
    const concurrent = runV2(fixture, fixture.alpha, [
      'propose', 'runtime-check',
      'definition=' + encodeURIComponent(JSON.stringify({
        description: 'Check runtime version with a separate registered definition after a concurrent change.',
        run: ['node', '--version'],
      })),
    ]);
    assert.equal(concurrent.status, 0, concurrent.stderr);
    const later = runV2(fixture, fixture.alpha, ['activate', JSON.parse(concurrent.stdout).proposalId]);
    assert.equal(later.status, 0, later.stderr);
    const stale = runV2(fixture, fixture.alpha, ['activate', cleanId]);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /stale_proposal/u);
  });
});

test('CLI package script proposal preserves old callers and accepts reviewed description', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {check: 'node --version'},
    }));
    const description = 'Run the check script for package validation without changing source files; inspect lifecycle hooks before execution.';
    const custom = runV2(fixture, fixture.alpha,
      ['propose', 'check', 'description=' + encodeURIComponent(description)]);
    assert.equal(custom.status, 0, custom.stderr);
    assert.equal(JSON.parse(custom.stdout).description, description);
    const older = runV2(fixture, fixture.alpha, ['propose', 'check']);
    assert.equal(older.status, 0, older.stderr);
    assert.match(JSON.parse(older.stdout).description, /Run npm package script/u);
    const accepted = runV2(fixture, fixture.alpha, ['activate', JSON.parse(older.stdout).proposalId]);
    assert.equal(accepted.status, 0, accepted.stderr);
  });
});

test('CLI registers scripts using oversized lockfiles without reading lockfile contents', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      scripts: {'type-check': 'node --version'},
    }));
    const lockfile = path.join(fixture.alpha, 'package-lock.json');
    const largeLock = JSON.stringify({
      name: 'test-project', lockfileVersion: 3, requires: true,
      packages: {'': {name: 'test-project', version: '1.0.0'}},
      padding: 'x'.repeat(1_048_576),
    });
    assert.ok(Buffer.byteLength(largeLock) > 1_048_576);
    await writeFile(lockfile, largeLock);

    const proposed = runV2(fixture, fixture.alpha, ['propose', 'type-check']);
    assert.equal(proposed.status, 0, proposed.stderr);
    const candidate = JSON.parse(proposed.stdout);
    assert.equal(candidate.status, 'pending_approval');
    assert.deepEqual(candidate.argv, ['npm', 'run', 'type-check', '--']);

    const activated = runV2(fixture, fixture.alpha, ['activate', candidate.proposalId]);
    assert.equal(activated.status, 0, activated.stderr);
    const executed = runV2(fixture, fixture.alpha, ['run', 'type-check']);
    assert.equal(executed.status, 0, executed.stderr);

    // The manager family remains part of the fingerprint; switching it blocks execution.
    await rm(lockfile);
    await writeFile(path.join(fixture.alpha, 'yarn.lock'), '# alternate manager\n');
    const stale = runV2(fixture, fixture.alpha, ['run', 'type-check']);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /stale_script_definition/u);
  });
});

test('CLI preserves package metadata security and reports specific discovery errors', async (t) => {
  await withFixture(async (fixture) => {
    const manifest = path.join(fixture.alpha, 'package.json');
    const npmLock = path.join(fixture.alpha, 'package-lock.json');
    const yarnLock = path.join(fixture.alpha, 'yarn.lock');
    const script = {scripts: {'type-check': 'node --version'}};
    const failedAs = (code) => {
      const result = runV2(fixture, fixture.alpha, ['propose', 'type-check']);
      assert.equal(result.status, 2, result.stdout);
      assert.equal(JSON.parse(result.stderr).error.code, code);
    };

    await writeFile(manifest, JSON.stringify({scripts: {lint: 'node --version'}}));
    failedAs('script_missing');

    await writeFile(manifest, JSON.stringify(script));
    failedAs('package_manager_undetermined');

    await writeFile(npmLock, '{}');
    await writeFile(yarnLock, '# lock');
    failedAs('package_manager_ambiguous');
    await rm(npmLock);
    await rm(yarnLock);

    await writeFile(manifest, '{not-json');
    failedAs('invalid_package_json');

    await writeFile(manifest, 'x'.repeat(1_048_577));
    failedAs('invalid_package_metadata');

    await writeFile(manifest, JSON.stringify({...script, packageManager: 'unknown@1.0.0'}));
    failedAs('invalid_package_manager');

    await writeFile(manifest, JSON.stringify(script));
    const externalLock = path.join(fixture.beta, 'external-lock.json');
    await writeFile(externalLock, '{}');
    try {
      await symlink(externalLock, npmLock);
    } catch (err) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) {
        t.diagnostic('lockfile symlink check skipped on this platform');
        return;
      }
      throw err;
    }
    failedAs('invalid_package_metadata');
  });
});

test('CLI Hook uses interactive approval for activation and rejects arbitrary shell', async () => {
  await withFixture(async (fixture) => {
    const invoke = (command) => runHook(fixture, {
      hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal', tool_input: {command},
    });
    const accepted = invoke('node ~/.copilot/skills/command-runner/scripts/cli.mjs workspace.ensure');
    assert.equal(JSON.parse(accepted.stdout).permissionDecision, 'allow');
    const proposedHook = invoke('node ~/.copilot/skills/command-runner/scripts/cli.mjs propose test');
    assert.equal(JSON.parse(proposedHook.stdout).permissionDecision, 'allow');
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {'test:unit': 'node echo-args.mjs'},
    }));
    const proposed = runV2(fixture, fixture.alpha, ['propose', 'unit', 'script=test%3Aunit']);
    assert.equal(proposed.status, 0, proposed.stderr);
    const candidate = JSON.parse(proposed.stdout);
    assert.deepEqual(candidate.argv, ['npm', 'run', 'test:unit', '--']);
    const proposalHook = invoke('node ~/.copilot/skills/command-runner/scripts/cli.mjs propose unit script=test%3Aunit');
    assert.equal(JSON.parse(proposalHook.stdout).permissionDecision, 'allow');
    const activate = invoke('node ~/.copilot/skills/command-runner/scripts/cli.mjs activate ' + candidate.proposalId);
    assert.equal(JSON.parse(activate.stdout).permissionDecision, 'ask');
    assert.match(JSON.parse(activate.stdout).permissionDecisionReason, /test:unit/u);
    assert.match(JSON.parse(activate.stdout).permissionDecisionReason, /node echo-args\.mjs/u);
    const rejected = invoke('node ~/.copilot/skills/command-runner/scripts/cli.mjs run test && npm publish');
    assert.equal(JSON.parse(rejected.stdout).permissionDecision, 'deny');
    const legacy = invoke('node ~/.copilot/skills/command-runner/scripts/gateway.mjs register test --expected-workspace=alpha definition=%7B%7D');
    assert.equal(JSON.parse(legacy.stdout).permissionDecision, 'deny');
    const legacyWorkspace = invoke('node ~/.copilot/skills/command-runner/scripts/gateway.mjs workspace-register alpha');
    assert.equal(JSON.parse(legacyWorkspace.stdout).permissionDecision, 'deny');
  });
});


test('CLI Hook requests one-time approval for an unregistered exact project root', async () => {
  await withFixture(async (fixture) => {
    const gamma = path.join(fixture.root, 'new-project');
    await mkdir(gamma);
    await writeFile(path.join(gamma, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {test: 'node --version'},
    }));
    const check = (cwd, reportedCwd = cwd) => spawnSync(process.execPath,
      [path.join(fixture.home, 'skills', 'command-runner', 'scripts', 'hook.mjs')], {
        cwd, encoding: 'utf8', env: {...process.env, COPILOT_HOME: fixture.home},
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal',
          cwd: reportedCwd,
          tool_input: {command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs workspace.ensure'},
        }),
      });
    const first = JSON.parse(check(gamma).stdout);
    assert.equal(first.permissionDecision, 'ask');
    assert.match(first.permissionDecisionReason, /new-project/u);
    const mismatch = JSON.parse(check(gamma, fixture.alpha).stdout);
    assert.equal(mismatch.permissionDecision, 'deny');
    const registered = runV2(fixture, gamma, ['workspace.ensure']);
    assert.equal(registered.status, 0, registered.stderr);
    const again = JSON.parse(check(gamma).stdout);
    assert.equal(again.permissionDecision, 'allow');
  });
});

test('CLI pnpm script candidates do not pass npm-only double-dash to the underlying script', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10.28.1', scripts: {check: 'tsc --noEmit --project tsconfig.json'},
    }));
    const proposed = runV2(fixture, fixture.alpha, ['propose', 'check']);
    assert.equal(proposed.status, 0, proposed.stderr);
    const candidate = JSON.parse(proposed.stdout);
    assert.deepEqual(candidate.argv, ['pnpm', 'run', 'check']);
    const activated = runV2(fixture, fixture.alpha, ['activate', candidate.proposalId]);
    assert.equal(activated.status, 0, activated.stderr);
    const config = JSON.parse(await readFile(path.join(fixture.home, 'command-runner', 'workspaces.json'), 'utf8'));
    assert.deepEqual(config.workspaces[0].commands.check.run, ['pnpm', 'run', 'check']);
    const guarded = runRunnerWithoutHashes(fixture, fixture.alpha, ['describe', 'check']);
    assert.equal(guarded.status, 0, guarded.stderr);
  });
});


test('CLI bounded proposal succeeds with a large unrelated script catalog', async () => {
  await withFixture(async (fixture) => {
    const scripts = { test: 'node --version' };
    for (let index = 0; index < 150; index += 1) {
      scripts['unrelated-' + index] = 'echo ' + 'x'.repeat(80);
    }
    await writeFile(path.join(fixture.alpha, 'package.json'),
      JSON.stringify({ packageManager: 'npm@10.0.0', scripts }));
    const result = runV2(fixture, fixture.alpha, ['propose', 'test']);
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, 'pending_approval');
    assert.equal(response.scriptPreview.test, 'node --version');
    assert.equal(response.scripts, undefined);
    const updated = { ...scripts, 'unrelated-149': 'echo changed' };
    await writeFile(path.join(fixture.alpha, 'package.json'),
      JSON.stringify({ packageManager: 'npm@10.0.0', scripts: updated }));
    const blocked = runV2(fixture, fixture.alpha, ['activate', response.proposalId]);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /stale_script_definition/u);
  });
});

test('CLI nested package inherits registered-root manager and detects parent changes', async () => {
  await withFixture(async (fixture) => {
    const nested = path.join(fixture.alpha, 'packages', 'lib');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(fixture.alpha, 'package.json'),
      JSON.stringify({ packageManager: 'npm@10.0.0', workspaces: ['packages/*'] }));
    await writeFile(path.join(nested, 'package.json'),
      JSON.stringify({ name: 'workspace-lib', scripts: { check: 'node --version' } }));
    const proposed = runV2(fixture, fixture.alpha, ['propose', 'check', 'packageDir=packages%2Flib']);
    assert.equal(proposed.status, 0, proposed.stderr);
    const candidate = JSON.parse(proposed.stdout);
    assert.deepEqual(candidate.argv, ['npm', 'run', 'check', '--']);
    assert.equal(candidate.cwd, path.join('packages', 'lib'));
    const registered = runV2(fixture, fixture.alpha, ['activate', candidate.proposalId]);
    assert.equal(registered.status, 0, registered.stderr);
    const executed = runV2(fixture, fixture.alpha, ['run', 'check']);
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).status, 'completed');
    await writeFile(path.join(fixture.alpha, 'package.json'),
      JSON.stringify({ packageManager: 'npm@11.0.0', workspaces: ['packages/*'] }));
    const stopped = runV2(fixture, fixture.alpha, ['run', 'check']);
    assert.equal(stopped.status, 2);
    assert.match(stopped.stderr, /stale_script_definition/u);
  });
});

test('documented installation includes every runner module inside the Skill', async () => {
  for (const doc of ['README.md', 'README_ja.md']) {
    const readme = await readFile(path.join(SOURCE_DIRECTORY, '..', 'references', doc), 'utf8');
    assert.ok(readme.includes('cp -R .copilot/skills/command-runner ~/.copilot/skills/'));
    for (const file of ['cli.mjs', 'runner.mjs', 'gateway.mjs', 'hook.mjs', 'script-guard.mjs', 'builtins.mjs']) {
      assert.ok(readme.includes('scripts/' + file), doc + ' does not document ' + file);
    }
  }
});


test('v3 allowlist preserves argv order, flags, values and multiple workspace files', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.alpha, 'tests', 'second.test.js'), 'export {};\n');
    const run = (...tokens) => runRunner(fixture, fixture.alpha, [
      'run', 'allowtest', ...tokens.map(token => 'arg=' + encodeURIComponent(token)),
    ]);
    const result = run('--coverage', '--runTestsByPath', 'tests/sample.test.js',
      '--maxWorkers=50%', 'tests/second.test.js', '--testNamePattern=ログイン');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(result.stdout).stdout), [
      '--coverage', '--runTestsByPath', 'tests/sample.test.js',
      '--maxWorkers=50%', 'tests/second.test.js', '--testNamePattern=ログイン',
    ]);

    const withSpace = path.join(fixture.alpha, 'tests', 'a space.test.js');
    await writeFile(withSpace, 'export {};\n');
    const spaced = run('--runTestsByPath', 'tests/a space.test.js');
    assert.equal(spaced.status, 0, spaced.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(spaced.stdout).stdout),
      ['--runTestsByPath', 'tests/a space.test.js']);

    const config = run('--config=tests/sample.test.js');
    assert.equal(config.status, 0, config.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(config.stdout).stdout),
      ['--config=tests/sample.test.js']);
  }, (cfg) => {
    cfg.workspaces[0].commands.allowtest = {
      description: 'Allowlisted test invocation.',
      run: [process.execPath, 'echo-args.mjs'], cwd: '.', arguments: {},
      allow: ['--coverage', '--maxWorkers=value', '--testNamePattern=value',
        '--config=path', '--runTestsByPath path...'],
    };
    return cfg;
  });
});

test('v3 allowlist rejects undeclared options, missing values and workspace escapes', async () => {
  await withFixture(async (fixture) => {
    const blocked = (...tokens) => {
      const result = runRunner(fixture, fixture.alpha, ['run', 'allowtest',
        ...tokens.map(token => 'arg=' + encodeURIComponent(token))]);
      assert.equal(result.status, 2, result.stdout);
      assert.match(result.stderr, /invalid_argument/u);
    };
    blocked('--unknown');
    blocked('tests/sample.test.js');
    blocked('--runTestsByPath');
    blocked('--runTestsByPath', '--coverage');
    blocked('--runTestsByPath', 'tests/sample.test.js', '--unknown');
    blocked('--runTestsByPath', '../beta/echo-args.mjs');
    blocked('--config=/tmp/outside.json');
    blocked('--coverage=1');
    blocked('--coverage', '--coverage');
    blocked('--maxWorkers', '--coverage');
    blocked('--config', 'not-found.json');
    blocked('--runTestsByPath', 'tests');
  }, (cfg) => {
    cfg.workspaces[0].commands.allowtest = {
      description: 'Bounded test invocation.',
      run: [process.execPath, 'echo-args.mjs'], cwd: '.', arguments: {},
      allow: ['--coverage', '--maxWorkers=value', '--config=path', '--runTestsByPath path...'],
    };
    return cfg;
  });
});

test('v3 fixed mode rejects arg= and malformed allow definitions fail closed', async () => {
  await withFixture(async (fixture) => {
    const fixed = runRunner(fixture, fixture.alpha, ['run', 'timeout', 'arg=--coverage']);
    assert.equal(fixed.status, 2);
    assert.match(fixed.stderr, /invalid_argument/u);
  });
  for (const invalid of [
    ['--coverage', '--coverage=value'],
    ['--runTestsByPath path...', '--other path...'],
    ['--x=value', '--x=path'],
    ['--weird=integer'],
    [],
  ]) {
    await withFixture(async (fixture) => {
      const result = runRunner(fixture, fixture.alpha, ['list']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /invalid_config/u);
    }, (cfg) => {
      cfg.workspaces[0].commands.invalid = {
        description: 'Invalid rule.', run: [process.execPath, 'echo-args.mjs'],
        cwd: '.', arguments: {}, allow: invalid,
      };
      return cfg;
    });
  }
});

test('v3 propose and activate bind allowlist to the approved npm script', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.alpha, 'package.json'),
      JSON.stringify({ packageManager: 'npm@10.0.0',
        scripts: { test: 'node echo-args.mjs' } }));
    const allow = ['--coverage', '--runTestsByPath path...'];
    const proposal = runV2(fixture, fixture.alpha, [
      'propose', 'test', 'allow=' + encodeURIComponent(JSON.stringify(allow)),
    ]);
    assert.equal(proposal.status, 0, proposal.stderr);
    const pending = JSON.parse(proposal.stdout);
    assert.deepEqual(pending.arguments, {});
    const hook = runHook(fixture, { tool_name: 'execute/runInTerminal',
      tool_input: { command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs activate ' + pending.proposalId } });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, 'ask');
    assert.match(hook.stdout, /--runTestsByPath path\.\.\./u);
    const activated = runV2(fixture, fixture.alpha, ['activate', pending.proposalId]);
    assert.equal(activated.status, 0, activated.stderr);
    const executed = runV2(fixture, fixture.alpha, [
      'run', 'test', 'arg=--coverage',
    ]);
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).status, 'completed');
    const rejected = runV2(fixture, fixture.alpha, ['run', 'test', 'arg=--updateSnapshot']);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /invalid_argument/u);
  });
});


test('v3 path arguments use the command cwd and reject external symlinks', async () => {
  await withFixture(async (fixture) => {
    const cwd = path.join(fixture.alpha, 'packages', 'web');
    await mkdir(path.join(cwd, 'tests'), {recursive: true});
    await writeFile(path.join(cwd, 'tests', 'local.test.js'), 'export {};\n');
    await symlink(fixture.beta, path.join(cwd, 'external'), 'dir');

    const invoke = (...args) => runRunner(fixture, fixture.alpha, [
      'run', 'nestedtest', ...args.map(arg => 'arg=' + encodeURIComponent(arg)),
    ]);
    const allowed = invoke('--runTestsByPath', 'tests/local.test.js');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(allowed.stdout).stdout),
      ['--runTestsByPath', 'tests/local.test.js']);

    for (const pathArg of ['external/echo-args.mjs', '../../../beta/echo-args.mjs',
      '/tmp/a.test.js']) {
      const rejected = invoke('--runTestsByPath', pathArg);
      assert.equal(rejected.status, 2, rejected.stdout);
      assert.match(rejected.stderr, /invalid_argument/u);
    }
  }, cfg => {
    cfg.workspaces[0].commands.nestedtest = {
      description: 'Nested workspace paths.',
      run: [process.execPath, '../../echo-args.mjs'], cwd: 'packages/web',
      arguments: {}, allow: ['--runTestsByPath path...'],
    };
    return cfg;
  });
});

test('v3 proposal update presents previous and next allowlist under exact CAS', async () => {
  await withFixture(async fixture => {
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: { test: 'node echo-args.mjs' },
    }));
    const next = ['--coverage'];
    const proposal = runV2(fixture, fixture.alpha, [
      'propose', 'test', 'allow=' + encodeURIComponent(JSON.stringify(next)),
    ]);
    assert.equal(proposal.status, 0, proposal.stderr);
    const pending = JSON.parse(proposal.stdout);
    assert.equal(pending.action, 'update');
    const preview = runHook(fixture, {
      tool_name: 'execute/runInTerminal',
      tool_input: {command: 'node ~/.copilot/skills/command-runner/scripts/cli.mjs activate ' + pending.proposalId},
    });
    assert.equal(preview.status, 0, preview.stderr);
    const response = JSON.parse(preview.stdout);
    assert.equal(response.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(response.hookSpecificOutput.permissionDecisionReason, /previousAllow/u);
    assert.match(response.hookSpecificOutput.permissionDecisionReason, /--runInBand/u);
    assert.match(response.hookSpecificOutput.permissionDecisionReason, /--coverage/u);

    const updated = runV2(fixture, fixture.alpha, ['activate', pending.proposalId]);
    assert.equal(updated.status, 0, updated.stderr);
    const denied = runV2(fixture, fixture.alpha, ['run', 'test', 'arg=--runInBand']);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /invalid_argument/u);
    const allowed = runV2(fixture, fixture.alpha, ['run', 'test', 'arg=--coverage']);
    assert.equal(allowed.status, 0, allowed.stderr);
  }, cfg => {
    cfg.workspaces[0].commands.test = {
      description: 'Previously allowed test.', cwd: '.',
      run: [process.execPath, 'echo-args.mjs'],
      arguments: {}, allow: ['--runInBand'],
    };
    return cfg;
  });
});

test('v3 Hook accepts ordered encoded arg tokens but rejects raw shell syntax', async () => {
  await withFixture(async fixture => {
    const cli = 'node ~/.copilot/skills/command-runner/scripts/cli.mjs';
    const allowed = runHook(fixture, {
      tool_name: 'execute/runInTerminal',
      tool_input: {command: cli + ' run sample arg=--testNamePattern%3D%E8%AA%8D%E8%A8%BC%2F%E7%99%BB%E9%8C%B2'},
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, 'allow');
    const denied = runHook(fixture, {
      tool_name: 'execute/runInTerminal',
      tool_input: {command: cli + ' run sample arg=--testNamePattern=hello;echo'},
    });
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});


test('v3 Hook accepts fully escaped apostrophes and parentheses without shell parsing', async () => {
  await withFixture(async fixture => {
    const encodeSafe = value => encodeURIComponent(value).replace(/[!'()*]/gu,
      letter => '%' + letter.charCodeAt(0).toString(16).toUpperCase());
    const word = "--testNamePattern=it's (fine)";
    const command = 'node ~/.copilot/skills/command-runner/scripts/cli.mjs run sample arg=' + encodeSafe(word);
    const hook = runHook(fixture, {
      tool_name: 'execute/runInTerminal', tool_input: { command },
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(JSON.parse(hook.stdout).permissionDecision, 'allow');
    const raw = runHook(fixture, {
      tool_name: 'execute/runInTerminal',
      tool_input: { command: "node ~/.copilot/skills/command-runner/scripts/cli.mjs run sample arg=it's" },
    });
    assert.equal(JSON.parse(raw.stdout).permissionDecision, 'deny');
  });
});
