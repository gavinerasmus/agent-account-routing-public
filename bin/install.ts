#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const userHome = process.env.HOME!;
const bin = resolve(userHome, '.local/bin');
const backup = resolve(userHome, '.local/share/agent-account-routing/backups', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(bin, { recursive: true });
mkdirSync(backup, { recursive: true, mode: 0o700 });
const targets = ['claude-as', 'codex-as', 'pi-as', 'agent-connectors'];
const before: Record<string, string | null> = {};
for (const name of targets) {
  const path = resolve(bin, name);
  before[name] = existsSync(path) ? (lstatSync(path).isSymbolicLink() ? `symlink:${readlinkSync(path)}` : 'file') : null;
  if (before[name] === 'file') copyFileSync(path, resolve(backup, name));
  if (before[name] !== null) unlinkSync(path);
  if (name === 'agent-connectors') symlinkSync(resolve(root, 'bin/connector-policy.ts'), path);
  else writeFileSync(path, readFileSync(resolve(root, 'bin', name)), { mode: 0o755 });
}
writeFileSync(resolve(backup, 'before.json'), JSON.stringify(before, null, 2));
console.log(`Installed connector policy. Launcher backup: ${backup}`);
console.log('New CLI/Herdr sessions use the policy. Existing sessions are unchanged.');
