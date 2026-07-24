import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner.mjs');
const HOOK_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-hook.mjs');
const AGENT_SOURCE = path.join(SOURCE_DIRECTORY, '..', 'agents', 'CommandRunner.agent.md');

async function makeWorkspace(configure = (configuration) => configuration) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-runner-test-'));
  const runnerDirectory = path.join(root, '.github', 'command-runner');
  await mkdir(runnerDirectory, { recursive: true });
  await writeFile(path.join(runnerDirectory, 'command-runner.mjs'), await readFile(RUNNER_SOURCE));
  await writeFile(path.join(runnerDirectory, 'command-runner-hook.mjs'), await readFile(HOOK_SOURCE));
  await writeFile(path.join(root, 'echo-args.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'tests', 'sample.test.js'), 'export {};\n');

  const configuration = configure({
    version: 1,
    defaults: {
      timeoutMs: 10_000,
      maxOutputBytes: 16_384,
    },
    commands: {
      sample: {
        description: 'Echo validated arguments.',
        run: [process.execPath, 'echo-args.mjs', '--'],
        cwd: '.',
        arguments: {
          enabled: {
            kind: 'flag',
            token: '--enabled',
          },
          count: {
            kind: 'option',
            token: '--count',
            value: {
              type: 'integer',
              min: 1,
              max: 8,
            },
          },
          mode: {
            kind: 'option',
            token: '--mode',
            value: {
              type: 'choice',
              values: ['fast', 'safe'],
            },
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
            value: {
              type: 'string',
              maxLength: 100,
            },
          },
        },
      },
    },
  });
  await writeFile(path.join(root, '.github', 'command-runner.json'), `${JSON.stringify(configuration, null, 2)}\n`);
  return root;
}

function runRunner(root, args) {
  return spawnSync(process.execPath, ['.github/command-runner/command-runner.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function runHook(root, input) {
  return spawnSync(process.execPath, ['.github/command-runner/command-runner-hook.mjs'], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(input),
  });
}

async function withWorkspace(callback, configure) {
  const root = await makeWorkspace(configure);
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('workspace agent remains caller-agnostic and fixed-runner-only', async () => {
  const source = await readFile(AGENT_SOURCE, 'utf8');
  assert.match(source, /^name: CommandRunner$/mu);
  assert.match(source, /^user-invocable: false$/mu);
  assert.match(source, /^disable-model-invocation: true$/mu);
  assert.match(source, /tools:\n  - execute\/runInTerminal\nagents: \[\]/u);
  assert.match(source, /node \.github\/command-runner\/command-runner\.mjs list/u);
  assert.match(source, /Do not execute a raw project command\./u);
  assert.doesNotMatch(source, /\b(?:DANDORI|Orchestrator|Task Card|TFR|TFC|Flow Ledger)\b/u);
});

test('list exposes IDs and argument constraints without fixed argv', async () => {
  await withWorkspace(async (root) => {
    const result = runRunner(root, ['list']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commands[0].id, 'sample');
    assert.equal(output.commands[0].description, 'Echo validated arguments.');
    assert.equal('run' in output.commands[0], false);
    assert.deepEqual(output.commands[0].arguments.map(({ name }) => name), ['enabled', 'count', 'mode', 'file', 'text']);
  });
});

test('run builds deterministic argv from typed named arguments', async () => {
  await withWorkspace(async (root) => {
    const result = runRunner(root, [
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
    assert.equal(output.commandId, 'sample');
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
  await withWorkspace(async (root) => {
    const result = runRunner(root, ['run', 'sample', 'text=%24%28touch%20owned%29']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(JSON.parse(output.stdout), ['--', '$(touch owned)']);
  });
});

test('unknown arguments and out-of-range values are denied', async () => {
  await withWorkspace(async (root) => {
    const unknown = runRunner(root, ['run', 'sample', 'other=value']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unregistered parameter/u);

    const outOfRange = runRunner(root, ['run', 'sample', 'count=99']);
    assert.equal(outOfRange.status, 2);
    assert.match(outOfRange.stderr, /must be between 1 and 8/u);
  });
});

test('workspace path traversal and symlink escapes are denied', async (t) => {
  await withWorkspace(async (root) => {
    const traversal = runRunner(root, ['run', 'sample', 'file=..%2Foutside.test.js']);
    assert.equal(traversal.status, 2);
    assert.match(traversal.stderr, /escapes the workspace root/u);

    const internalTarget = path.join(root, 'tests', 'secret.txt');
    const internalAlias = path.join(root, 'tests', 'alias.test.js');
    await writeFile(internalTarget, 'secret\n');
    try {
      await symlink(internalTarget, internalAlias);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable on this platform');
        return;
      }
      throw error;
    }
    const disguisedExtension = runRunner(root, ['run', 'sample', 'file=tests%2Falias.test.js']);
    assert.equal(disguisedExtension.status, 2);
    assert.match(disguisedExtension.stderr, /disallowed extension/u);

    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.test.js`);
    await writeFile(outside, 'export {};\n');
    await symlink(outside, path.join(root, 'tests', 'linked.test.js'));
    const escaped = runRunner(root, ['run', 'sample', 'file=tests%2Flinked.test.js']);
    assert.equal(escaped.status, 2);
    assert.match(escaped.stderr, /resolves outside the workspace root/u);
    await rm(outside, { force: true });
  });
});

test('duplicate configuration keys fail closed', async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, '.github', 'command-runner.json'), '{"version":1,"version":1,"commands":{}}');
    const result = runRunner(root, ['list']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /duplicate key/u);
  });
});

test('dynamic arguments cannot be attached to known inline-code forms', async () => {
  await withWorkspace(async (root) => {
    const result = runRunner(root, ['list']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /inline-code execution form/u);
  }, (configuration) => {
    configuration.commands.sample.run = ['node', '-e', 'console.log(process.argv[1])'];
    return configuration;
  });
});

test('hook permits canonical runner calls and denies raw or compound commands', async () => {
  await withWorkspace(async (root) => {
    const allowed = runHook(root, {
      hook_event_name: 'PreToolUse',
      tool_name: 'execute/runInTerminal',
      tool_input: {
        command: 'node .github/command-runner/command-runner.mjs run sample count=4',
      },
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, 'allow');

    const raw = runHook(root, {
      hook_event_name: 'PreToolUse',
      tool_name: 'execute/runInTerminal',
      tool_input: { command: 'npm test' },
    });
    assert.equal(JSON.parse(raw.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const compound = runHook(root, {
      hook_event_name: 'PreToolUse',
      tool_name: 'execute/runInTerminal',
      tool_input: {
        command: 'node .github/command-runner/command-runner.mjs list && npm publish',
      },
    });
    assert.equal(JSON.parse(compound.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('hook ignores non-terminal tools', async () => {
  await withWorkspace(async (root) => {
    const result = runHook(root, {
      hook_event_name: 'PreToolUse',
      tool_name: 'read/readFile',
      tool_input: { path: 'README.md' },
    });
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  });
});

test('hook denies agent writes to command-runner control files', async () => {
  await withWorkspace(async (root) => {
    const result = runHook(root, {
      hook_event_name: 'PreToolUse',
      tool_name: 'edit/editFiles',
      tool_input: {
        files: [
          {
            path: '.github/command-runner.json',
            replacement: '{}',
          },
        ],
      },
    });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const traversalPath = runHook(root, {
      hook_event_name: 'PreToolUse',
      tool_name: 'edit/editFiles',
      tool_input: {
        files: [
          {
            path: '.github/command-runner/../command-runner.json',
            replacement: '{}',
          },
        ],
      },
    });
    assert.equal(JSON.parse(traversalPath.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const unrelated = runHook(root, {
      hook_event_name: 'PreToolUse',
      tool_name: 'edit/editFiles',
      tool_input: {
        files: [
          {
            path: 'src/example.js',
            replacement: 'export {};',
          },
        ],
      },
    });
    assert.deepEqual(JSON.parse(unrelated.stdout), { continue: true });
  });
});
