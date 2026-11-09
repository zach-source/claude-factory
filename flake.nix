{
  description = "claude-factory: a factory of Claude Code workers";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      # node_modules holds per-platform native packages (sharp, onnxruntime), so each system has its own hash.
      # After a bun.lock change, set the hash to "", run `nix build .#factory.nodeModules`
      # and copy the "got:" value from the error.
      nodeModulesHash = {
        aarch64-darwin = "sha256-e3y83QdluHFWSiwtJ8L0S9uInWqRd4C5gN+iloTUvgY=";
        x86_64-linux = "sha256-W82DmI4CJiu/xhg9ou3gptHX4p+wDSCfw7AlNhiqokg=";
        aarch64-linux = "sha256-lH4WmL/F5k5eopf9dypd3zBS67NKQN3kVtUyZZsKf6Y=";
      };
      # the files that bin/factory reads at run time
      runtime = [
        "bin"
        "src"
        "factories"
        "mod"
        "plugins"
        "herdr"
        ".claude-plugin"
        "package.json"
        "bun.lock"
        "bunfig.toml"
        "tsconfig.json"
        "parity-gaps.json"
      ];
    in
    {
      packages = forAll (
        pkgs:
        let
          inherit (pkgs) lib;
          version = (lib.importJSON ./package.json).version;
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions (map (p: ./. + "/${p}") runtime);
          };
          nodeModules = pkgs.stdenvNoCC.mkDerivation {
            pname = "claude-factory-node-modules";
            inherit version;
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./bun.lock
              ];
            };
            nativeBuildInputs = [ pkgs.bun ];
            dontConfigure = true;
            dontFixup = true; # no patched shebangs: a fixed-output path must not refer to other store paths
            buildPhase = ''
              export HOME=$TMPDIR
              bun install --frozen-lockfile --production --ignore-scripts --no-progress
            '';
            installPhase = "mv node_modules $out";
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = nodeModulesHash.${pkgs.stdenv.hostPlatform.system};
          };
        in
        rec {
          factory = pkgs.stdenvNoCC.mkDerivation {
            pname = "claude-factory";
            inherit version src;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/share/claude-factory $out/bin
              cp -r . $out/share/claude-factory
              ln -s ${nodeModules} $out/share/claude-factory/node_modules
              makeWrapper $out/share/claude-factory/bin/factory $out/bin/factory \
                --prefix PATH : ${lib.makeBinPath [ pkgs.bun ]}
            '';
            passthru = { inherit nodeModules; };
            meta = {
              description = "A factory of Claude Code workers";
              homepage = "https://github.com/zach-source/claude-factory";
              mainProgram = "factory";
              platforms = systems;
            };
          };
          default = factory;
        }
      );

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.factory}/bin/factory";
        };
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun ]; };
      });
    };
}
