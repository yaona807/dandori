// Shared, read-only npm-family script fingerprinting for approved command definitions.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const HASH = /^sha256-[0-9a-f]{64}$/u;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,127}$/u;
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

// npm consumes the "--" separator; pnpm/yarn/bun pass it on to scripts.
export function scriptRunArgs(manager, script) {
  if (!MANAGERS.has(manager) || !NAME.test(script)) throw new Error('unsupported script invocation');
  return manager === 'npm' ? [manager, 'run', script, '--'] : [manager, 'run', script];
}

export function validateScriptGuard(guard, command, location = 'scriptGuard') {
  if (!guard || typeof guard !== 'object' || Array.isArray(guard)
    || Object.keys(guard).sort().join(',') !== 'fingerprint,manager,script') {
    throw new Error(location + ' requires manager, script and fingerprint');
  }
  if (!MANAGERS.has(guard.manager) || typeof guard.script !== 'string'
    || !NAME.test(guard.script) || guard.script.startsWith('.') || guard.script.includes('..')
    || !HASH.test(guard.fingerprint)) {
    throw new Error(location + ' contains an invalid manager, script or fingerprint');
  }
  if (JSON.stringify(command.run) !== JSON.stringify(scriptRunArgs(guard.manager, guard.script))
    || Object.keys(command.arguments ?? {}).length !== 0) {
    throw new Error(location + ' must bind an exact npm-family argv without forwarded arguments');
  }
}

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

async function optionalFile(full) {
  let state;
  try { state = await lstat(full); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!state.isFile() || state.isSymbolicLink() || state.size > 1_048_576) {
    throw new Error('invalid package manager metadata path: ' + path.basename(full));
  }
  return await readFile(full, 'utf8');
}

async function resolveManager(directory, workspaceRoot) {
  const base = await realpath(workspaceRoot);
  const target = await realpath(directory);
  if (!inside(base, target)) throw new Error('package directory escapes registered workspace');

  // Monorepo packages inherit packageManager / lockfile metadata only from
  // ancestors *inside the selected workspace*. Never inspect outside roots.
  const lockfiles = {
    npm: ['package-lock.json', 'npm-shrinkwrap.json'],
    pnpm: ['pnpm-lock.yaml'],
    yarn: ['yarn.lock'],
    bun: ['bun.lock', 'bun.lockb'],
  };
  for (let cursor = target;; cursor = path.dirname(cursor)) {
    const manifestSource = await optionalFile(path.join(cursor, 'package.json'));
    if (manifestSource !== null) {
      const manifest = JSON.parse(manifestSource);
      const declared = manifest?.packageManager;
      if (declared !== undefined) {
        const match = typeof declared === 'string' && /^(npm|pnpm|yarn|bun)@/u.exec(declared);
        if (!match) throw new Error('unsupported packageManager declaration');
        return {chosen: match[1], declared, metadataDir: path.relative(base, cursor) || '.'};
      }
    }
    const found = [];
    for (const [manager, files] of Object.entries(lockfiles)) {
      let present = false;
      for (const lock of files) {
        if (await optionalFile(path.join(cursor, lock)) !== null) present = true;
      }
      if (present) found.push(manager);
    }
    if (found.length > 1) throw new Error('ambiguous package manager: competing lockfile families');
    if (found.length === 1) {
      return {chosen: found[0], declared: null, metadataDir: path.relative(base, cursor) || '.'};
    }
    if (cursor === base) break;
  }
  throw new Error('ambiguous package manager: no declaration or lockfile inside workspace');
}

export async function scriptFingerprint(directory, manager, script, workspaceRoot = directory) {
  if (!MANAGERS.has(manager) || typeof script !== 'string' || !NAME.test(script)) {
    throw new Error('unsupported package manager or script name');
  }
  const file = path.join(directory, 'package.json');
  const source = await optionalFile(file);
  if (source === null) throw new Error('package.json is missing');
  const pkg = JSON.parse(source);
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)
    || !pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)
    || typeof pkg.scripts[script] !== 'string') {
    throw new Error('the requested package script is unavailable');
  }
  const scripts = Object.fromEntries(Object.entries(pkg.scripts).sort(([a], [b]) => a.localeCompare(b)));
  if (Object.values(scripts).some(v => typeof v !== 'string')) {
    throw new Error('package scripts contain non-string definitions');
  }
  const {chosen, declared, metadataDir} = await resolveManager(directory, workspaceRoot);
  if (chosen !== manager) throw new Error('package manager changed since command approval');
  // Track all package scripts, including any dynamic nested npm run invocations,
  // but send only a bounded selected-script preview to the worker.
  const snapshot = JSON.stringify({version: 2, manager, declared, metadataDir, scripts});
  return {
    fingerprint: 'sha256-' + createHash('sha256').update(snapshot).digest('hex'),
    scripts,
    packageManager: declared,
  };
}
