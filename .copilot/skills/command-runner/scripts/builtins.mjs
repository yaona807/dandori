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
// Preserve caller-supplied spelling so the helper can reject symlink components.
const file = () => ({ type: 'string', maxLength: 4096 });
const positional = (value) => ({ kind: 'positional', required: true, value });
const option = (token, value) => ({ kind: 'option', token, value });
const requiredOption = (token, value) => ({ kind: 'option', token, value, required: true });
const repeatedOption = (token, value, maxItems = 16) => ({ kind: 'option', token, value, repeatable: true, maxItems });
const choice = (...values) => ({ type: 'choice', values });
const reference = () => ({ type: 'string', maxLength: 256 });
const number = (min, max) => ({ type: 'integer', min, max });

const SPECS = {
  'builtin-fs-move': { description: 'Move/rename one existing regular file between workspace-relative paths; destination parent must exist. No overwrite, symlink traversal, directory operation, or cross-filesystem fallback.', arguments: { source: positional(file()), destination: positional(file(false)) } },
  'builtin-fs-copy': { description: 'Copy one existing regular file between workspace-relative paths; destination parent must exist. No overwrite, symlink traversal, or directory copy.', arguments: { source: positional(file()), destination: positional(file(false)) } },
  'builtin-fs-trash': { description: 'Move one existing regular file from a workspace-relative path to workspace-local .agent-trash/<itemId>/payload (not the OS trash). Returns itemId for builtin-fs-restore. Rejects tracked trash directories; no overwrite or permanent deletion.', arguments: { source: positional(file()) } },
  'builtin-fs-restore': { description: 'Restore a .agent-trash itemId to its original workspace-relative file path; original parent must exist. No overwrite, permanent deletion, directory restore, or symlink traversal.', arguments: { itemId: positional({ type: 'string', maxLength: 36 }) } },
  'builtin-fs-trash-list': { description: 'Read restorable .agent-trash items (itemId, original path, createdAt) in the current workspace; offset and limit bound pagination. Read-only; does not restore or delete files.', arguments: { offset: option('--offset', { type: 'integer', min: 0, max: 100000000 }), limit: option('--limit', { type: 'integer', min: 1, max: 100 }) } },
  'builtin-git-status': { description: 'Read Git status including tracked changes and untracked files when repository root equals current workspace. No index refresh, staging, or writes.', arguments: {} },
  'builtin-git-diff': { description: 'Read unstaged, staged or commit-to-commit Git diff with optional workspace-relative files; branch comparison supported. No index refresh, staging, or writes.', arguments: {
    scope: option('--scope', choice('unstaged', 'staged', 'commits')),
    base: option('--base', reference()), target: option('--target', reference()),
    comparison: option('--comparison', choice('direct', 'merge-base')),
    format: option('--format', choice('patch', 'stat', 'name-only', 'check')),
    file: repeatedOption('--file', file()),
  } },
  'builtin-git-log': { description: 'Read up to 100 Git commit summaries or range-filtered history (default 20); no repository changes.', arguments: {
    count: option('--count', number(1, 100)), range: option('--range', reference()),
    format: option('--format', choice('summary', 'oneline', 'full', 'graph')),
    author: option('--author', reference()), grep: option('--grep', reference()),
    file: repeatedOption('--file', file()),
  } },
  'builtin-git-show': { description: 'Read one Git commit reference (full 40-character SHA, HEAD or branch), optionally scoped to workspace-relative files; no writes.', arguments: {
    commit: positional(reference()), format: option('--format', choice('patch', 'stat', 'name-only')),
    file: repeatedOption('--file', file()),
  } },
  'builtin-git-ls-files': { description: 'List Git-tracked or other indexed files, optionally restricted to workspace-relative paths. Read-only.', arguments: {
    mode: option('--mode', choice('tracked', 'untracked', 'modified', 'deleted')),
    file: repeatedOption('--file', file()),
  } },
  'builtin-git-branch-info': { description: 'Read the current Git branch name only when repository root matches the current workspace; does not switch branches or write.', arguments: {} },
  'builtin-git-branch': { description: 'List local, remote or all branches, and inspect merged/containing refs. Never creates, modifies or deletes branches.', arguments: {
    scope: option('--scope', choice('local', 'remote', 'all', 'current')),
    contains: option('--contains', reference()), merged: option('--merged', reference()),
    pattern: option('--pattern', reference()),
  } },
  'builtin-git-blame': { description: 'Read line history of one workspace-relative file, optionally at a commit and within an inclusive line interval.', arguments: {
    file: requiredOption('--file', file()), ref: option('--ref', reference()),
    start: option('--start', number(1, 100000000)), end: option('--end', number(1, 100000000)),
  } },
  'builtin-git-grep': { description: 'Search Git tracked content for an explicit pattern without a pager or external search program.', arguments: {
    pattern: requiredOption('--pattern', { type: 'string', maxLength: 1024 }),
    mode: option('--mode', choice('fixed', 'regex')),
    case: option('--case', choice('sensitive', 'ignore')),
    output: option('--output', choice('lines', 'files', 'count')),
    file: repeatedOption('--file', file()),
  } },
  'builtin-git-merge-base': { description: 'Read the best common ancestor of two Git commit references without changing repository state.', arguments: {
    left: requiredOption('--left', reference()), right: requiredOption('--right', reference()),
  } },
  'builtin-git-rev-parse': { description: 'Resolve and verify one Git revision as a full or abbreviated object ID.', arguments: {
    ref: requiredOption('--ref', reference()), format: option('--format', choice('full', 'short')),
  } },
  'builtin-git-rev-list': { description: 'List commits in a bounded revision range or count matching commits.', arguments: {
    range: requiredOption('--range', reference()), count: option('--count', number(1, 100)),
    format: option('--format', choice('hashes', 'count')),
  } },
  'builtin-git-worktree': { description: 'List Git worktrees in human-readable or porcelain format; no add, move, prune or remove.', arguments: {
    format: option('--format', choice('text', 'porcelain')),
  } },
  'builtin-git-reflog': { description: 'Read Git reference move history, optionally for a selected ref and bounded count.', arguments: {
    ref: option('--ref', reference()), count: option('--count', number(1, 100)),
  } },
  'builtin-git-range-diff': { description: 'Compare two commit ranges, for example before and after rebase, without rewriting history.', arguments: {
    oldRange: requiredOption('--old-range', reference()), newRange: requiredOption('--new-range', reference()),
  } },
  'builtin-git-ls-tree': { description: 'Read the tree for a Git revision, optionally recursively and restricted to workspace-relative paths.', arguments: {
    ref: requiredOption('--ref', reference()), recursive: option('--recursive', choice('true', 'false')),
    format: option('--format', choice('names', 'full')), file: repeatedOption('--file', file()),
  } },
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
  if (parts.some((part) => part.toLowerCase() === '.git' || part.toLowerCase() === TRASH)) refuse('protected workspace path');
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
function git(root, args, allowNonRepo = false, allowNoMatch = false) {
  const result = spawnSync('git', [
    '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=', ...args,
  ], {
    cwd: root, env: gitEnvironment(), encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024, timeout: 30_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowNoMatch && result.status === 1) return result.stdout;
    if (allowNonRepo && result.status === 128 && /not a git repository/u.test(result.stderr ?? '')) return null;
    refuse('git failed: ' + String(result.stderr || result.status).slice(0, 500));
  }
  return result.stdout;
}
async function gitRepoRoot(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if ((await realpath(top.trim())) !== root) refuse('Git repository root must equal the selected workspace root');
}
async function trashDirectory(root, create = false) {
  const directory = path.join(root, TRASH);
  const existing = await infoOrNull(directory);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) refuse('unsafe trash directory');
  const tracked = git(root, ['ls-files', '--cached', '-z', '--', TRASH], true);
  if (tracked !== null && tracked.length) refuse('trash directory is already Git-tracked');
  if (!existing) {
    if (!create) return null;
    await mkdir(directory, { mode: 0o700 });
  }
  const ignore = path.join(directory, '.gitignore');
  const ignoreState = await infoOrNull(ignore);
  if (!ignoreState && create) await writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 });
  else if (!ignoreState) refuse('trash ignore configuration is missing');
  else if (!ignoreState.isFile() || ignoreState.isSymbolicLink()
    || await readFile(ignore, 'utf8') !== '*\n') refuse('unsafe trash ignore configuration');
  return directory;
}

async function trash(root, source) {
  const from = await workspacePath(root, source);
  const directory = await trashDirectory(root, true);
  const id = randomUUID();
  const itemDir = path.join(directory, id);
  await mkdir(itemDir, { mode: 0o700 });
  const original = path.relative(root, from);
  const filename = path.basename(from);
  await writeFile(path.join(itemDir, 'manifest.json'),
    JSON.stringify({ id, original, filename, createdAt: new Date().toISOString() }) + '\n',
    { flag: 'wx', mode: 0o600 });
  const payload = path.join(itemDir, 'payload');
  await noReplaceMove(from, payload);
  return { itemId: id, original, trashPath: path.relative(root, payload) };
}

async function loadItem(root, id) {
  if (!UUID.test(id)) refuse('invalid trash item ID');
  const dir = await trashDirectory(root);
  if (!dir) refuse('trash directory does not exist');
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
  const fileInTrash = path.join(item, 'payload');
  if (!inside(item, fileInTrash)) refuse('unsafe trash item');
  await existingRegular(fileInTrash);
  return { manifest, fileInTrash };
}

async function restore(root, id) {
  const { manifest, fileInTrash } = await loadItem(root, id);
  const dest = await workspacePath(root, manifest.original, true);
  await noReplaceMove(fileInTrash, dest);
  return { itemId: id, restored: manifest.original };
}

async function trashList(root, offset, limit) {
  const dir = await trashDirectory(root);
  if (!dir) return { items: [], nextOffset: null };
  const names = (await readdir(dir)).filter((v) => UUID.test(v)).sort();
  const items = [];
  let restorable = 0;
  for (const id of names) {
    try {
      const { manifest } = await loadItem(root, id);
      if (restorable >= offset && items.length < limit) {
        items.push({ itemId: id, original: manifest.original, createdAt: manifest.createdAt });
      } else if (items.length === limit) {
        return { items, nextOffset: offset + items.length };
      }
      restorable += 1;
    } catch { /* incomplete or restored entries are not restorable */ }
  }
  return { items, nextOffset: null };
}

// Only internal option names declared in SPECS are accepted. The Worker does not
// supply raw git argv; named parameters are mapped to a fixed Git invocation.
function parseInput(id, argv) {
  const specs = SPECS[id].arguments;
  const known = new Map(Object.values(specs).filter(v => v.kind === 'option').map(v => [v.token, v]));
  const options = Object.create(null);
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const spec = known.get(token);
    if (!spec || index + 1 >= argv.length) refuse('unsupported or incomplete builtin option: ' + token);
    const value = argv[++index];
    if (spec.repeatable) {
      if (!options[token]) options[token] = [];
      if (options[token].length >= spec.maxItems) refuse('too many repeated builtin arguments');
      options[token].push(value);
    } else {
      if (Object.hasOwn(options, token)) refuse('duplicate builtin option: ' + token);
      options[token] = value;
    }
  }
  const expected = Object.values(specs).filter(v => v.kind === 'positional').length;
  if (positionals.length !== expected) refuse('wrong number of builtin positional arguments');
  return { positionals, options };
}

function gitRef(value) {
  if (typeof value !== 'string' || !value || value.length > 256
    || value.startsWith('-') || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    refuse('invalid Git revision or pattern');
  }
  return value;
}

// Git pathspecs may reference files removed from the current worktree. Unlike
// filesystem mutation builtins, do not require that the leaf exists today.
function gitPath(root, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)
    || path.win32.isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    refuse('Git paths must be workspace-relative');
  }
  const full = path.resolve(root, value);
  if (!inside(root, full)) refuse('Git path outside workspace');
  const relative = path.relative(root, full) || '.';
  if (relative.split(path.sep).some(v => v.toLowerCase() === '.git' || v.toLowerCase() === TRASH)) {
    refuse('protected Git path');
  }
  return relative;
}

async function gitAction(root, id, positionals, options) {
  await gitRepoRoot(root);
  const get = (key) => options['--' + key];
  const paths = (get('file') ?? []).map(value => gitPath(root, value));
  const files = paths.length ? ['--', ...paths] : [];
  let args;
  let allowNoMatch = false;
  if (id === 'builtin-git-status') {
    args = ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignore-submodules=all'];
  } else if (id === 'builtin-git-diff') {
    const scope = get('scope') ?? 'unstaged';
    const comparison = get('comparison') ?? 'direct';
    if (scope !== 'commits' && (get('base') || get('target') || get('comparison'))) {
      refuse('commit comparisons require scope=commits');
    }
    if (scope === 'commits' && (!get('base') || !get('target'))) refuse('base and target are required');
    const revs = scope === 'commits'
      ? comparison === 'merge-base'
        ? [gitRef(get('base')) + '...' + gitRef(get('target'))]
        : [gitRef(get('base')), gitRef(get('target'))]
      : [];
    const format = get('format') ?? 'patch';
    const render = format === 'patch' ? [] : ['--' + format];
    args = ['--literal-pathspecs', 'diff',
      ...(scope === 'staged' ? ['--cached'] : []),
      '--no-ext-diff', '--no-textconv', '--ignore-submodules=all',
      ...render, ...revs, ...files];
  } else if (id === 'builtin-git-log') {
    const count = get('count') ?? '20';
    const format = get('format') ?? 'summary';
    const render = {
      summary: ['--format=%h %s'], oneline: ['--oneline'],
      full: ['--format=fuller'], graph: ['--graph', '--oneline'],
    }[format];
    args = ['--literal-pathspecs', 'log', '--no-show-signature',
      ...render, '-n', count,
      ...(get('author') ? ['--author=' + get('author')] : []),
      ...(get('grep') ? ['--grep=' + get('grep')] : []),
      ...(get('range') ? [gitRef(get('range'))] : []), ...files];
  } else if (id === 'builtin-git-show') {
    const format = get('format') ?? 'patch';
    args = ['--literal-pathspecs', 'show', '--format=format:%H%n%s%n%b',
      '--no-ext-diff', '--no-textconv', '--no-show-signature', '--ignore-submodules=all',
      ...(format === 'patch' ? [] : ['--' + format]), gitRef(positionals[0]), ...files];
  } else if (id === 'builtin-git-ls-files') {
    const mode = get('mode') ?? 'tracked';
    const selection = {
      tracked: ['--cached'], untracked: ['--others', '--exclude-standard'],
      modified: ['--modified'], deleted: ['--deleted'],
    }[mode];
    args = ['--literal-pathspecs', 'ls-files', ...selection, '-z', ...files];
  } else if (id === 'builtin-git-branch-info') {
    args = ['branch', '--show-current'];
  } else if (id === 'builtin-git-branch') {
    const scope = get('scope') ?? 'local';
    if (scope === 'current') {
      if (get('contains') || get('merged') || get('pattern')) refuse('current branch cannot be filtered');
      args = ['branch', '--show-current'];
    } else {
      args = ['branch', '--list',
        ...(scope === 'all' ? ['--all'] : scope === 'remote' ? ['--remotes'] : []),
        ...(get('contains') ? ['--contains', gitRef(get('contains'))] : []),
        ...(get('merged') ? ['--merged', gitRef(get('merged'))] : []),
        ...(get('pattern') ? [gitRef(get('pattern'))] : [])];
    }
  } else if (id === 'builtin-git-blame') {
    const start = get('start'), end = get('end');
    if ((start === undefined) !== (end === undefined)) refuse('both start and end are required');
    if (start !== undefined && Number(start) > Number(end)) refuse('blame line range is reversed');
    args = ['--literal-pathspecs', 'blame',
      ...(start ? ['-L', start + ',' + end] : []),
      ...(get('ref') ? [gitRef(get('ref'))] : []), '--', gitPath(root, get('file'))];
  } else if (id === 'builtin-git-grep') {
    const mode = get('mode') ?? 'fixed';
    const output = get('output') ?? 'lines';
    args = ['--literal-pathspecs', 'grep', mode === 'regex' ? '-E' : '-F',
      ...(get('case') === 'ignore' ? ['-i'] : []),
      ...(output === 'files' ? ['-l'] : output === 'count' ? ['-c'] : ['-n']),
      '-e', get('pattern'), ...files];
    allowNoMatch = true;
  } else if (id === 'builtin-git-merge-base') {
    args = ['merge-base', gitRef(get('left')), gitRef(get('right'))];
  } else if (id === 'builtin-git-rev-parse') {
    args = ['rev-parse', '--verify', ...(get('format') === 'short' ? ['--short=12'] : []),
      '--end-of-options', gitRef(get('ref'))];
  } else if (id === 'builtin-git-rev-list') {
    args = ['rev-list', '--max-count=' + (get('count') ?? '100'),
      ...(get('format') === 'count' ? ['--count'] : []), gitRef(get('range'))];
  } else if (id === 'builtin-git-worktree') {
    args = ['worktree', 'list', ...(get('format') === 'porcelain' ? ['--porcelain'] : [])];
  } else if (id === 'builtin-git-reflog') {
    args = ['reflog', 'show', '-n', get('count') ?? '20', gitRef(get('ref') ?? 'HEAD')];
  } else if (id === 'builtin-git-range-diff') {
    args = ['range-diff', gitRef(get('old-range')), gitRef(get('new-range'))];
  } else if (id === 'builtin-git-ls-tree') {
    args = ['--literal-pathspecs', 'ls-tree',
      ...(get('recursive') === 'true' ? ['-r'] : []),
      ...(get('format') === 'names' ? ['--name-only'] : []),
      gitRef(get('ref')), ...files];
  } else refuse('unsupported builtin Git operation');
  return { output: git(root, args, false, allowNoMatch) };
}

async function runBuiltin() {
  const [id, ...args] = process.argv.slice(2);
  if (!isBuiltinId(id)) refuse('unknown builtin operation');
  const root = await realpath(process.cwd());
  const { positionals, options } = parseInput(id, args);
  if (id.startsWith('builtin-git-')) return gitAction(root, id, positionals, options);
  if (id === 'builtin-fs-trash-list') {
    if (positionals.length) refuse('trash listing accepts no positional arguments');
    const offset = Number(options['--offset'] ?? '0');
    const limit = Number(options['--limit'] ?? '100');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) refuse('invalid trash pagination');
    return trashList(root, offset, limit);
  }
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
