{ pkgs, ... }:

let
  pi-coding-agent = import ../../pi/pi-coding-agent.nix { inherit pkgs; };
in
{
  # Pi extensions live under ~/.pi/agent/extensions/<name>/. `recursive = true`
  # keeps the parent directories writable while Home Manager manages each leaf.
  home.file.".pi/agent/extensions/subagent" = {
    source = "${pi-coding-agent}/share/pi-coding-agent/examples/extensions/subagent";
    recursive = true;
  };

  # The subagent extension loads agent definitions from ~/.pi/agent/agents/.
  home.file.".pi/agent/agents/planner.md".source =
    "${pi-coding-agent}/share/pi-coding-agent/examples/extensions/subagent/agents/planner.md";
  home.file.".pi/agent/agents/reviewer.md".source =
    "${pi-coding-agent}/share/pi-coding-agent/examples/extensions/subagent/agents/reviewer.md";
  home.file.".pi/agent/agents/scout.md".source =
    "${pi-coding-agent}/share/pi-coding-agent/examples/extensions/subagent/agents/scout.md";
  home.file.".pi/agent/agents/worker.md".source =
    "${pi-coding-agent}/share/pi-coding-agent/examples/extensions/subagent/agents/worker.md";
}
