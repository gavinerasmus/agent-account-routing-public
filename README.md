# agent-account-routing

Per-folder account routing for AI coding agents on a Mac: Claude Code, Codex
and pi. Start an agent in a folder and it
runs under the account that belongs to that folder, with only that account's
mail and calendar connectors enabled, `gh` logged in as the matching GitHub
account, and cloud CLIs pointed at the matching login.

## The problem

If you use AI coding agents for more than one employer, client or personal
project, each usually has its own Claude or ChatGPT account, its own Microsoft
365 or Google Workspace connectors, its own GitHub account and its own cloud
tenants. A single global login means:

- the agent in a client's repo can read your employer's mailbox through a
  connector that happens to be signed in;
- `gh`, `az`, `gcloud` and `neonctl` act on whichever account you logged into
  last, which fails as a confusing 403 at best and changes the wrong estate at
  worst;
- switching accounts by hand is easy to forget and affects every running session.

This repo routes each of those per process, from the folder you launch in. No
credentials are copied, swapped or written. It is a routing guard, not a sandbox.

## How it works

Three small launchers sit in front of the real binaries:

- `claude-as` picks a Claude Code config directory from
  `~/.claude-profiles/map.conf` and exports `CLAUDE_CONFIG_DIR`;
- `codex-as` does the same for Codex with `~/.codex-profiles/map.conf` and
  `CODEX_HOME`;
- `pi-as` hands straight over, because pi has one agent directory.

Each then runs `agent-connectors` (`bin/connector-policy.ts`), which reads
`policy.json` and does the rest:

1. Selects a **context** for the folder (for example `work`, `personal` or
   `client-a`).
2. Reads the signed-in AI account (`claude auth status`, or the email claim in
   Codex's local `auth.json`) and compares it with the context's expected email.
3. Denies every identity-bound connector provider except the context's own, and
   denies all of them if the account is missing or does not match. Claude gets
   `deniedMcpServers` through `--settings`; Codex gets
   `-c apps.<id>.enabled=false`.
4. Exports `GH_CONFIG_DIR` for the context's GitHub account and the cloud CLI
   config variables for its login group.
5. Starts the real agent with those arguments and that environment.

Everything is process-local, so two sessions in different folders run under
different contexts at the same time without touching each other's settings.

## Requirements

- macOS (the launchers are bash 3.2 compatible; `agent-connectors chrome` uses `open`)
- Node.js 24 or later (runs the TypeScript directly)
- Claude Code with `deniedMcpServers` support, and/or Codex with per-app
  `enabled` settings

## Install

```sh
git clone https://github.com/gavinerasmus/agent-account-routing-public.git
cd agent-account-routing-public
cp policy.example.json policy.json        # then edit it, see below
npm test                                  # runs against policy.example.json
node bin/install.ts
```

The installer copies `claude-as`, `codex-as` and `pi-as` into `~/.local/bin`
and symlinks `~/.local/bin/agent-connectors` to `bin/connector-policy.ts` in
this checkout, so keep the checkout where it is. Any launcher it replaces is
backed up to `~/.local/share/agent-account-routing/backups/<timestamp>/`, with
a `before.json` recording what was there. It changes no logins, profiles or
running sessions.

Then alias the agents in your shell profile so every launch goes through the
router:

```sh
alias claude=claude-as
alias codex=codex-as
alias pi=pi-as
```

### Where configuration lives

| File                          | Purpose                  | In git  |
|-------------------------------|--------------------------|---------|
| `policy.example.json`         | Example policy           | yes     |
| `policy.json`                 | Your policy              | ignored |
| `map.conf.example`            | Example account map      | yes     |
| `~/.claude-profiles/map.conf` | Claude folder to profile | no      |
| `~/.codex-profiles/map.conf`  | Codex folder to profile  | no      |

`agent-connectors` reads `policy.json` from the checkout root. Set
`AGENT_CONNECTOR_POLICY` to load a complete policy from somewhere else instead;
it never falls back if that file is missing or invalid. Keep your real
`policy.json` out of any public fork, since it names your accounts.

## Configure the policy

`policy.json` has these parts. `policy.example.json` shows each one with
placeholder accounts.

**`contexts`.** One per account you work under. Each names:

- `email`: the AI account expected in that context;
- `provider`: the connector provider it may use (`google` or `microsoft`);
- `ready`: `false` blocks every connector until you have authorised them;
- `pi`: the pi provider to run on (a key of `piProviders`);
- `gh`: the GitHub account (a key of `ghAccounts`);
- `cloud`: the cloud login group;
- `chrome`: the Chrome profile directory (`Default` or `Profile N`).

**`defaults`.** The context per agent for folders the map does not name.

**`folders`.** Folder basename to context. The deepest matching folder from the
launch directory upwards wins, and an exact name beats a `*` wildcard in the
same directory. Map a group folder such as `client-a` and every repo cloned
under it inherits the context; a nested repo with its own entry wins over its
parent.

**`clientFolders`.** Optional per-agent exceptions, for example
`{"pi": {"consulting": "work"}}` to run pi on the work provider in a folder
whose Claude and Codex use the personal account.

**`providers`.** The connector registry: Claude connector URLs and names, and
Codex app connector IDs, per provider. A new connector must be added here or it
is not filtered. Check the Codex app IDs against your own installed app catalog.

`AGENT_CONNECTOR_CONTEXT=<name>` selects a context for one launch. It changes
which connectors are allowed, never the AI login itself.

## Configure the account maps

`map.conf` chooses which signed-in profile an agent starts with. It is separate
from `policy.json` because it selects the login, not the connectors. Copy
`map.conf.example` to `~/.claude-profiles/map.conf` and/or
`~/.codex-profiles/map.conf`:

```text
# <folder basename> | <profile directory name>
personal-site | personal
client-a      | client-a
```

Folders match as in the policy (deepest wins, no wildcards). A profile is used
only when it holds a `.enabled` marker, so a profile you have not signed in to
falls back to the default login (`~/.claude` or `~/.codex`) instead of starting
unauthenticated. A folder with no line never looks in the profile directory.
An explicit `CLAUDE_CONFIG_DIR` or `CODEX_HOME` always wins.

Set up a Claude profile:

```sh
mkdir -p ~/.claude-profiles/personal
CLAUDE_CONFIG_DIR=~/.claude-profiles/personal claude    # then /login
touch ~/.claude-profiles/personal/.enabled
```

Codex works the same way under `~/.codex-profiles/<name>` with `CODEX_HOME` and
`codex login`. Name each profile after its policy context. If your default login
already belongs to the default context, that context needs no profile.

To share settings, skills or instructions between Claude profiles, symlink
those entries (`CLAUDE.md`, `settings.json`, `skills` and so on) from each
profile to `~/.claude`. The installer does not create these links.

Check a route without launching anything:

```sh
cd ~/src/client-a/app
claude-as --why
codex-as --why
pi-as --why
```

`--why` prints the context, expected and observed account, allowed and blocked
providers, config directory, GitHub account and cloud directories.

## A second account for one organisation

A folder maps to one profile, but an organisation can give you two Claude
accounts, say `client-a` and `client-a-second`. Add both as contexts in
`policy.json` and sign in both profiles. `CLAUDE_PROFILE` then picks the second
for one launch:

```sh
cd ~/src/client-a/app
claude                                  # client-a, from map.conf
CLAUDE_PROFILE=client-a-second claude   # the second account
```

`claude-as` also sets `AGENT_CONNECTOR_CONTEXT` to the profile name, so the
connector check expects the second account and allows its connectors instead of
treating it as a mismatch. A signed-out, unknown or path-like profile name is
refused rather than falling back.

To move one repo to the second account permanently, map its folder to that
profile in both `map.conf` and the `folders` block of `policy.json`. Mapping
only `map.conf` signs in as the second account while the connector check still
expects the first, so its connectors are refused.

## GitHub CLI per context

Each context's `gh` names a key of `ghAccounts`, which maps it to a `gh` config
directory relative to `$HOME`. The launchers export it as `GH_CONFIG_DIR`, so
`gh` inside the session runs as that account. An explicit `GH_CONFIG_DIR` wins.

Unmapped folders take the default AI context but use `ghDefault` for GitHub.
`ghFolders` overrides the account for one folder, for a repo whose GitHub owner
differs from its context (a personal repo worked under a work AI account).

Log each account in once, from a real terminal:

```sh
GH_CONFIG_DIR=~/.config/gh-work gh auth login -h github.com -p https -w
```

This reaches only `gh` started by an agent. For plain `git`, use
`includeIf "gitdir:~/src/client-a/"` blocks in `~/.gitconfig` to set the commit
identity per group folder.

## Cloud CLI logins per group

`az`, `gcloud` and `neonctl` keep their logins in a directory chosen by an
environment variable. Each context names a login group in `cloud`, and
`cloudTools` maps each tool to its variable and directory:

```json
"azure": { "env": "AZURE_CONFIG_DIR", "dir": ".azure-{group}", "groups": { "work": ".azure" } }
```

A group not listed in `groups` uses `dir` with `{group}` substituted, so a new
group gets its own empty directory and the tool asks for a login instead of
acting on another tenant. Adding a tool is one entry.

`cloudFolders` overrides the group for a folder, for an engagement whose cloud
tenant differs from its AI account. Unmapped folders use `cloudDefault`. Set it
to a group you never sign in to (the example uses `unrouted`), so a cloud CLI
run from `~` refuses rather than acting on a real account.

The routing reaches two places:

- **Agents.** The launchers export the variables, and `--why` prints them.
- **Plain shells.** Source `shell/cloud-route.zsh` from `~/.zshrc`. It runs
  `agent-connectors env` on every directory change.

A value you set by hand, or one a repo's `env.sh` sets, is left alone. The
router records the values it set in `AGENT_CLOUD_ROUTED` and replaces only
those, so a shell that moves to another group's folder moves its logins too.

Sign each group in once, from one of its folders:

```sh
cd ~/src/client-b/portal
az login --tenant <tenant-id>
gcloud auth login && gcloud auth application-default login
neonctl auth
```

## Chrome profile per Claude account

Claude in Chrome reaches only an extension signed in to the same claude.ai
account as the session. With one Chrome profile per Claude account, set each
context's `chrome` to that profile's directory name (`Default`, `Profile 1`,
and so on; see `chrome://version`). Then:

```sh
agent-connectors chrome https://example.com   # opens the folder's profile
agent-connectors chrome --why                 # prints the choice only
```

Install the Claude extension in each profile and sign it in to the matching
account once, by hand.

## pi model routing

pi has no identity-bound connectors, so it has no profile map or account check.
`pi-as` selects the context with the same folder map, then starts pi with
`--provider <contexts.<name>.pi> --model <piProviders.<provider>.model>`. A
caller's own `--provider`, `--model` or `--models` is left alone, and pi's
subcommands (`update`, `auth`, `install` and the rest) pass through unrouted.
Define custom endpoints in `~/.pi/agent/models.json` and keep keys in pi's
`auth.json` or the macOS keychain, never in `policy.json`.

## Security notes

- **A guard, not a sandbox.** It filters the listed first-party Microsoft and
  Google hosted connectors in CLI sessions started through these launchers. It
  does not cover desktop apps, direct binary launches, remote app servers,
  custom mail MCP servers, or mail reached through a browser or another CLI.
- **Fail closed.** A missing or mismatched AI account blocks every provider. An
  invalid policy, unknown context or unknown account stops the launcher.
- **Identity is a local hint.** For Codex, the email is read from the ID token
  payload in `auth.json` without verifying its signature or freshness. The
  hosted service still authenticates the mailbox and enforces your
  organisation's rules. An allowed connector is not automatically authorised.
- **No credentials handled.** Nothing copies, prints or forwards tokens. Each
  account authorises its own connectors.
- **Shared MCP servers are untouched.** Servers such as databases or cloud
  tools keep their own per-profile configuration and authentication.
- **Start a new session after changing accounts.** The identity check runs once,
  at launch.
- **Keep your policy private.** `policy.json` and `map.conf` name your accounts
  and clients; both are gitignored here.

## Test and verify

```sh
npm test                          # unit and launcher tests, no live services
node test/read-codex-config.ts    # live, read-only: Codex's effective config
```

The launcher tests run the real launchers against fake `claude` binaries and
the example policy. `read-codex-config.ts` starts a Codex app server through the
router with your `policy.json`, reads the effective configuration and checks the
blocked apps are disabled. It assumes the Codex login matches the context.

## Rollback

Restore `claude-as`, `codex-as` and `pi-as` from the backup directory the
installer printed into `~/.local/bin`, keeping their execute bits. Remove the
`agent-connectors` symlink if `before.json` records it as absent, or point it
back at the target it records. No login or config store needs restoring.

## References

- [Claude Code: disabling claude.ai connectors](https://code.claude.com/docs/en/mcp#disable-claudeai-connectors)
- [Claude Code: managed MCP and denylist semantics](https://code.claude.com/docs/en/managed-mcp)

## Licence

MIT. See [LICENSE](LICENSE).
