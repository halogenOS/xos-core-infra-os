{ lib, ... }:
{
  options.custom.isProd = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = ''
      True for real deployments; false for disposable test environments
      like int. Gate prod-only service wiring (external OIDC apps, real
      secrets, strict egress rules, …) on this flag so test environments
      stay lightweight.
    '';
  };
}
