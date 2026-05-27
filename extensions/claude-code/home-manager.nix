{ pkgs, ... }:

{
  home.packages = [
    pkgs.claude-code
  ];

  home.sessionVariables = {
    CLAUDE_CODE_USE_BEDROCK = "1";
    ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "us.anthropic.claude-sonnet-4-6";
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  };
}
