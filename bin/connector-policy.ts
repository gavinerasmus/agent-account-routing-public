#!/usr/bin/env node
// Session-local connector filters and pi model routes; never copy, switch, or write credentials.
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

type Client = 'claude' | 'codex' | 'pi';
// gh names the GitHub account this context uses; ghAccounts gives its gh config dir.
// cloud names the login group whose cloud CLI config dirs (cloudTools) it uses.
// chrome is the Chrome profile directory whose Claude extension is signed in to
// this context's Claude account; Claude in Chrome only reaches that profile.
type Context = { email: string; provider: string; ready: boolean; pi: string; gh: string; cloud: string; chrome: string };
// A cloud CLI's config-dir variable; dir is the default for a group ({group} is
// substituted) and groups names the exceptions. Paths are relative to $HOME.
type CloudTool = { env: string; dir: string; groups?: Record<string, string> };
type Provider = { claudeUrls: string[]; claudeNames: string[]; codexApps: Record<string, string> };
export type Policy = {
  defaults: Record<Client, string>;
  contexts: Record<string, Context>;
  folders: Record<string, string>;
  clientFolders?: Partial<Record<Client, Record<string, string>>>;
  // pi has no identity-bound connectors; each context names the model provider
  // pi runs on. Endpoints and keys live in pi's own models.json/auth.json.
  piProviders: Record<string, { model: string }>;
  // GitHub account -> gh config dir relative to $HOME, exported as GH_CONFIG_DIR
  // so `gh` in the session runs as that context's account.
  ghAccounts: Record<string, string>;
  // The GitHub account for unmapped folders, which take the default AI context
  // but are not that context's repos.
  ghDefault: string;
  // Folder -> GitHub account, for a repo whose GitHub owner differs from its
  // context's (a personal repo worked under a client's AI account).
  ghFolders?: Record<string, string>;
  // The cloud login group for unmapped folders, and folder -> group overrides for
  // an engagement or estate whose cloud logins differ from its AI context's.
  cloudDefault: string;
  cloudFolders?: Record<string, string>;
  cloudTools: Record<string, CloudTool>;
  providers: Record<string, Provider>;
};

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

export function validate(policy: Policy): void {
  for (const name of [...Object.values(policy.defaults), ...Object.values(policy.folders),
    ...Object.values(policy.clientFolders ?? {}).flatMap(folders => Object.values(folders))]) {
    if (!policy.contexts[name]) throw new Error(`Unknown connector context: ${name}`);
  }
  for (const context of Object.values(policy.contexts)) {
    if (!context.email || typeof context.ready !== 'boolean' || !policy.providers[context.provider]) {
      throw new Error('Invalid connector context (email, provider and ready are required)');
    }
    if (!policy.piProviders?.[context.pi]?.model) throw new Error(`Unknown pi provider: ${context.pi}`);
    if (!policy.ghAccounts?.[context.gh]) throw new Error(`Unknown GitHub account: ${context.gh}`);
    if (!/^(Default|Profile \d+)$/.test(context.chrome ?? '')) throw new Error(`Invalid Chrome profile: ${context.chrome}`);
  }
  for (const gh of [policy.ghDefault, ...Object.values(policy.ghFolders ?? {})]) {
    if (!policy.ghAccounts?.[gh]) throw new Error(`Unknown GitHub account: ${gh}`);
  }
  for (const group of [policy.cloudDefault, ...Object.values(policy.cloudFolders ?? {}),
    ...Object.values(policy.contexts).map(c => c.cloud)]) {
    if (!/^[a-z0-9-]+$/.test(group ?? '')) throw new Error(`Invalid cloud login group: ${group}`);
  }
  for (const tool of Object.values(policy.cloudTools ?? {})) {
    if (!/^[A-Z_]+$/.test(tool.env) || !tool.dir.includes('{group}')) throw new Error(`Invalid cloud tool: ${tool.env}`);
  }
  for (const provider of Object.values(policy.providers)) {
    if (!provider.claudeUrls.length || !provider.claudeNames.length || !Object.keys(provider.codexApps).length) {
      throw new Error('Incomplete connector provider definition');
    }
  }
}

export function selectContext(policy: Policy, client: Client, cwd: string, override?: string): string {
  return mappedContext(policy, client, cwd, override) ?? policy.defaults[client];
}

// The context chosen explicitly or by folder; undefined when the default applies.
export function mappedContext(policy: Policy, client: Client, cwd: string, override?: string): string | undefined {
  if (override) {
    if (!policy.contexts[override]) throw new Error(`Unknown AGENT_CONNECTOR_CONTEXT: ${override}`);
    return override;
  }
  return matchFolder({ ...policy.folders, ...policy.clientFolders?.[client] }, cwd);
}

// The deepest folder from cwd up that the map names; an exact name beats a wildcard.
function matchFolder(folders: Record<string, string>, cwd: string): string | undefined {
  for (let dir = resolve(cwd); dirname(dir) !== dir; dir = dirname(dir)) {
    const folder = basename(dir);
    if (folders[folder]) return folders[folder];
    for (const [pattern, value] of Object.entries(folders)) {
      const regex = '^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
      if (new RegExp(regex).test(folder)) return value;
    }
  }
  return undefined;
}

export function effectiveCwd(client: Client, args: string[], cwd: string): string {
  if (client !== 'codex') return cwd;
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '-C' || args[i] === '--cd') {
      if (!args[i + 1]) throw new Error('Missing Codex working directory');
      cwd = resolve(cwd, args[++i]);
    } else if (args[i].startsWith('--cd=')) cwd = resolve(cwd, args[i].slice(5));
    else if (args[i].startsWith('-C') && args[i].length > 2) cwd = resolve(cwd, args[i].slice(2));
  }
  return cwd;
}

export function decision(policy: Policy, contextName: string, email: string | null) {
  const context = policy.contexts[contextName];
  const matches = email?.toLowerCase() === context.email.toLowerCase();
  const allowedProvider = context.ready && matches ? context.provider : null;
  return {
    context: contextName,
    expectedAccount: context.email,
    observedAccount: email,
    allowedProvider,
    blockedProviders: Object.keys(policy.providers).filter(p => p !== allowedProvider),
    reason: !context.ready ? 'Connector authorization pending; no identity-bound connectors'
      : !matches ? 'AI account missing or mismatched; no identity-bound connectors'
      : 'Matching AI account; provider authorization still required',
  };
}

export function claudeArgs(policy: Policy, blocked: string[], args: string[]): string[] {
  // Claude accepts one --settings value. Preserve caller settings and append
  // our deny entries so a caller's unrelated settings are not discarded.
  const rest: string[] = [];
  let settings: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { rest.push(...args.slice(i)); break; }
    if (args[i] === '--settings' || args[i].startsWith('--settings=')) {
      const value = args[i] === '--settings' ? args[++i] : args[i].slice(11);
      if (!value) throw new Error('Missing --settings value');
      settings = value.trimStart().startsWith('{') ? JSON.parse(value) : readJson(value);
    } else rest.push(args[i]);
  }
  const deny = blocked.flatMap(p => [
    ...policy.providers[p].claudeUrls.map(serverUrl => ({ serverUrl })),
    ...policy.providers[p].claudeNames.map(serverName => ({ serverName })),
  ]);
  settings.deniedMcpServers = [...(settings.deniedMcpServers ?? []), ...deny];
  return ['--settings', JSON.stringify(settings), ...rest];
}

export function codexArgs(policy: Policy, blocked: string[], args: string[]): string[] {
  const ids = blocked.flatMap(p => Object.values(policy.providers[p].codexApps));
  // CLI values outrank files. Put our overrides after the caller's overrides,
  // but before any positional prompt or subcommand (including a literal --).
  const rest: string[] = [];
  const overrides: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { rest.push(...args.slice(i)); break; }
    if (args[i] === '-c' || args[i] === '--config') {
      if (!args[i + 1]) throw new Error('Missing Codex --config value');
      overrides.push('-c', args[++i]);
    } else if (args[i].startsWith('--config=')) overrides.push('-c', args[i].slice(9));
    else if (args[i].startsWith('-c') && args[i].length > 2) overrides.push('-c', args[i].slice(2));
    else rest.push(args[i]);
  }
  return [...overrides, ...ids.flatMap(id => ['-c', `apps.${id}.enabled=false`]), ...rest];
}

// pi subcommands manage packages and auth; only agent runs get a model route.
const piSubcommands = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);

export function piArgs(policy: Policy, contextName: string, args: string[]): string[] {
  if (piSubcommands.has(args[0])) return args;
  // A caller's explicit model choice wins; stop at -- so a prompt is not read as a flag.
  const end = args.includes('--') ? args.indexOf('--') : args.length;
  const chosen = args.slice(0, end).some(a => /^(--provider|--model|--models)(=|$)/.test(a));
  if (chosen) return args;
  const provider = policy.contexts[contextName].pi;
  return ['--provider', provider, '--model', policy.piProviders[provider].model, ...args];
}

// A caller's explicit GH_CONFIG_DIR wins, as CLAUDE_CONFIG_DIR and CODEX_HOME do.
export function ghAccount(policy: Policy, mapped: string | undefined, cwd: string): string {
  return matchFolder(policy.ghFolders ?? {}, cwd) ?? (mapped ? policy.contexts[mapped].gh : policy.ghDefault);
}

export function ghEnv(policy: Policy, account: string, env: Record<string, string>, home: string): Record<string, string> {
  if (env.GH_CONFIG_DIR) return env;
  return { ...env, GH_CONFIG_DIR: resolve(home, policy.ghAccounts[account]) };
}

export function cloudGroup(policy: Policy, mapped: string | undefined, cwd: string): string {
  return matchFolder(policy.cloudFolders ?? {}, cwd) ?? (mapped ? policy.contexts[mapped].cloud : policy.cloudDefault);
}

// Points each cloud CLI at the group's config dir. A value set by hand or by a
// repo's env.sh wins. A value this routing set itself, recorded in
// AGENT_CLOUD_ROUTED, is replaced, so a shell that moves to another group's
// folder moves its logins with it.
export function cloudEnv(policy: Policy, group: string, env: Record<string, string>, home: string): Record<string, string> {
  const routed = new Set((env.AGENT_CLOUD_ROUTED ?? '').split('|').filter(Boolean));
  const out = { ...env };
  const record: string[] = [];
  for (const tool of Object.values(policy.cloudTools ?? {})) {
    if (env[tool.env] && !routed.has(`${tool.env}=${env[tool.env]}`)) continue;
    out[tool.env] = resolve(home, tool.groups?.[group] ?? tool.dir.replace('{group}', group));
    record.push(`${tool.env}=${out[tool.env]}`);
  }
  out.AGENT_CLOUD_ROUTED = record.join('|');
  return out;
}

// zsh/bash export lines for the shell hook: only the variables that change.
export function cloudExports(before: Record<string, string>, after: Record<string, string>): string {
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return Object.entries(after).filter(([k, v]) => before[k] !== v)
    .map(([k, v]) => `export ${k}=${quote(v)}\n`).join('');
}

function executable(name: string): string {
  for (const path of (process.env.PATH ?? '').split(delimiter)) {
    try { return realpathSync(resolve(path, name)); } catch { /* next PATH entry */ }
  }
  throw new Error(`${name} not found on PATH`);
}

function account(client: Client, binary: string, home: string): string | null {
  try {
    if (client === 'claude') {
      // A failed read is not a signed-out account. One transient `claude auth
      // status` failure would otherwise strip this session's connectors for the
      // whole life of the process, with nothing said. Retry, then say so.
      for (let attempt = 1; ; attempt++) {
        try {
          const status = JSON.parse(execFileSync(binary, ['auth', 'status'], {
            encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
          }));
          return status.loggedIn && status.authMethod === 'claude.ai' ? status.email : null;
        } catch (error) {
          if (attempt === 3) {
            console.error(`[connectors] identity read failed ${attempt} times: ${(error as Error).message}`);
            throw error;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        }
      }
    }
    // A local routing hint, not verification of the mailbox or a JWT signature.
    // Never print or forward token values. The hosted connector authenticates.
    const auth = readJson(resolve(home, 'auth.json'));
    if (auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY || process.env.OPENAI_API_KEY) return null;
    const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString());
    return typeof claims.email === 'string' ? claims.email : null;
  } catch { return null; }
}

const processEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter((entry): entry is [string, string] => entry[1] !== undefined));

// `agent-connectors env`: the shell hook's half. Prints exports for the
// current directory's cloud login group, using the same folder map as the agents.
function shellEnv(): void {
  const policy: Policy = readJson(process.env.AGENT_CONNECTOR_POLICY ?? resolve(dirname(fileURLToPath(import.meta.url)), '../policy.json'));
  validate(policy);
  const cwd = process.cwd();
  const env = processEnv();
  const group = cloudGroup(policy, mappedContext(policy, 'claude', cwd, env.AGENT_CONNECTOR_CONTEXT), cwd);
  process.stdout.write(cloudExports(env, cloudEnv(policy, group, env, env.HOME!)));
}

// `agent-connectors chrome [url]`: opens a window in the Chrome profile that
// belongs to this folder's Claude account, so Claude in Chrome connects to the
// extension signed in to that account. --why prints the profile only.
function openChrome(args: string[]): void {
  const policy: Policy = readJson(process.env.AGENT_CONNECTOR_POLICY ?? resolve(dirname(fileURLToPath(import.meta.url)), '../policy.json'));
  validate(policy);
  const context = selectContext(policy, 'claude', process.cwd(), process.env.AGENT_CONNECTOR_CONTEXT);
  const profile = policy.contexts[context].chrome;
  if (args.includes('--why')) {
    console.log(JSON.stringify({ context, account: policy.contexts[context].email, chromeProfile: profile }, null, 2));
    return;
  }
  const urls = args.filter(a => !a.startsWith('--'));
  execFileSync('open', ['-na', 'Google Chrome', '--args', `--profile-directory=${profile}`, ...urls]);
  console.error(`[chrome] ${context}: opened ${profile} (${policy.contexts[context].email})`);
}

export function main(argv: string[]): void {
  const [client, ...args] = argv;
  if (client === 'env') return shellEnv();
  if (client === 'chrome') return openChrome(args);
  if (client !== 'claude' && client !== 'codex' && client !== 'pi') throw new Error('Expected claude, codex or pi');
  const userHome = process.env.HOME!;
  const policyPath = process.env.AGENT_CONNECTOR_POLICY ?? resolve(dirname(fileURLToPath(import.meta.url)), '../policy.json');
  const policy: Policy = readJson(policyPath);
  validate(policy);
  const cwd = effectiveCwd(client, args, process.cwd());
  const mapped = mappedContext(policy, client, cwd, process.env.AGENT_CONNECTOR_CONTEXT);
  const context = mapped ?? policy.defaults[client];
  const gh = ghAccount(policy, mapped, cwd);
  const binary = executable(client);
  const cloud = cloudGroup(policy, mapped, cwd);
  const env = cloudEnv(policy, cloud, ghEnv(policy, gh, processEnv(), userHome), userHome);
  const cloudDirs = Object.fromEntries(Object.values(policy.cloudTools).map(t => [t.env, env[t.env]]));
  if (client === 'pi') {
    const provider = policy.contexts[context].pi;
    if (args.includes('--why')) {
      console.log(JSON.stringify({ context, client, cwd, piProvider: provider, model: policy.piProviders[provider].model,
        ghAccount: gh, ghConfigDir: env.GH_CONFIG_DIR, cloudGroup: cloud, cloudDirs }, null, 2));
      return;
    }
    console.error(`[pi-route] ${context}: ${provider}`);
    process.execve(binary, [client, ...piArgs(policy, context, args)], env);
  }
  const configHome = client === 'claude' ? process.env.CLAUDE_CONFIG_DIR ?? resolve(userHome, '.claude')
    : process.env.CODEX_HOME ?? resolve(userHome, '.codex');
  const result = decision(policy, context, account(client, binary, configHome));
  if (args.includes('--why')) {
    console.log(JSON.stringify({ ...result, client, cwd, configHome, ghAccount: gh, ghConfigDir: env.GH_CONFIG_DIR, cloudGroup: cloud, cloudDirs, sharedMcps: 'unchanged' }, null, 2));
    return;
  }
  const filtered = client === 'claude' ? claudeArgs(policy, result.blockedProviders, args)
    : codexArgs(policy, result.blockedProviders, args);
  console.error(`[connectors] ${context}: ${result.allowedProvider ?? 'none'}; ${result.reason}`);
  // argv[0] is the agent's name, not its resolved path: `executable` realpaths
  // through ~/.local/bin/claude to a version-numbered binary, and tooling that
  // identifies running agents by process name (herdr) matches on `claude`.
  process.execve(binary, [client, ...filtered], env);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`Connector policy: ${(error as Error).message}`); process.exitCode = 1; }
}
