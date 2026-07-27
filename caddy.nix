{
  config,
  lib,
  ...
}:
{
  options.custom = {
    ssoDomain = lib.mkOption {
      type = lib.types.str;
      description = "SSO domain (e.g., sso.halogenos.org)";
    };
    zerosslEabFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to ZeroSSL EAB credentials file with:
        EAB_KID=your-key-id
        EAB_HMAC_KEY=your-hmac-key
      '';
    };
    orgDomain = lib.mkOption {
      type = lib.types.str;
      description = "Organization domain (e.g., halogenos.org)";
    };
    mailDomain = lib.mkOption {
      type = lib.types.str;
      description = "Mail server domain (e.g., mail.halogenos.org)";
    };
    webmailDomain = lib.mkOption {
      type = lib.types.str;
      description = "Webmail domain (e.g., webmail.halogenos.org)";
    };
  };

  config = {
    services.caddy = {
      enable = true;

      # Coupled to `admin off` below: reloading is done through the admin API,
      # so with it disabled `caddy reload` cannot connect and the unit fails to
      # reload — leaving the OLD config serving while the switch reports
      # success. Restarting is the only way a config change can take effect
      # here. Upstream defaults this to true and documents the dependency.
      enableReload = false;

      globalConfig = lib.mkForce ''
        admin off
        acme_ca https://acme.zerossl.com/v2/DV90
        acme_eab {
          key_id {$EAB_KID}
          mac_key {$EAB_HMAC_KEY}
        }
        log {
          level INFO
        }
      '';

      virtualHosts.":443" = {
        extraConfig = ''
          respond 421
        '';
      };
    };

    systemd.services.caddy.serviceConfig.EnvironmentFile = lib.mkIf (
      config.custom.zerosslEabFile != null
    ) [
      config.custom.zerosslEabFile
    ];

    networking.firewall.allowedTCPPorts = [
      80
      443
    ];
  };
}
