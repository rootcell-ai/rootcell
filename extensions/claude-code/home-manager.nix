{ pkgs, ... }:

{
  home.packages = [
    pkgs.claude-code
  ];

  home.file.".claude/skills/add-flake-dep" = {
    source = ../../pi/agent/skills/add-flake-dep;
    recursive = true;
  };
  home.file.".claude/skills/network-allowlist" = {
    source = ../../pi/agent/skills/network-allowlist;
    recursive = true;
  };

  home.sessionVariables = {
    CLAUDE_CODE_USE_BEDROCK = "1";
    ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "us.anthropic.claude-sonnet-4-6";
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  };
}
