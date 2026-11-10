{ pkgs, ... }:
{
  # CI's toolbelt (.github/workflows/ci.yml); nixpkgs is flake.lock's rev, so bun and gitleaks match CI's pins
  packages = [
    pkgs.bun
    pkgs.git
    pkgs.nodejs_22
    pkgs.gitleaks
    pkgs.jq
    pkgs.shellcheck
    pkgs.zsh
  ];
}
