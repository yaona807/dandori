#!/usr/bin/env node
// Fixed, registration-free workspace operations. No arbitrary shell/argv input.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TRASH = '.agent-trash';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CURRENT = fileURLToPath(import.meta.url);
const file = (mustExist = true) => ({ type: 'workspace-file', mustExist });
const positional = (value) => ({ kind: 'positional', required: true, value });
const option = (token, value) => ({ kind: 'option', value });

const SPECS = {
  'builtin-fs-move': { description: 'Move or rename one regular workspace file without overwriting.', arguments: { source: positional(file()), destination: positional(file(false)) } },
  'builtin-fs-copy': { description: 'Copy one regular workspace file without overwriting.', arguments: { source: positional(file()), destination: positional(file(false)) } },
  'builtin-fs-trash': { description: 'Move one regular workspace file to the ignored workspace trash.', arguments: { source: positional(file()) } },
  'builtin-fs-restore': { description: 'Restore one trash item without overwriting its original path.', arguments: { itemId: positional({ type: 'string', maxLength: 36 }) } },
  'builtin-fs-trash-list': { description: 'List restorable workspace trash items.', arguments: {} },
  'builtin-git-status': { description: 'Read repository status without optional index refresh.', arguments: {} },
  'builtin-git-diff': { description: 'Read scoped unstaged or staged repository diff.', arguments: { scope: option('--scope', { type: 'choice', values: ['unstaged', 'staged'] }), file: option('--file', file(false)) } },
  'builtin-git-log': { description: 'Read bounded repository history.', arguments: { count: option('--count', { type: 'integer', min: 1, max: 100 }) } },
  'builtin-git-show': { description: 'Read one full-SHA commit without external diff execution.', arguments: { commit: positional({ type: 'string', maxLength: 40 }) } },
  'builtin-git-ls-files': { description: 'List tracked repository files.', arguments: { file: option('--file', file(false)) } },
  'builtin-git-branch-info': { description: 'Read the current repository branch.', arguments: {} },
};

export function builtinDefinitions() {
  return Object.fromEntries(Object.entries(SPECS).map(([id, spec]) => [id, {
    description: spec.description,
    cwd: '.',
    run: [process.execPath, CURRENT, id],
    arguments: spec.arguments,
    timeoutMs: 60_000,
    maxOutputBytes: 1_048_576,
  }]));
}

export function isBuiltinId(id) {
  return Object.hasOwn(SPECS, id);
}

function refuse(message) {
  throw new Error(message);
}
function inside(root, full) {
  const r = path.relative(root, full);
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
}
async function infoOrNull(full) {
  try { return await lstat(full); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

// Reject symlinks at every path component and protect Git and trash internals.
// This is defense against accidental redirection, not a substitute for OS sandboxing
// against hostile processes racing filesystem changes.
async function workspacePath(root, input, allowMissingLeaf = false) {
  if (typeof input !== 'string' || !input || path.isAbsolute(input) || input.includes('\0')) {
    refuse('a nonempty workspace-relative path is required');
  }
  const full = path.resolve(root, input);
  const relative = path.relative(root, full);
  if (!inside(root, full) || relative === '') refuse('path outside workspace or workspace root');
  const parts = relative.split(path.sep);
  if (parts.some((part) => part === '.git' || part === TRASH)) refuse('protected workspace path');
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const state = await infoOrNull(current);
    if (!state) {
      if (i === parts.length - 1 && allowMissingLeaf) return full;
      refuse('path or destination parent does not exist');
    }
    if (state.isSymbolicLink()) refuse('symlink paths are not supported');
    if (i !== parts.length - 1 && !state.isDirectory()) refuse('path parent is not a directory');
    if (i === parts.length - 1 && !state.isFile()) refuse('only regular files are supported');
  }
  return full;
}

async function existingRegular(full) {
  const state = await infoOrNull(full);
  if (!state || !state.isFile() || state.isSymbolicLink()) refuse('regular file required');
  return state;
}

async function noReplaceMove(from, to) {
  if (from === to) refuse('source and destination are identical');
  const sourceInfo = await existingRegular(from);
  if (await infoOrNull(to)) refuse('destination already exists');
  // link(2) creates the destination exclusively; rename(2) may overwrite it.
  // Same-filesystem files only. On unlink failure, leave both links for recovery.
  await link(from, to);
  const targetInfo = await existingRegular(to);
  if (sourceInfo.dev !== targetInfo.dev || sourceInfo.ino !== targetInfo.ino) {
    refuse('file identity changed while moving');
  }
  const beforeRemoval = await existingRegular(from);
  if (beforeRemoval.dev !== sourceInfo.dev || beforeRemoval.ino !== sourceInfo.ino) {
    refuse('source identity changed while moving');
  }
  await unlink(from);
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  env.GIT_EXTERNAL_DIFF = '';
  return env;
}
function git(root, args, allowNonRepo = false) {
  const result = spawnSync('git', [
    '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=', ...args,
  ], {
    cwd: root, env: gitEnvironment(), encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024, timeout: 30_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowNonRepo && result.status === 128 && /not a git repository/u.test(result.stderr ?? '')) return null;
    refuse('git failed: ' + String(result.stderr || result.status).slice(0, 500));
  }
  return result.stdout;
}
async function gitRepoRoot(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if ((await realpath(top.trim())) !== root) refuse('Git repository root must equal the selected workspace root');
}
async function trashDirectory(root) {
  const directory = path.join(root, TRASH);
  const existing = await infoOrNull(directory);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) refuse('unsafe trash directory');
  const tracked = git(root, ['ls-files', '--cached', '-z', '--', TRASH], true);
  if (tracked !== null && tracked.length) refuse('trash directory is already Git-tracked');
  if (!existing) await mkdir(directory, { mode: 0o700 });
  const ignore = path.join(directory, '.gitignore');
  const ignoreState = await infoOrNull(ignore);
  if (!ignoreState) await writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 });
  else if (!ignoreState.isFile() || ignoreState.isSymbolicLink()
    || await readFile(ignore, 'utf8') !== '*\n') refuse('unsafe trash ignore configuration');
  return directory;
}

async function trash(root, source) {
  const from = await workspacePath(root, source);
  const directory = await trashDirectory(root);
  const id = randomUUID();
  const itemDir = path.join(directory, id);
  await mkdir(itemDir, { mode: 0o700 });
  const original = path.relative(root, from);
  const filename = path.basename(from);
  await writeFile(path.join(itemDir, 'manifest.json'),
    JSON.stringify({ id, original, filename, createdAt: new Date().toISOString() }) + '\n',
    { flag: 'wx', mode: 0o600 });
  await noReplaceMove(from, path.join(itemDir, filename));
  return { itemId: id, original, trashPath: path.relative(root, path.join(itemDir, filename)) };
}

async function loadItem(root, id) {
  if (!UUID.test(id)) refuse('invalid trash item ID');
  const dir = await trashDirectory(root);
  const item = path.join(dir, id);
  const state = await infoOrNull(item);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) refuse('trash item does not exist');
  const manifestFile = path.join(item, 'manifest.json');
  const manifestState = await existingRegular(manifestFile);
  if (manifestState.size > 8192) refuse('trash manifest too large');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.id !== id || typeof manifest.original !== 'string' ||
    typeof manifest.filename !== 'string' || manifest.filename !== path.basename(manifest.original)) {
    refuse('invalid trash manifest');
  }
  const fileInTrash = path.join(item, manifest.filename);
  if (!inside(item, fileInTrash) || fileInTrash === item) refuse('unsafe trash item');
  await existingRegular(fileInTrash);
  return { manifest, fileInTrash };
}

async function restore(root, id) {
  const { manifest, fileInTrash } = await loadItem(root, id);
  const dest = await workspacePath(root, manifest.original, true);
  await noReplaceMove(fileInTrash, dest);
  return { itemId: id, restored: manifest.original };
}

async function trashList(root) {
  const dir = await trashDirectory(root);
  const names = (await readdir(dir)).filter((v) => UUID.test(v)).sort();
  if (names.length > 1000) refuse('trash listing exceeds safety limit');
  const items = [];
  for (const id of names) {
    try {
      const { manifest } = await loadItem(root, id);
      items.push({ itemId: id, original: manifest.original, createdAt: manifest.createdAt });
    } catch { /* incomplete or restored entries are not restorable */ }
  }
  return { items };
}

function parseInput(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      if (!['--scope', '--file', '--count'].includes(token) || i + 1 >= argv.length || token in options) {
        refuse('unsupported or duplicate builtin option');
      }
      options[token] = argv[++i];
    } else positionals.push(token);
  }
  return { positionals, options };
}
async function gitAction(root, id, positionals, options) {
  await gitRepoRoot(root);
  const readPath = options['--file'] === undefined
    ? null : path.relative(root, await workspacePath(root, options['--file'], true));
  let args;
  if (id === 'builtin-git-status') args = ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignore-submodules=all'];
  else if (id === 'builtin-git-diff') {
    const scope = options['--scope'] ?? 'unstaged';
    if (!['unstaged', 'staged'].includes(scope)) refuse('invalid diff scope');
    args = ['--literal-pathspecs', 'diff', ...(scope === 'staged' ? ['--cached'] : []),
      '--no-ext-diff', '--no-textconv', '--ignore-submodules=all',
      ...(readPath ? ['--', readPath] : [])];
  } else if (id === 'builtin-git-log') {
    const count = options['--count'] ?? '20';
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/u.test(count)) refuse('invalid history count');
    args = ['log', '--no-show-signature', '--format=%h %s', '-n', count];
  } else if (id === 'builtin-git-show') {
    if (positionals.length !== 1 || !/^[a-f0-9]{40}$/iu.test(positionals[0])) refuse('full commit SHA required');
    args = ['show', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--ignore-submodules=all', positionals[0]];
  } else if (id === 'builtin-git-ls-files') {
    args = ['--literal-pathspecs', 'ls-files', '--cached', '-z', ...(readPath ? ['--', readPath] : [])];
  } else if (id === 'builtin-git-branch-info') args = ['branch', '--show-current'];
  else refuse('unsupported builtin Git operation');
  return { output: git(root, args) };
}

async function runBuiltin() {
  const [id, ...args] = process.argv.slice(2);
  if (!isBuiltinId(id)) refuse('unknown builtin operation');
  const root = await realpath(process.cwd());
  const { positionals, options } = parseInput(args);
  if (id.startsWith('builtin-git-')) return gitAction(root, id, positionals, options);
  if (Object.keys(options).length) refuse('filesystem builtins do not accept options');
  if (id === 'builtin-fs-move' || id === 'builtin-fs-copy') {
    if (positionals.length !== 2) refuse('source and destination required');
    const source = await workspacePath(root, positionals[0]);
    const destination = await workspacePath(root, positionals[1], true);
    if (id === 'builtin-fs-move') await noReplaceMove(source, destination);
    else await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    return { source: positionals[0], destination: positionals[1] };
  }
  if (id === 'builtin-fs-trash') {
    if (positionals.length !== 1) refuse('source required');
    return trash(root, positionals[0]);
  }
  if (id === 'builtin-fs-restore') {
    if (positionals.length !== 1) refuse('item ID required');
    return restore(root, positionals[0]);
  }
  if (id === 'builtin-fs-trash-list') {
    if (positionals.length) refuse('trash listing accepts no arguments');
    return trashList(root);
  }
  refuse('unsupported builtin');
}

if (process.argv[1] && path.resolve(process.argv[1]) === CURRENT) {
  try {
    const result = await runBuiltin();
    process.stdout.write(JSON.stringify({ status: 'completed', ...result }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'error', message: String(error?.message ?? error) }) + '\n');
    process.exitCode = 1;
  }
}
