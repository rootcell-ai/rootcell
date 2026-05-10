_agent() {
  local -a subcmds=(
    'provision:re-copy files and re-rebuild both VMs'
    'allow:hot-reload allowlists into the firewall VM'
    'pubkey:print the agent VM SSH public key'
  )
  _arguments '1: :{_describe subcommand subcmds}'
}
compdef _agent agent ./agent
