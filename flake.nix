{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-26.05";
    foundrix = {
      url = "git+file:///home/simao/workspace/foundrix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.home-manager.follows = "home-manager";
    };
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      foundrix,
      ...
    }@flakeArgs:
    let
      lib = nixpkgs.lib;
      foundrixLib = foundrix.lib;
      forAllSystems = lib.genAttrs lib.systems.flakeExposed;
    in
    foundrix.nixosModules.pluggedInTo flakeArgs rec {
      nixosConfigurations = {
        "nixos-headless@int" = lib.nixosSystem {
          specialArgs = self.nixosModules.foundrixSpecialArgs;
          modules = [
            ./configuration.nix
            ./environments/int.nix
          ];
        };
        "nixos-headless@prod" = lib.nixosSystem {
          specialArgs = self.nixosModules.foundrixSpecialArgs;
          modules = [
            ./configuration.nix
            ./environments/prod.nix
          ];
        };
      }
      // foundrixLib.deviceFramework.mkDeviceSpecificConfigurations {
        xos-core-infra-int = {
          nixosConfiguration = nixosConfigurations."nixos-headless@int";
          deviceConfiguration = ./devices/hetzner;
          platformModule = foundrix.nixosModules.hardware.platform.x86_64;
        };
        xos-core-infra-prod = {
          nixosConfiguration = nixosConfigurations."nixos-headless@prod";
          deviceConfiguration = ./devices/hetzner;
          platformModule = foundrix.nixosModules.hardware.platform.x86_64;
        };
      };
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
