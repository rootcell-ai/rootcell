_agent() {
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "provision allow pubkey" -- "${COMP_WORDS[COMP_CWORD]}") )
  fi
}
complete -F _agent agent ./agent
