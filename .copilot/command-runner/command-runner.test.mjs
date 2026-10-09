import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const INTERFACE_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-interface.mjs');
const HOOK_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-hook.mjs');
const AGENT_SOURCE = path.join(SOURCE_DIRECTORY, '..', 'agents', 'CommandRunner.agent.md');

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
    path.join(home, 'command-runner', 'command-runner-interface.mjs'),
    await readFile(INTERFACE_SOURCE),
  );
  await writeFile(
    path.join(home, 'command-runner', 'command-runner-hook.mjs'),
    await readFile(HOOK_SOURCE),
  );
  await writeFile(
    path.join(home, 'agents', 'CommandRunner.agent.md'),
    await readFile(AGENT_SOURCE),
  );
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

function runRunner(fixture, cwd, args) {
  const guardedArgs = args[0] === 'run' && !args[2]?.startsWith('--expected-workspace=')
    ? [...args.slice(0, 2), '--expected-workspace=alpha', ...args.slice(2)]
    : args;
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

function runInterface(fixture, cwd, args) {
  const guardedArgs = args[0] === 'run' && !args[2]?.startsWith('--expected-workspace=')
    ? [...args.slice(0, 2), '--expected-workspace=alpha', ...args.slice(2)]
    : args;
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

test('distributed agent is user-level, agent-scoped, and fixed-runner-only', async () => {
  const source = await readFile(AGENT_SOURCE, 'utf8');
  assert.match(source, /^name: CommandRunner$/mu);
  assert.match(source, /^user-invocable: false$/mu);
  assert.match(source, /^disable-model-invocation: true$/mu);
  assert.match(source, /tools:\n  - execute\/runInTerminal\nagents: \[\]\nhooks:/u);
  assert.match(source, /command: node ~\/\.copilot\/command-runner\/command-runner-hook\.mjs/u);
  assert.match(source, /timeout: 30/u);
  assert.match(source, /node ~\/\.copilot\/command-runner\/command-runner-interface\.mjs list/u);
  assert.match(source, /node ~\/\.copilot\/command-runner\/command-runner-interface\.mjs output/u);
  assert.match(source, /Do not execute a raw project command\./u);
  assert.match(source, /description: >-[\s\S]*?Command searches/u);
  assert.match(source, /are filtered, paginated, and scoped to the active workspace/u);
  assert.match(source, /Terminal cwd may differ from the editor-opened workspace/u);
  assert.match(source, /require evidence that it is the same directory before registration/u);
  assert.match(source, /A filtered or incomplete miss proves no absence/u);
  assert.match(source, /Before reporting a command missing, confirm the returned `workspaceId`/u);
  assert.match(source, /Do not claim a command is unregistered solely from a query miss/u);
  assert.match(source, /Do not specify, override, or infer a workspace ID/u);
  assert.match(source, /Never request a terminal working-directory/u);
  assert.doesNotMatch(
    source,
    /\b(?:DANDORI|Orchestrator|Task Card|TFR|TFC|Flow Ledger)\b/u,
  );
});

test('list exposes commands only for the current workspace', async () => {
  await withFixture(async (fixture) => {
    const alpha = runRunner(fixture, fixture.alpha, ['list']);
    assert.equal(alpha.status, 0, alpha.stderr);
    const alphaOutput = JSON.parse(alpha.stdout);
    assert.equal(alphaOutput.workspaceId, 'alpha');
    assert.deepEqual(
      alphaOutput.commands.map(({ id }) => id),
      ['sample', 'create', 'timeout', 'tree-timeout'],
    );
    assert.equal('run' in alphaOutput.commands[0], false);

    const beta = runRunner(fixture, fixture.beta, ['list']);
    assert.equal(beta.status, 0, beta.stderr);
    const betaOutput = JSON.parse(beta.stdout);
    assert.equal(betaOutput.workspaceId, 'beta');
    assert.deepEqual(betaOutput.commands.map(({ id }) => id), ['beta']);
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

    const second = runInterface(fixture, fixture.alpha, ['list', `offset=${start.nextOffset}`]);
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
    assert.deepEqual(JSON.parse(result.stdout).commands, []);
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
    assert.match(mismatch.stderr, /workspace_identity_changed/u);
    await assert.rejects(readFile(path.join(fixture.beta, 'wrong-workspace.txt')), { code: 'ENOENT' });
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
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs run sample --expected-workspace=alpha count=4',
      },
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(
      JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision,
      'allow',
    );

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

test('hook denies terminal execution overrides and background execution', async () => {
  await withFixture(async (fixture) => {
    for (const toolInput of [
      {
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs list',
        cwd: fixture.beta,
      },
      {
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs list',
        env: { TEST: '1' },
      },
      {
        command: 'node ~/.copilot/command-runner/command-runner-interface.mjs list',
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

test('hook ignores non-terminal tools except writes to control files', async () => {
  await withFixture(async (fixture) => {
    const read = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      tool_name: 'read/readFile',
      tool_input: { path: 'README.md' },
    });
    assert.deepEqual(JSON.parse(read.stdout), { continue: true });

    const protectedWrite = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      tool_name: 'edit/editFiles',
      tool_input: {
        files: [
          {
            path: '~/.copilot/command-runner/workspaces.json',
            replacement: '{}',
          },
        ],
      },
    });
    assert.equal(
      JSON.parse(protectedWrite.stdout).hookSpecificOutput.permissionDecision,
      'deny',
    );

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
