import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CORE_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner.mjs');
const INTERFACE_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-interface.mjs');
const HOOK_SOURCE = path.join(SOURCE_DIRECTORY, 'command-runner-hook.mjs');
const AGENT_SOURCE = path.join(SOURCE_DIRECTORY, '..', 'agents', 'CommandRunner.agent.md');
const RESPONSE_LIMIT = 12_288;

const STUB_CORE = String.raw`#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const config = JSON.parse(await readFile(path.join(process.env.COPILOT_HOME, 'command-runner', 'stub.json'), 'utf8'));
const cwd = path.resolve(process.cwd());
const workspace = config.workspaces
  .filter((entry) => cwd === entry.root || cwd.startsWith(entry.root + path.sep))
  .sort((a, b) => b.root.length - a.root.length)[0];
const emit = (value, stream = process.stdout) => stream.write(JSON.stringify(value) + '\n');
if (!workspace) {
  emit({ status: 'error', error: { code: 'workspace_not_registered', message: 'workspace not registered' } }, process.stderr);
  process.exit(2);
}
const [operation, id, ...args] = process.argv.slice(2);
const publicCommand = ([commandId, command]) => ({ id: commandId, description: command.description, arguments: command.arguments ?? [] });
if (operation === 'list') {
  emit({ workspaceId: workspace.id, commands: Object.entries(workspace.commands).map(publicCommand) });
} else if (operation === 'describe') {
  const command = workspace.commands[id];
  if (!command) {
    emit({ status: 'error', error: { code: 'command_not_registered', message: 'command not registered' } }, process.stderr);
    process.exit(2);
  }
  emit({ workspaceId: workspace.id, command: publicCommand([id, command]) });
} else if (operation === 'run') {
  const command = workspace.commands[id];
  if (!command) {
    emit({ status: 'error', error: { code: 'command_not_registered', message: 'command not registered' } }, process.stderr);
    process.exit(2);
  }
  const size = command.outputBytes ?? 0;
  const stdout = (command.stdout ?? 'x').repeat(size || 1).slice(0, size || (command.stdout ?? 'x').length);
  const stderr = (command.stderr ?? '').repeat(size || 1).slice(0, command.stderr ? size : 0);
  emit({
    status: command.exitCode ? 'failed' : 'completed',
    workspaceId: workspace.id,
    commandId: id,
    arguments: Object.fromEntries(args.map((token) => [token.split('=', 1)[0], decodeURIComponent(token.slice(token.indexOf('=') + 1))])),
    cwd: '.',
    exitCode: command.exitCode ?? 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdout,
    stderr,
  });
} else {
  emit({ status: 'error', error: { code: 'usage', message: 'unsupported operation' } }, process.stderr);
  process.exit(2);
}
`;

async function makeFixture(commandCount = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dandori-command-runner-'));
  const home = path.join(root, 'home');
  const commandRunner = path.join(home, 'command-runner');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  await mkdir(commandRunner, { recursive: true });
  await mkdir(alpha);
  await mkdir(beta);
  await writeFile(path.join(commandRunner, 'command-runner-interface.mjs'), await readFile(INTERFACE_SOURCE));
  await writeFile(path.join(commandRunner, 'command-runner-hook.mjs'), await readFile(HOOK_SOURCE));
  await writeFile(path.join(commandRunner, 'command-runner.mjs'), STUB_CORE);

  const commands = {};
  for (let index = 0; index < commandCount; index += 1) {
    commands[`cmd_${String(index).padStart(3, '0')}`] = { description: `Command ${index}` };
  }
  commands.large = { description: 'Large output.', outputBytes: 40_000, stdout: 'a', stderr: 'b', exitCode: 1 };
  commands.echo = { description: 'Echo.', stdout: 'ok' };
  commands.unicode = { description: 'Multibyte output.', outputBytes: 5_000, stdout: `${'a'.repeat(26)}あ` };
  const config = {
    workspaces: [
      { id: 'alpha', root: alpha, commands },
      { id: 'beta', root: beta, commands: { beta: { description: 'Beta.' } } },
    ],
  };
  await writeFile(path.join(commandRunner, 'stub.json'), JSON.stringify(config));
  await writeFile(path.join(commandRunner, 'workspaces.json'), `${JSON.stringify(config, null, 2)}\n`);
  return { root, home, alpha, beta, commandRunner };
}

async function makeManagementFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dandori-command-runner-management-'));
  const home = path.join(root, 'home');
  const commandRunner = path.join(home, 'command-runner');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  await mkdir(commandRunner, { recursive: true });
  await mkdir(alpha);
  await mkdir(beta);
  await writeFile(path.join(commandRunner, 'command-runner-interface.mjs'), await readFile(INTERFACE_SOURCE));
  await writeFile(path.join(commandRunner, 'command-runner-hook.mjs'), await readFile(HOOK_SOURCE));
  await writeFile(path.join(commandRunner, 'command-runner.mjs'), await readFile(CORE_SOURCE));
  await writeFile(
    path.join(alpha, 'echo-args.mjs'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
  );
  await writeFile(
    path.join(beta, 'echo-args.mjs'),
    'process.stdout.write("beta");\n',
  );
  const command = (description, extra = []) => ({
    description,
    run: [process.execPath, 'echo-args.mjs', ...extra],
    cwd: '.',
    arguments: {},
  });
  const config = {
    version: 1,
    defaults: { timeoutMs: 10_000, maxOutputBytes: 16_384 },
    workspaces: [
      {
        id: 'alpha',
        root: alpha,
        commands: {
          keep: command('Keep.'),
          remove: command('Remove.'),
        },
      },
      {
        id: 'beta',
        root: beta,
        commands: { beta: command('Beta.') },
      },
    ],
  };
  await writeFile(path.join(commandRunner, 'workspaces.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { root, home, alpha, beta, commandRunner };
}

async function withFixture(callback, count) {
  const fixture = await makeFixture(count);
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function withManagementFixture(callback) {
  const fixture = await makeManagementFixture();
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function runInterface(fixture, cwd, args) {
  return spawnSync(
    process.execPath,
    [path.join(fixture.commandRunner, 'command-runner-interface.mjs'), ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, COPILOT_HOME: fixture.home } },
  );
}

function runHook(fixture, toolInput) {
  return spawnSync(
    process.execPath,
    [path.join(fixture.commandRunner, 'command-runner-hook.mjs')],
    {
      cwd: fixture.alpha,
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'execute/runInTerminal',
        tool_input: toolInput,
      }),
    },
  );
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= RESPONSE_LIMIT, `response too large: ${Buffer.byteLength(result.stdout)}`);
  return JSON.parse(result.stdout);
}

function parseFailure(result, code) {
  assert.equal(result.status, 2, result.stdout);
  const output = JSON.parse(result.stderr);
  assert.equal(output.error.code, code);
  return output;
}

test('agent lives under agents and exposes only the bounded interface', async () => {
  const source = await readFile(AGENT_SOURCE, 'utf8');
  assert.match(source, /^name: CommandRunner$/mu);
  assert.match(source, /^tools:\n  - execute\/runInTerminal$/mu);
  assert.match(source, /command-runner-interface\.mjs list/u);
  assert.match(source, /command-runner-interface\.mjs register/u);
  assert.match(source, /command-runner-interface\.mjs unregister/u);
  assert.match(source, /command-runner-interface\.mjs output/u);
  assert.doesNotMatch(source, /read\/readFile/u);
});

test('list is paged, searchable, and bounded with many registered commands', async () => {
  await withFixture(async (fixture) => {
    const first = parseSuccess(runInterface(fixture, fixture.alpha, ['list']));
    assert.equal(first.commandIds.length, 100);
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 100);
    assert.ok(first.total > 150);

    const second = parseSuccess(runInterface(fixture, fixture.alpha, ['list', 'offset=100']));
    assert.ok(second.commandIds.length > 0);
    assert.equal(second.offset, 100);

    const filtered = parseSuccess(runInterface(fixture, fixture.alpha, ['list', 'query=cmd_14']));
    assert.deepEqual(filtered.commandIds, Array.from({ length: 10 }, (_, index) => `cmd_14${index}`));
  }, 160);
});

test('describe returns one bounded command definition and stable hash', async () => {
  await withFixture(async (fixture) => {
    const first = parseSuccess(runInterface(fixture, fixture.alpha, ['describe', 'echo']));
    const second = parseSuccess(runInterface(fixture, fixture.alpha, ['describe', 'echo']));
    assert.equal(first.workspaceId, 'alpha');
    assert.equal(first.command.id, 'echo');
    assert.match(first.definitionHash, /^sha256-[0-9a-f]{64}$/u);
    assert.equal(first.definitionHash, second.definitionHash);
  });
});

test('register adds only a new validated command in the current workspace', async () => {
  await withManagementFixture(async (fixture) => {
    const definition = {
      description: 'Registered command.',
      run: [process.execPath, 'echo-args.mjs', '--registered'],
      cwd: '.',
      arguments: {},
    };
    const registered = parseSuccess(runInterface(fixture, fixture.alpha, [
      'register',
      'added',
      `definition=${encodeURIComponent(JSON.stringify(definition))}`,
    ]));
    assert.equal(registered.workspaceId, 'alpha');
    assert.equal(registered.commandId, 'added');
    assert.match(registered.definitionHash, /^sha256-[0-9a-f]{64}$/u);

    const described = parseSuccess(runInterface(fixture, fixture.alpha, ['describe', 'added']));
    assert.equal(described.definitionHash, registered.definitionHash);
    assert.equal(described.command.description, 'Registered command.');

    const run = parseSuccess(runInterface(fixture, fixture.alpha, ['run', 'added']));
    assert.equal(run.commandId, 'added');
    assert.match(run.stdoutPreview, /--registered/u);

    const config = JSON.parse(await readFile(path.join(fixture.commandRunner, 'workspaces.json'), 'utf8'));
    assert.deepEqual(config.workspaces[0].commands.added, definition);
    assert.equal('added' in config.workspaces[1].commands, false);
  });
});

test('register rejects duplicate IDs and invalid definitions without mutating configuration', async () => {
  await withManagementFixture(async (fixture) => {
    const configPath = path.join(fixture.commandRunner, 'workspaces.json');
    const before = await readFile(configPath, 'utf8');
    parseFailure(runInterface(fixture, fixture.alpha, [
      'register',
      'keep',
      `definition=${encodeURIComponent(JSON.stringify({ description: 'Replacement.', run: ['echo'], cwd: '.', arguments: {} }))}`,
    ]), 'command_already_registered');
    assert.equal(await readFile(configPath, 'utf8'), before);

    parseFailure(runInterface(fixture, fixture.alpha, [
      'register',
      'invalid',
      `definition=${encodeURIComponent(JSON.stringify({ description: 'Missing run.', cwd: '.', arguments: {} }))}`,
    ]), 'invalid_config');
    assert.equal(await readFile(configPath, 'utf8'), before);
  });
});

test('unregister uses definition-hash CAS and cannot remove the last workspace command', async () => {
  await withManagementFixture(async (fixture) => {
    const configPath = path.join(fixture.commandRunner, 'workspaces.json');
    const described = parseSuccess(runInterface(fixture, fixture.alpha, ['describe', 'remove']));
    const before = await readFile(configPath, 'utf8');

    parseFailure(runInterface(fixture, fixture.alpha, [
      'unregister',
      'remove',
      `expected=sha256-${'0'.repeat(64)}`,
    ]), 'stale_definition');
    assert.equal(await readFile(configPath, 'utf8'), before);

    const removed = parseSuccess(runInterface(fixture, fixture.alpha, [
      'unregister',
      'remove',
      `expected=${described.definitionHash}`,
    ]));
    assert.equal(removed.removedDefinitionHash, described.definitionHash);
    const after = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal('remove' in after.workspaces[0].commands, false);

    const keep = parseSuccess(runInterface(fixture, fixture.alpha, ['describe', 'keep']));
    parseFailure(runInterface(fixture, fixture.alpha, [
      'unregister',
      'keep',
      `expected=${keep.definitionHash}`,
    ]), 'last_command');
  });
});

test('run stores large stdout and stderr while returning only compact metadata', async () => {
  await withFixture(async (fixture) => {
    const output = parseSuccess(runInterface(fixture, fixture.alpha, ['run', 'large', 'secret=value']));
    assert.equal(output.workspaceId, 'alpha');
    assert.equal(output.commandId, 'large');
    assert.equal(output.status, 'failed');
    assert.equal(output.stdoutBytes, 40_000);
    assert.equal(output.stderrBytes, 40_000);
    assert.equal('stdout' in output, false);
    assert.equal('stderr' in output, false);
    assert.equal('arguments' in output, false);
    assert.ok(Buffer.byteLength(output.stdoutPreview) <= 512);
    assert.ok(Buffer.byteLength(output.stderrPreview) <= 512);

    const directory = path.join(fixture.home, 'command-runner', 'executions', 'alpha', output.executionId);
    assert.equal((await readFile(path.join(directory, 'stdout.log'), 'utf8')).length, 40_000);
    assert.equal((await readFile(path.join(directory, 'stderr.log'), 'utf8')).length, 40_000);
  });
});

test('output reads only bounded chunks and can continue by offset', async () => {
  await withFixture(async (fixture) => {
    const run = parseSuccess(runInterface(fixture, fixture.alpha, ['run', 'large']));
    const first = parseSuccess(runInterface(fixture, fixture.alpha, [
      'output', run.executionId, 'stream=stdout',
    ]));
    assert.equal(first.offset, 0);
    assert.equal(first.data.length, 1_536);
    assert.equal(first.eof, false);
    const second = parseSuccess(runInterface(fixture, fixture.alpha, [
      'output', run.executionId, 'stream=stdout', `offset=${first.nextOffset}`,
    ]));
    assert.equal(second.offset, first.nextOffset);
    assert.equal(second.data.length, 1_536);
  });
});

test('output preserves UTF-8 text across byte-bounded chunks', async () => {
  await withFixture(async (fixture) => {
    const run = parseSuccess(runInterface(fixture, fixture.alpha, ['run', 'unicode']));
    const directory = path.join(fixture.home, 'command-runner', 'executions', 'alpha', run.executionId);
    const expected = await readFile(path.join(directory, 'stdout.log'), 'utf8');
    let offset = 0;
    let actual = '';
    let firstNextOffset = null;
    while (true) {
      const output = parseSuccess(runInterface(fixture, fixture.alpha, [
        'output', run.executionId, 'stream=stdout', `offset=${offset}`,
      ]));
      assert.equal(output.offset, offset);
      assert.doesNotMatch(output.data, /\uFFFD/u);
      assert.ok(Buffer.byteLength(output.data) <= 1_536);
      assert.ok(output.nextOffset > offset || output.eof);
      if (firstNextOffset === null) firstNextOffset = output.nextOffset;
      actual += output.data;
      offset = output.nextOffset;
      if (output.eof) break;
    }
    assert.ok(firstNextOffset < 1_536, 'first chunk should stop before a split multibyte character');
    assert.equal(actual, expected);

    const misaligned = runInterface(fixture, fixture.alpha, [
      'output', run.executionId, 'stream=stdout', 'offset=1535',
    ]);
    assert.equal(misaligned.status, 2);
    assert.match(misaligned.stderr, /UTF-8 character boundary/u);
  });
});

test('execution output is scoped to the current workspace', async () => {
  await withFixture(async (fixture) => {
    const run = parseSuccess(runInterface(fixture, fixture.alpha, ['run', 'echo']));
    const denied = runInterface(fixture, fixture.beta, [
      'output', run.executionId, 'stream=stdout',
    ]);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /execution is unavailable/u);
  });
});

test('expired execution directories are cleaned before a new run', async () => {
  await withFixture(async (fixture) => {
    const executionRoot = path.join(fixture.home, 'command-runner', 'executions', 'alpha');
    const expired = '20000101T000000.000Z_00000000-0000-4000-8000-000000000000';
    await mkdir(path.join(executionRoot, expired), { recursive: true });
    await writeFile(path.join(executionRoot, expired, 'stdout.log'), 'old');
    await writeFile(path.join(executionRoot, expired, 'stderr.log'), '');
    parseSuccess(runInterface(fixture, fixture.alpha, ['run', 'echo']));
    const entries = await readdir(executionRoot);
    assert.equal(entries.includes(expired), false);
  });
});

test('hook permits only bounded execution and management interface shapes', async () => {
  await withFixture(async (fixture) => {
    for (const command of [
      'node ~/.copilot/command-runner/command-runner-interface.mjs list query=test',
      'node ~/.copilot/command-runner/command-runner-interface.mjs describe echo',
      'node ~/.copilot/command-runner/command-runner-interface.mjs register lint definition=%7B%22description%22%3A%22Lint%22%7D',
      `node ~/.copilot/command-runner/command-runner-interface.mjs unregister echo expected=sha256-${'0'.repeat(64)}`,
      'node ~/.copilot/command-runner/command-runner-interface.mjs run echo',
      'node ~/.copilot/command-runner/command-runner-interface.mjs output 20260829T010203.004Z_00000000-0000-4000-8000-000000000000 stream=stdout',
    ]) {
      const result = runHook(fixture, { command });
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'allow');
    }

    for (const toolInput of [
      { command: 'node ~/.copilot/command-runner/command-runner.mjs list' },
      { command: 'npm test' },
      { command: 'node ~/.copilot/command-runner/command-runner-interface.mjs register lint other=value' },
      { command: 'node ~/.copilot/command-runner/command-runner-interface.mjs unregister echo other=value' },
      { command: 'node ~/.copilot/command-runner/command-runner-interface.mjs output ../../secret stream=stdout' },
      { command: 'node ~/.copilot/command-runner/command-runner-interface.mjs list', env: { BAD: '1' } },
      { command: 'node ~/.copilot/command-runner/command-runner-interface.mjs list', isBackground: true },
    ]) {
      const result = runHook(fixture, toolInput);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }
  });
});
