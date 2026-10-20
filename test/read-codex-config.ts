// Read-only live check: starts an app-server, reads config, stops it. No agent turn.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const policy = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8'));
const child = spawn(process.execPath, ['bin/connector-policy.ts', 'codex', '--strict-config', 'app-server', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
const timeout = setTimeout(() => { child.kill(); console.error('Codex config check timed out'); process.exitCode = 1; }, 30000);
child.stderr.on('data', () => {}); // No credentials or unrelated config in test output.
const lines = createInterface({ input: child.stdout });
const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'connector_policy_check', version: '1.0' }, capabilities: { experimentalApi: true } } });
let checked = false;
try {
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.error) { console.error(JSON.stringify(message.error)); process.exitCode = 1; break; }
  if (message.id === 1) {
    send({ method: 'initialized', params: {} });
    send({ id: 2, method: 'config/read', params: { includeLayers: false } });
  }
  if (message.id === 2) {
    const apps = message.result.config.apps;
    // Assumes the Codex login matches the context's account, so only the
    // context's own provider stays enabled.
    const context = process.env.AGENT_CONNECTOR_CONTEXT ?? policy.defaults.codex;
    const blocked = Object.keys(policy.providers).filter(p => p !== policy.contexts[context].provider);
    for (const provider of blocked) {
      for (const [name, id] of Object.entries(policy.providers[provider].codexApps)) {
        assert.equal(apps[id as string].enabled, false);
        console.log(`${name}: disabled in effective Codex config`);
      }
    }
    for (const [name, server] of Object.entries(message.result.config.mcp_servers ?? {})) {
      console.log(`${name}: ${(server as any).enabled === false ? 'disabled' : 'enabled'} (shared MCP, not touched by the guard)`);
    }
    checked = true;
    break;
  }
}
assert.ok(checked, 'Codex did not return an effective configuration');
} finally {
  clearTimeout(timeout);
  child.kill();
}
