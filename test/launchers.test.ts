import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
// The tests run against the shipped example policy, never a local policy.json.
const examplePolicy = resolve(root, 'policy.example.json');

test('launcher: AI routing per folder, provider exclusions, parallel context isolation', async () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'connector-routing-test-'));
  try {
    mkdirSync(resolve(temp, 'bin'));
    const profiles = resolve(temp, 'profiles');
    mkdirSync(profiles);
    writeFileSync(resolve(profiles, 'map.conf'), 'personal-site | personal\nclient-a-app | client-a\nwork-portal | work\n');
    for (const name of ['personal', 'client-a']) {
      mkdirSync(resolve(profiles, name));
      writeFileSync(resolve(profiles, name, '.enabled'), '');
    }
    // A fake claude binary: no credentials or live services are used.
    writeFileSync(resolve(temp, 'bin/claude'), `#!/usr/bin/env node
const name = (process.env.CLAUDE_CONFIG_DIR || '').split('/').at(-1);
const email = name === 'personal' ? 'you@example.com' : name === 'client-a' ? 'you@client-a.example.com' : 'you@work.example.com';
if (process.argv[2] === 'auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email}));
else console.log(JSON.stringify({config:process.env.CLAUDE_CONFIG_DIR || null,args:process.argv.slice(2)}));
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${temp}/bin:${process.env.PATH}`, CLAUDE_PROFILE_ROOT: profiles,
      AGENT_CONNECTOR_LAUNCHER: resolve(root, 'bin/connector-policy.ts'), AGENT_CONNECTOR_POLICY: examplePolicy };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.AGENT_CONNECTOR_CONTEXT;
    delete env.CLAUDE_PROFILE;
    // client-a-app is in the account map but not the policy folder map, so its
    // connector context is the default (work) and the account mismatches.
    for (const [folder, blocked, account] of [
      ['work-portal', 'google', null],
      ['personal-site', 'microsoft', 'personal'],
      ['client-a-app', 'both', 'client-a'],
    ] as const) {
      const cwd = resolve(temp, folder, 'nested');
      mkdirSync(cwd, { recursive: true });
      const after = JSON.parse(execFileSync('bash', [resolve(root, 'bin/claude-as'), '--dangerously-skip-permissions', 'test prompt'], {
        cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }));
      assert.equal(after.config, account ? resolve(profiles, account) : null);
      assert.equal(after.args[0], '--settings');
      assert.deepEqual(after.args.slice(2), ['--dangerously-skip-permissions', 'test prompt']);
      const rules = JSON.parse(after.args[1]).deniedMcpServers;
      assert.equal(rules.some((r: any) => r.serverUrl?.includes('gmail')), blocked !== 'microsoft');
      assert.equal(rules.some((r: any) => r.serverUrl?.includes('microsoft365')), blocked !== 'google');
    }
    const parallel = await Promise.all(['work-portal', 'personal-site'].map(async folder => {
      const { stdout } = await promisify(execFile)('bash', [resolve(root, 'bin/claude-as'), 'parallel prompt'], {
        cwd: resolve(temp, folder), env, encoding: 'utf8',
      });
      return JSON.parse(stdout);
    }));
    assert.equal(parallel[0].config, null);
    assert.equal(parallel[1].config, resolve(profiles, 'personal'));
    assert.ok(parallel[0].args[1].includes('gmailmcp'));
    assert.ok(!parallel[1].args[1].includes('gmailmcp'));
    const explicit = JSON.parse(execFileSync('bash', [resolve(root, 'bin/claude-as'), 'explicit prompt'], {
      cwd: resolve(temp, 'personal-site'), env: { ...env, CLAUDE_CONFIG_DIR: resolve(profiles, 'client-a') },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    assert.equal(explicit.config, resolve(profiles, 'client-a'));
    assert.ok(explicit.args[1].includes('gmailmcp'));
    assert.ok(explicit.args[1].includes('microsoft365'));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('a transient identity read does not strip the session connectors', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'connector-retry-test-'));
  try {
    mkdirSync(resolve(temp, 'bin'));
    // Fails the first `auth status`, as a contended launch does, then succeeds.
    writeFileSync(resolve(temp, 'bin/claude'), `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
const marker = ${JSON.stringify(resolve(temp, 'first-read'))};
if (process.argv[2] === 'auth') {
  if (!existsSync(marker)) { writeFileSync(marker, ''); process.exit(1); }
  console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'you@work.example.com'}));
} else console.log(JSON.stringify({args:process.argv.slice(2)}));
`, { mode: 0o755 });
    const cwd = resolve(temp, 'work-portal');
    mkdirSync(cwd);
    const env = { ...process.env, PATH: `${temp}/bin:${process.env.PATH}`, AGENT_CONNECTOR_POLICY: examplePolicy };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.AGENT_CONNECTOR_CONTEXT;
    const run = JSON.parse(execFileSync(resolve(root, 'bin/connector-policy.ts'), ['claude', 'retry prompt'], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const rules = JSON.parse(run.args[1]).deniedMcpServers;
    assert.ok(rules.some((r: any) => r.serverUrl?.includes('gmail')));
    assert.ok(!rules.some((r: any) => r.serverUrl?.includes('microsoft365')));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLAUDE_PROFILE switches a folder to its second account, connectors included; a signed-out profile is refused', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'connector-profile-test-'));
  try {
    mkdirSync(resolve(temp, 'bin'));
    const profiles = resolve(temp, 'profiles');
    writeFileSync(resolve(temp, 'bin/claude'), `#!/usr/bin/env node
const name = (process.env.CLAUDE_CONFIG_DIR || '').split('/').at(-1);
const email = name === 'client-a-second' ? 'shared@client-a.example.com' : 'you@client-a.example.com';
if (process.argv[2] === 'auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email}));
else console.log(JSON.stringify({config:process.env.CLAUDE_CONFIG_DIR || null,args:process.argv.slice(2)}));
`, { mode: 0o755 });
    for (const name of ['client-a', 'client-a-second', 'signed-out']) mkdirSync(resolve(profiles, name), { recursive: true });
    writeFileSync(resolve(profiles, 'map.conf'), 'client-a | client-a\n');
    for (const name of ['client-a', 'client-a-second']) writeFileSync(resolve(profiles, name, '.enabled'), '');
    const cwd = resolve(temp, 'client-a', 'app');
    mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, PATH: `${temp}/bin:${process.env.PATH}`, CLAUDE_PROFILE_ROOT: profiles,
      AGENT_CONNECTOR_LAUNCHER: resolve(root, 'bin/connector-policy.ts'), AGENT_CONNECTOR_POLICY: examplePolicy };
    for (const key of ['CLAUDE_CONFIG_DIR', 'AGENT_CONNECTOR_CONTEXT', 'CLAUDE_PROFILE']) delete env[key];
    const run = (extra: Record<string, string>) => JSON.parse(execFileSync('bash', [resolve(root, 'bin/claude-as'), 'p'], {
      cwd, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const usual = run({});
    assert.equal(usual.config, resolve(profiles, 'client-a'));
    const second = run({ CLAUDE_PROFILE: 'client-a-second' });
    assert.equal(second.config, resolve(profiles, 'client-a-second'));
    // The second account keeps its own Microsoft connector rather than being blocked as a mismatch.
    assert.ok(!second.args[1].includes('microsoft365'));
    assert.ok(second.args[1].includes('gmailmcp'));
    for (const bad of ['signed-out', '../client-a', 'missing']) {
      assert.throws(() => run({ CLAUDE_PROFILE: bad }));
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
