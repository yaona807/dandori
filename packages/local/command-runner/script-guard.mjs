// Shared, read-only npm-family script fingerprinting for approved command definitions.
import { createHash } from 'node:crypto';
import { lstat, readFile, access } from 'node:fs/promises';
import path from 'node:path';

const HASH = /^sha256-[0-9a-f]{64}$/u;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,127}$/u;
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

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
  if (JSON.stringify(command.run) !== JSON.stringify([guard.manager, 'run', guard.script, '--'])
    || Object.keys(command.arguments ?? {}).length !== 0) {
    throw new Error(location + ' must bind an exact npm-family argv without forwarded arguments');
  }
}

async function exists(full) {
  try { await access(full); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export async function scriptFingerprint(directory, manager, script) {
  if (!MANAGERS.has(manager) || typeof script !== 'string' || !NAME.test(script)) {
    throw new Error('unsupported package manager or script name');
  }
  const file = path.join(directory, 'package.json');
  const state = await lstat(file);
  if (!state.isFile() || state.isSymbolicLink() || state.size > 1_048_576) {
    throw new Error('package.json must be a regular, bounded, non-symlink file');
  }
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)
    || !pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)
    || typeof pkg.scripts[script] !== 'string') {
    throw new Error('the requested package script is unavailable');
  }
  const scripts = Object.fromEntries(Object.entries(pkg.scripts).sort(([a],[b]) => a.localeCompare(b)));
  if (Object.values(scripts).some(v => typeof v !== 'string')) {
    throw new Error('package scripts contain non-string definitions');
  }
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : null;
  let chosen;
  if (declared !== null) {
    chosen = declared.match(/^(npm|pnpm|yarn|bun)@/u)?.[1];
    if (!chosen) throw new Error('unsupported packageManager declaration');
  } else {
    const locks = {
      npm: ['package-lock.json', 'npm-shrinkwrap.json'],
      pnpm: ['pnpm-lock.yaml'],
      yarn: ['yarn.lock'],
      bun: ['bun.lock', 'bun.lockb'],
    };
    const found = [];
    for (const [name, files] of Object.entries(locks)) {
      if ((await Promise.all(files.map(f => exists(path.join(directory, f))))).some(Boolean)) found.push(name);
    }
    if (found.length !== 1) throw new Error('ambiguous package manager: specify packageManager or one lockfile family');
    chosen = found[0];
  }
  if (chosen !== manager) throw new Error('package manager changed since command approval');
  // All package scripts are intentionally included: nested scripts can be invoked
  // dynamically, and tracking only test/pretest/posttest misses those references.
  const source = JSON.stringify({version: 1, manager, declared, scripts});
  return {
    fingerprint: 'sha256-' + createHash('sha256').update(source).digest('hex'),
    scripts,
    packageManager: declared,
  };
}
