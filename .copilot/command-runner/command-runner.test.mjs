import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
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
const HOOK_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-hook.mjs');
const AGENT_SOURCE = path.join(SOURCE_DIRECTORY, 'CommandRunner.agent.md');

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
  return spawnSync(
    process.execPath,
    [path.join(fixture.home, 'command-runner', 'command-runner.mjs'), ...args],
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
  assert.match(source, /node ~\/\.copilot\/command-runner\/command-runner\.mjs list/u);
  assert.match(source, /Do not execute a raw project command\./u);
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
      ['sample', 'create', 'timeout'],
    );
    assert.equal('run' in alphaOutput.commands[0], false);

    const beta = runRunner(fixture, fixture.beta, ['list']);
    assert.equal(beta.status, 0, beta.stderr);
    const betaOutput = JSON.parse(beta.stdout);
    assert.equal(betaOutput.workspaceId, 'beta');
    assert.deepEqual(betaOutput.commands.map(({ id }) => id), ['beta']);
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

test('hook permits canonical runner calls and denies raw or compound commands', async () => {
  await withFixture(async (fixture) => {
    const allowed = runHook(fixture, {
      hook_event_name: 'PreToolUse',
      cwd: fixture.alpha,
      tool_name: 'execute/runInTerminal',
      tool_input: {
        command: 'node ~/.copilot/command-runner/command-runner.mjs run sample count=4',
      },
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(
      JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision,
      'allow',
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
          'node ~/.copilot/command-runner/command-runner.mjs list && npm publish',
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
        command: 'node ~/.copilot/command-runner/command-runner.mjs list',
        cwd: fixture.beta,
      },
      {
        command: 'node ~/.copilot/command-runner/command-runner.mjs list',
        env: { TEST: '1' },
      },
      {
        command: 'node ~/.copilot/command-runner/command-runner.mjs list',
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
