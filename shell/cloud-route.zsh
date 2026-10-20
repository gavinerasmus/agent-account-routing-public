# Per-group cloud CLI logins (az, gcloud, neonctl) in plain shells and Herdr
# panes. On every directory change, points AZURE_CONFIG_DIR, CLOUDSDK_CONFIG
# and NEON_CONFIG_DIR at the current folder's login group (policy.json
# cloudTools), as the agent launchers do. A value set by hand or by a repo's
# env.sh is left alone. Sourced from ~/.zshrc; see README "Cloud CLI logins".
_agent_cloud_route() {
  (( $+commands[agent-connectors] )) || return 0
  eval "$(agent-connectors env 2>/dev/null)"
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _agent_cloud_route
_agent_cloud_route
