{
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" ];
      pkgs = import nixpkgs {
        system = "x86_64-linux";
      };
      octopusenergy-consumption-metrics = (pkgs: let
        nodeEnv = import ./node2nix.nix { inherit pkgs; };
        npm = "${pkgs.nodePackages.npm}/bin/npm";
        runtime = pkgs.stdenv.mkDerivation {
          name = "octopusenergy-consumption-metrics";
          src = ./.;
          buildInputs = with pkgs; [
            nodejs
          ];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
              mkdir -p $out
              cp -R ./ $out/
              ln -s ${nodeEnv.shell.nodeDependencies}/lib/node_modules/ $out/node_modules
            '';
        };
      in pkgs.writeScriptBin "octopusenergy-consumption-metrics" ''
        #!${pkgs.stdenv.shell}
        ${pkgs.nodejs}/bin/node ${runtime}/index.js
      '');
    in {
      devShell = pkgs.lib.genAttrs systems (system: let
        pkgs = import nixpkgs {
          inherit system;
        };
      in pkgs.mkShell {
        buildInputs = with pkgs; [
          nodejs
          nodePackages.node2nix
        ];
        shellHook = let
          nodeEnv = import ./node2nix.nix { inherit pkgs; };
        in ''
          ln -s ${nodeEnv.shell.nodeDependencies}/lib/node_modules node_modules
        '';
      });
      overlay = (final: prev: {
        octopusenergy-consumption-metrics = (octopusenergy-consumption-metrics final);
      });
      packages = pkgs.lib.genAttrs systems (system: let
        pkgs = import nixpkgs {
          inherit system;
        };
      in {
        octopusenergy-consumption-metrics = (octopusenergy-consumption-metrics pkgs);
      });
    };
}
