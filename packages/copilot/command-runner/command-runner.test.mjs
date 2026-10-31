import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner.mjs');
const BUILTIN_SOURCE = path.join(SOURCE_DIRECTORY, 'builtin-commands.mjs');
const SCRIPT_GUARD_SOURCE = path.join(SOURCE_DIRECTORY, 'script-guard.mjs');
const V2_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-v2.mjs');
const INTERFACE_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-interface.mjs');
const HOOK_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-hook.mjs');
const AGENT_SOURCES = ['Researcher', 'Writer'].map(name => path.join(SOURCE_DIRECTORY, '..', 'agents', `${name}.agent.md`));

async function makeFixture(configure = (configuration) => configuration) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-runner-test-'));
  const home = path.join(root, 'copilot-home');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');

  await mkdir(path.join(home, 'command-runner'), { recursive: true });
  await mkdir(path.join(home, 'agents'), { recursive: true });
  await mkdir(path.join(alpha, 'tests'), { recursive: true });
  await mkdir(beta, { recursive: true });

  await writeFile(
    path.join(home, 'command-runner', 'command-runner.mjs'),
    await readFile(RUNNER_SOURCE),
  );
  await writeFile(
    path.join(home, 'command-runner', 'builtin-commands.mjs'),
    await readFile(BUILTIN_SOURCE),
  );
  await writeFile(path.join(home, 'command-runner', 'script-guard.mjs'), await readFile(SCRIPT_GUARD_SOURCE));
  await writeFile(path.join(home, 'command-runner', 'command-runner-v2.mjs'), await readFile(V2_SOURCE));
  await writeFile(
    path.join(home, 'command-runner', 'command-runner-interface.mjs'),
    await readFile(INTERFACE_SOURCE),
  );
  await writeFile(
    path.join(home, 'command-runner', 'command-runner-hook.mjs'),
    await readFile(HOOK_SOURCE),
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
    [path.join(fixture.home, 'command-runner', 'command-runner.mjs'), ...guardedArgs],
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
    [path.join(fixture.home, 'command-runner', 'command-runner.mjs'), ...args],
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
    [path.join(fixture.home, 'command-runner', 'command-runner-interface.mjs'), ...guardedArgs],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, COPILOT_HOME: fixture.home },
    },
  );
}

function runHook(fixture, input) {
  return spawnSync(
    process.execPath,
    [path.join(fixture.home, 'command-runner', 'command-runner-hook.mjs')],
    {
      cwd: fixture.alpha,
      encoding: 'utf8',
      env: {...process.env, COPILOT_HOME: fixture.home},
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
    assert.match(source, /  - execute\/runInTerminal\n  - execute\nagents: \[\]\nhooks:/u);
    assert.match(source, /command-runner-hook\.mjs/u);
    assert.match(source, /node ~\/\.copilot\/command-runner\/command-runner-v2\.mjs/u);
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
      path.join(fixture.home, 'command-runner', 'command-runner-interface.mjs'), 'list',
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
    const corePath = path.join(fixture.home, 'command-runner', 'command-runner.mjs');
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
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs run sample --expected-workspace=alpha --expected-identity=sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --expected-definition=sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb count=4',
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
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs run sample --expected-workspace=alpha count=4',
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
          command: `node ~/.copilot/command-runner/command-runner-interface.mjs run sample --expected-workspace=alpha ${partial}`,
        },
      });
      assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }

    const directCore = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      cwd: fixture.alpha,
      tool_name: 'execute/runInTerminal',
      tool_input: { command: 'node ~/.copilot/command-runner/command-runner.mjs list' },
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
          'node ~/.copilot/command-runner/command-runner-interface.mjs list && npm publish',
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
    const accepted = 'node ~/.copilot/command-runner/command-runner-interface.mjs list --expected-workspace=alpha';
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
    const accepted = 'node ~/.copilot/command-runner/command-runner-interface.mjs list --expected-workspace=alpha';
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
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs list --expected-workspace=alpha',
        cwd: fixture.beta,
      },
      {
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs list --expected-workspace=alpha',
        env: { TEST: '1' },
      },
      {
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs list --expected-workspace=alpha',
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
      '~/.copilot/command-runner/builtin-commands.mjs',
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
  });
});

test('hook fails closed for unknown terminal names in both harness envelopes', async () => {
  await withFixture(async (fixture) => {
    const accepted = 'node ~/.copilot/command-runner/command-runner-interface.mjs list --expected-workspace=alpha';
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
    assert.equal(run('builtin-git-show', ['commit=HEAD']).status, 'failed');
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


function runV2(fixture, cwd, args) {
  return spawnSync(process.execPath,
    [path.join(fixture.home, 'command-runner', 'command-runner-v2.mjs'), ...args],
    {cwd, encoding: 'utf8', env: {...process.env, COPILOT_HOME: fixture.home}});
}

test('v2 self-onboarding registers only a project root, without caller-supplied workspace ID', async () => {
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

test('v2 proposes inert npm scripts, activates exact candidate, and detects changed script definitions', async () => {
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

test('v2 Hook uses interactive approval for activation and rejects arbitrary shell', async () => {
  await withFixture(async (fixture) => {
    const invoke = (command) => runHook(fixture, {
      hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal', tool_input: {command},
    });
    const accepted = invoke('node ~/.copilot/command-runner/command-runner-v2.mjs workspace.ensure');
    assert.equal(JSON.parse(accepted.stdout).permissionDecision, 'allow');
    const proposedHook = invoke('node ~/.copilot/command-runner/command-runner-v2.mjs propose test');
    assert.equal(JSON.parse(proposedHook.stdout).permissionDecision, 'allow');
    await writeFile(path.join(fixture.alpha, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {'test:unit': 'node echo-args.mjs'},
    }));
    const proposed = runV2(fixture, fixture.alpha, ['propose', 'unit', 'script=test%3Aunit']);
    assert.equal(proposed.status, 0, proposed.stderr);
    const candidate = JSON.parse(proposed.stdout);
    assert.deepEqual(candidate.argv, ['npm', 'run', 'test:unit', '--']);
    const proposalHook = invoke('node ~/.copilot/command-runner/command-runner-v2.mjs propose unit script=test%3Aunit');
    assert.equal(JSON.parse(proposalHook.stdout).permissionDecision, 'allow');
    const activate = invoke('node ~/.copilot/command-runner/command-runner-v2.mjs activate ' + candidate.proposalId);
    assert.equal(JSON.parse(activate.stdout).permissionDecision, 'ask');
    assert.match(JSON.parse(activate.stdout).permissionDecisionReason, /test:unit/u);
    assert.match(JSON.parse(activate.stdout).permissionDecisionReason, /node echo-args\.mjs/u);
    const rejected = invoke('node ~/.copilot/command-runner/command-runner-v2.mjs run test && npm publish');
    assert.equal(JSON.parse(rejected.stdout).permissionDecision, 'deny');
    const legacy = invoke('node ~/.copilot/command-runner/command-runner-interface.mjs register test --expected-workspace=alpha definition=%7B%7D');
    assert.equal(JSON.parse(legacy.stdout).permissionDecision, 'ask');
    const legacyWorkspace = invoke('node ~/.copilot/command-runner/command-runner-interface.mjs workspace-register alpha');
    assert.equal(JSON.parse(legacyWorkspace.stdout).permissionDecision, 'ask');
  });
});


test('v2 Hook requests one-time approval for an unregistered exact project root', async () => {
  await withFixture(async (fixture) => {
    const gamma = path.join(fixture.root, 'new-project');
    await mkdir(gamma);
    await writeFile(path.join(gamma, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0', scripts: {test: 'node --version'},
    }));
    const check = (cwd, reportedCwd = cwd) => spawnSync(process.execPath,
      [path.join(fixture.home, 'command-runner', 'command-runner-hook.mjs')], {
        cwd, encoding: 'utf8', env: {...process.env, COPILOT_HOME: fixture.home},
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: 'execute/runInTerminal',
          cwd: reportedCwd,
          tool_input: {command: 'node ~/.copilot/command-runner/command-runner-v2.mjs workspace.ensure'},
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

test('v2 pnpm script candidates do not pass npm-only double-dash to the underlying script', async () => {
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


test('v2 bounded proposal succeeds with a large unrelated script catalog', async () => {
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

test('v2 nested package inherits registered-root manager and detects parent changes', async () => {
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

test('documented installation copies all runtime-dependent runner modules', async () => {
  for (const doc of ['README.md', 'README_ja.md']) {
    const readme = await readFile(path.join(SOURCE_DIRECTORY, doc), 'utf8');
    for (const file of ['command-runner.mjs', 'command-runner-interface.mjs',
      'command-runner-hook.mjs', 'script-guard.mjs', 'command-runner-v2.mjs', 'builtin-commands.mjs']) {
      assert.ok(readme.includes('cp .copilot/command-runner/' + file + ' ~/.copilot/command-runner/'),
        doc + ' does not install ' + file);
    }
  }
});
