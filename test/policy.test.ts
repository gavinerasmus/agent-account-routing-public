import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectContext, decision, validate, claudeArgs, codexArgs, effectiveCwd, piArgs, ghEnv, ghAccount, mappedContext, cloudGroup, cloudEnv, cloudExports } from '../bin/connector-policy.ts';
import type { Policy } from '../bin/connector-policy.ts';

const policy: Policy = JSON.parse(readFileSync(new URL('../policy.example.json', import.meta.url), 'utf8'));

test('repo/group mapping: nested repo wins, wildcard groups, defaults, explicit context', () => {
  validate(policy);
  assert.equal(selectContext(policy, 'codex', '/src/work-finance/server'), 'work');
  assert.equal(selectContext(policy, 'claude', '/src/client-a/personal-site/src'), 'personal');
  assert.equal(selectContext(policy, 'claude', '/src/unmapped'), 'work');
  assert.equal(selectContext(policy, 'codex', '/src/unmapped'), 'work');
  assert.equal(selectContext(policy, 'claude', '/src/personal-site', 'client-a'), 'client-a');
  for (const repo of ['app', 'api', 'infra']) {
    assert.equal(selectContext(policy, 'codex', `/src/client-a/${repo}/src`), 'client-a');
  }
  assert.throws(() => selectContext(policy, 'claude', '/', 'typo'), /Unknown/);
});

test('only a matching, ready context exposes its provider; fallback never exposes another mailbox', () => {
  assert.equal(decision(policy, 'work', 'you@work.example.com').allowedProvider, 'microsoft');
  assert.equal(decision(policy, 'personal', 'you@example.com').allowedProvider, 'google');
  for (const email of [null, 'you@example.com', 'you@client-a.example.com']) {
    assert.deepEqual(decision(policy, 'work', email).blockedProviders, ['google', 'microsoft']);
  }
  assert.equal(decision(policy, 'client-a', 'you@client-a.example.com').allowedProvider, 'microsoft');
  assert.equal(decision(policy, 'client-a', 'you@work.example.com').allowedProvider, null);
  const pending = structuredClone(policy);
  pending.contexts['client-a'].ready = false;
  assert.equal(decision(pending, 'client-a', 'you@client-a.example.com').allowedProvider, null);
});

test('Claude denies provider URLs, retains caller deny rules, preserves shared MCP configuration and literal prompt', () => {
  const initial = { model: 'opus', deniedMcpServers: [{ serverName: 'existing-deny' }] };
  const args = claudeArgs(policy, ['google'], ['--settings', JSON.stringify(initial), '--mcp-config', 'shared.json', '--', 'literal --settings']);
  const settings = JSON.parse(args[1]);
  assert.equal(settings.model, 'opus');
  assert.ok(settings.deniedMcpServers.some((d: any) => d.serverName === 'existing-deny'));
  assert.ok(settings.deniedMcpServers.some((d: any) => d.serverUrl === 'https://gmailmcp.googleapis.com/*'));
  assert.ok(!JSON.stringify(settings).includes('shared-mcp'));
  assert.ok(!JSON.stringify(settings).includes('microsoft365'));
  assert.deepEqual(args.slice(2), ['--mcp-config', 'shared.json', '--', 'literal --settings']);
});

test('Codex disables only blocked provider IDs, after caller overrides; shared tools and Google remain untouched', () => {
  const id = policy.providers.microsoft.codexApps['microsoft-outlook-email'];
  const args = codexArgs(policy, ['microsoft'], ['exec', '-c', `apps.${id}.enabled=true`, '-c', 'model="example"', '--', 'prompt']);
  const falseAt = args.indexOf(`apps.${id}.enabled=false`);
  assert.ok(falseAt > args.indexOf(`apps.${id}.enabled=true`));
  assert.ok(falseAt < args.indexOf('exec'));
  assert.ok(args.includes('model="example"'));
  assert.deepEqual(args.slice(-3), ['exec', '--', 'prompt']);
  assert.ok(!args.join(' ').includes(policy.providers.google.codexApps.gmail));
  assert.ok(!args.join(' ').includes('shared-mcp'));
});

test('Codex --cd selects destination connector context, never a path in a literal prompt', () => {
  assert.equal(effectiveCwd('codex', ['-C', '/src/work-finance'], '/tmp'), '/src/work-finance');
  assert.equal(effectiveCwd('codex', ['--cd=/src/personal-site'], '/tmp'), '/src/personal-site');
  assert.equal(effectiveCwd('codex', ['--', '-C', '/src/work-finance'], '/tmp'), '/tmp');
});

test('invalid context configuration fails rather than silently permitting connectors', () => {
  const bad = structuredClone(policy);
  bad.contexts['client-a'].provider = 'typo';
  assert.throws(() => validate(bad), /Invalid/);
});

test('group folders route every repo beneath them', () => {
  assert.equal(selectContext(policy, 'claude', '/src/work/billing/src'), 'work');
  assert.equal(selectContext(policy, 'codex', '/src/work/reports'), 'work');
  assert.equal(selectContext(policy, 'claude', '/src/personal/blog/src'), 'personal');
  assert.equal(selectContext(policy, 'codex', '/src/client-b/portal'), 'personal');
});

test('a folder mapped to the work context routes every client there', () => {
  for (const client of ['claude', 'codex', 'pi'] as const) {
    assert.equal(selectContext(policy, client, '/src/side-project/src'), 'work');
  }
});

test('consulting uses the personal context for Claude and Codex; a nested work repo wins', () => {
  for (const client of ['claude', 'codex'] as const) {
    assert.equal(selectContext(policy, client, '/src/consulting/src'), 'personal');
  }
  assert.equal(selectContext(policy, 'codex', '/src/consulting/work-tools/src'), 'work');
});

test('clientFolders exceptions apply to one client only and are validated', () => {
  const scoped = structuredClone(policy);
  scoped.clientFolders = { codex: { 'personal-only': 'personal' } };
  assert.equal(selectContext(scoped, 'codex', '/src/personal-only/src'), 'personal');
  assert.equal(selectContext(scoped, 'claude', '/src/personal-only/src'), 'work');
  const bad = structuredClone(policy);
  bad.clientFolders = { codex: { consulting: 'typo' } };
  assert.throws(() => validate(bad), /Unknown/);
});

test('pi runs on work-llm for the work context and consulting, and cerebras for every other context', () => {
  const route = (cwd: string) => piArgs(policy, selectContext(policy, 'pi', cwd), ['hello']);
  assert.deepEqual(route('/src/work/billing'), ['--provider', 'work-llm', '--model', 'example-coder-model', 'hello']);
  assert.deepEqual(route('/src/unmapped'), ['--provider', 'work-llm', '--model', 'example-coder-model', 'hello']);
  assert.deepEqual(route('/src/consulting/outputs'), ['--provider', 'work-llm', '--model', 'example-coder-model', 'hello']);
  assert.equal(selectContext(policy, 'claude', '/src/consulting'), 'personal');
  assert.equal(selectContext(policy, 'codex', '/src/consulting'), 'personal');
  for (const repo of ['personal-site', 'client-a/app', 'client-b/portal', 'personal/blog']) {
    assert.deepEqual(route(`/src/${repo}`).slice(0, 2), ['--provider', 'cerebras']);
  }
});

test('pi keeps a caller model choice and never routes subcommands or a literal prompt', () => {
  assert.deepEqual(piArgs(policy, 'work', ['--model', 'x', 'hi']), ['--model', 'x', 'hi']);
  assert.deepEqual(piArgs(policy, 'work', ['--provider=cerebras']), ['--provider=cerebras']);
  assert.deepEqual(piArgs(policy, 'work', ['update', '--models']), ['update', '--models']);
  assert.deepEqual(piArgs(policy, 'personal', ['--', '--model is a word']).slice(0, 2), ['--provider', 'cerebras']);
  const bad = structuredClone(policy);
  bad.contexts['client-a'].pi = 'typo';
  assert.throws(() => validate(bad), /Unknown pi provider/);
});

test('GitHub account per context: work you-work, client-a you-client-a, side-project, unmapped and the rest you-personal', () => {
  const gh = (cwd: string) => ghAccount(policy, mappedContext(policy, 'claude', cwd), cwd);
  const dir = (cwd: string) => ghEnv(policy, gh(cwd), { PATH: '/bin' }, '/home/u').GH_CONFIG_DIR;
  assert.equal(dir('/home/u/src/work/billing'), '/home/u/.config/gh-work');
  assert.equal(dir('/src/work-finance'), '/home/u/.config/gh-work');
  assert.equal(dir('/home/u/src/client-a/app'), '/home/u/.config/gh-client-a');
  for (const cwd of ['/home/u/src/personal-site', '/home/u/src/client-b/portal', '/home/u', '/src/unmapped']) {
    assert.equal(dir(cwd), '/home/u/.config/gh');
  }
  // side-project runs under the work AI context but is a personal GitHub repo.
  assert.equal(selectContext(policy, 'claude', '/home/u/src/side-project/src'), 'work');
  assert.equal(gh('/home/u/src/side-project/src'), 'you-personal');
  const badFolder = structuredClone(policy);
  badFolder.ghFolders = { 'side-project': 'typo' };
  assert.throws(() => validate(badFolder), /Unknown GitHub account/);
  // Unmapped folders still take the default AI context, but not its GitHub account.
  assert.equal(selectContext(policy, 'claude', '/src/unmapped'), 'work');
  assert.equal(mappedContext(policy, 'claude', '/src/unmapped'), undefined);
  assert.equal(ghEnv(policy, 'you-client-a', { GH_CONFIG_DIR: '/x' }, '/home/u').GH_CONFIG_DIR, '/x');
  const bad = structuredClone(policy);
  bad.contexts['client-a'].gh = 'typo';
  assert.throws(() => validate(bad), /Unknown GitHub account/);
  const badDefault = structuredClone(policy);
  badDefault.ghDefault = 'typo';
  assert.throws(() => validate(badDefault), /Unknown GitHub account/);
});

test('cloud logins per group: client-b has its own, unmapped folders get none', () => {
  const dirs = (cwd: string, env: Record<string, string> = {}) =>
    cloudEnv(policy, cloudGroup(policy, mappedContext(policy, 'claude', cwd), cwd), env, '/home/u');
  const work = dirs('/home/u/src/work/billing');
  assert.equal(work.AZURE_CONFIG_DIR, '/home/u/.azure');
  assert.equal(work.CLOUDSDK_CONFIG, '/home/u/.config/gcloud-work');
  // client-b runs under the personal AI account but its own cloud tenant.
  const clientB = dirs('/home/u/src/client-b/portal/server');
  assert.equal(selectContext(policy, 'claude', '/home/u/src/client-b/portal'), 'personal');
  assert.equal(clientB.AZURE_CONFIG_DIR, '/home/u/.azure-client-b');
  assert.equal(clientB.NEON_CONFIG_DIR, '/home/u/.config/neonctl-client-b');
  for (const repo of ['consulting', 'personal-site', 'personal/blog']) {
    assert.equal(dirs(`/home/u/src/${repo}`).CLOUDSDK_CONFIG, '/home/u/.config/gcloud');
    assert.equal(dirs(`/home/u/src/${repo}`).NEON_CONFIG_DIR, '/home/u/.config/neonctl');
  }
  assert.equal(dirs('/home/u/src/client-a/app').AZURE_CONFIG_DIR, '/home/u/.azure-client-a');
  assert.equal(dirs('/home/u/src/client-a/app').CLOUDSDK_CONFIG, '/home/u/.config/gcloud-client-a');
  // Unmapped folders take the default AI context but no cloud login at all.
  for (const cwd of ['/home/u', '/src/unmapped']) {
    assert.equal(dirs(cwd).AZURE_CONFIG_DIR, '/home/u/.azure-unrouted');
    assert.equal(dirs(cwd).CLOUDSDK_CONFIG, '/home/u/.config/gcloud-unrouted');
  }
});

test('cloud logins: a hand-set or env.sh value wins; a routed one follows the shell to the next group', () => {
  const at = (cwd: string, env: Record<string, string>) =>
    cloudEnv(policy, cloudGroup(policy, mappedContext(policy, 'claude', cwd), cwd), env, '/home/u');
  const explicit = at('/home/u/src/consulting', { CLOUDSDK_CONFIG: '/home/u/.config/gcloud-client-b' });
  assert.equal(explicit.CLOUDSDK_CONFIG, '/home/u/.config/gcloud-client-b');
  assert.equal(explicit.AZURE_CONFIG_DIR, '/home/u/.azure-personal');
  assert.doesNotMatch(explicit.AGENT_CLOUD_ROUTED, /CLOUDSDK_CONFIG/);
  const inClientB = at('/home/u/src/client-b/portal', {});
  const back = at('/home/u', inClientB);
  assert.equal(back.AZURE_CONFIG_DIR, '/home/u/.azure-unrouted');
  // Only the variables that changed are exported, quoted for the shell.
  const out = cloudExports(inClientB, back);
  assert.match(out, /^export AZURE_CONFIG_DIR='\/home\/u\/\.azure-unrouted'$/m);
  assert.equal(cloudExports(back, at('/home/u', back)), '');
  assert.equal(cloudExports({}, { X: "it's" }), "export X='it'\\''s'\n");
});

test('invalid cloud groups and tools fail validation', () => {
  const bad = structuredClone(policy);
  bad.cloudFolders = { 'client-b': 'Has Space' };
  assert.throws(() => validate(bad), /Invalid cloud login group/);
  const noCloud = structuredClone(policy);
  delete (noCloud.contexts['client-a'] as any).cloud;
  assert.throws(() => validate(noCloud), /Invalid cloud login group/);
  const badTool = structuredClone(policy);
  badTool.cloudTools.azure.dir = '.azure';
  assert.throws(() => validate(badTool), /Invalid cloud tool/);
});

test('each Claude account opens its own Chrome profile', () => {
  validate(policy);
  const chrome = (cwd: string) => policy.contexts[selectContext(policy, 'claude', cwd)].chrome;
  assert.equal(chrome('/home/u/src/work/billing'), 'Profile 1');
  assert.equal(chrome('/home/u/src/client-b/portal'), 'Default');
  assert.equal(chrome('/home/u/src/client-a/app'), 'Profile 2');
  assert.equal(chrome('/home/u'), 'Profile 1');
  const bad = structuredClone(policy);
  bad.contexts['client-a'].chrome = '../../etc';
  assert.throws(() => validate(bad), /Invalid Chrome profile/);
});
