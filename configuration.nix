{
  foundrixModules,
  modulesPath,
  lib,
  pkgs,
  config,
  ...
}:
let
  userName = "user";
in
{
  imports = [
    "${modulesPath}/profiles/minimal.nix"
    "${modulesPath}/profiles/perlless.nix"
    foundrixModules.profiles.server-baseline
    foundrixModules.config.home-manager
    foundrixModules.config.shell.zsh.lite
    foundrixModules.config.virtualisation.docker
    foundrixModules.config.filesystem.var
    foundrixModules.config.runtime.repart.var
    foundrixModules.services.secrets
    foundrixModules.services.nftables-dns
    foundrixModules.config.networking.controlled-egress-firewall
    foundrixModules.services.zitadel
    # foundrixModules.services.stalwart
    # foundrixModules.services.webmail
    ./home.nix
    ./caddy.nix
    ./options.nix
    ./branding
  ];

  users.users.${userName} = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    uid = 1000;
    shell = pkgs.zsh;
    hashedPassword = "$y$j9T$gV9uVMQ5oZ8mg4Opln0cz1$r2wok8rIwQm/7sdOEJT8QtKfCw.Jf3bHKHkZG6nF7c3";
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3LlSENwLSVob/uIKNoyjtSrffFs4lzNC9AMqxmEHSz simao@aludepp"
    ];
  };
  users.groups.${userName}.gid = config.users.users.${userName}.uid;

  home-manager.users.${userName}.home.stateVersion = "25.05";

  environment.systemPackages = with pkgs; [
    conntrack-tools
  ];

  security.sudo.enable = true;

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  system.nixos-init.enable = true;
  boot.initrd.systemd.enable = true;

  system.etc.overlay.enable = true;
  services.userborn.enable = true;

  nix.settings.trusted-users = [
    "root"
    "@wheel"
  ];

  system.forbiddenDependenciesRegexes = lib.mkForce [ ];

  boot.uki.name = "xos-core-infra";
  system.nixos.distroId = "xos-core-infra";
  system.image.id = "xos-core-infra-hetzner";
  system.image.version = "1";

  system.stateVersion = "25.05";

  networking.nameservers = [
    "1.1.1.1"
    "2606:4700:4700::1111"
  ];

  services.resolved = {
    enable = true;
    settings.Resolve = {
      DNSSEC = "false";
      FallbackDNS = [
        "1.1.1.1"
        "1.0.0.1"
        "2606:4700:4700::1111"
        "2606:4700:4700::1001"
        "9.9.9.9"
        "2620:fe::fe"
      ];
    };
  };

  # ZeroSSL EAB credentials for Caddy
  custom.zerosslEabFile = "/var/credentials/zerossl-eab.env";

  # Zitadel identity provider
  foundrix.services.zitadel = {
    enable = true;
    webDomain = config.custom.ssoDomain;
    adminOrg = config.custom.orgDomain;
    orgDomains.${config.custom.orgDomain} = { };
    instanceName = "halogenOS";
    policies = {
      loginPolicy.allowExternalIdp = false;
      disallowPublicOrgRegistration = true;
    };
    privacyPolicy = {
      enable = true;
      lastUpdated = "2 April 2026";
      hostingProvider = {
        name = "Hetzner Online GmbH";
        location = "Nuremberg, Germany";
        purpose = "Server hosting (VPS)";
      };
      supervisoryAuthority = {
        name = "Bayerisches Landesamt für Datenschutzaufsicht (BayLDA)";
        address = "Promenade 18, 91522 Ansbach";
        website = "https://www.lda.bayern.de";
      };
    };
    instance = {
      passwordComplexity = {
        minLength = 14;
        hasNumber = true;
        hasLowercase = true;
        hasUppercase = true;
        hasSymbol = false;
      };
      branding = {
        themeMode = "auto";
        primaryColor = "#00B4E7";
        primaryColorDark = "#00B4E7";
        backgroundColor = "#dafdff";
        backgroundColorDark = "#001220";
        fontColor = "#1a1a1a";
        fontColorDark = "#ffffff";
        disableWatermark = true;
      };
      languages = {
        default = "en";
        allowed = [ "en" ];
      };
      oidcSettings = {
        refreshTokenLifetimeDays = 7;
      };
      secretGenerators = {
        otpSms = { expirationMinutes = 15; length = 6; };
        otpEmail = { expirationMinutes = 15; length = 6; };
      };
    };
  };

  # Forgejo (dev-infra) OIDC apps — prod Zitadel is authoritative for both
  # dev-infra-int and dev-infra-prod Forgejo instances. Credentials are copied
  # out-of-band to each dev-infra host's /var/credentials/forgejo-oidc.env.
  foundrix.services.zitadel.projects.Forgejo = lib.mkIf config.custom.isProd {
    apps.forgejo-int = {
      type = "confidential";
      redirectUris = [ "https://git-int.halogenos.org/user/oauth2/zitadel/callback" ];
    };
    apps.forgejo-prod = {
      type = "confidential";
      redirectUris = [ "https://git.halogenos.org/user/oauth2/zitadel/callback" ];
    };
    roles.admin.displayName = "Forgejo Administrator";
  };

  # Flatten per-project role grants into a single `roles` claim so downstream
  # OIDC consumers (currently just Forgejo) can read them without parsing
  # Zitadel's URN-shaped default claim.
  foundrix.services.zitadel.actions.flatRoles = lib.mkIf config.custom.isProd {
    script = ''
      function flatRoles(ctx, api) {
        ctx.v1.getUser();
        var grants = ctx.v1.user.grants;
        if (grants === undefined || grants.count === 0) {
          return;
        }
        var roles = [];
        grants.grants.forEach(function(grant) {
          grant.roles.forEach(function(role) {
            roles.push(role);
          });
        });
        api.v1.claims.setClaim('roles', roles);
      }
    '';
    triggers = [
      { flowType = "complementToken"; triggerType = "preUserinfoCreation"; }
      { flowType = "complementToken"; triggerType = "preAccessTokenCreation"; }
    ];
  };

  # # Stalwart mail server
  # foundrix.services.stalwart = {
  #   enable = true;
  #   domain = config.custom.mailDomain;
  #   webmailDomain = config.custom.webmailDomain;
  #   acme.eabCredentialsFile = config.custom.zerosslEabFile;
  # };

  # # TMail webmail
  # foundrix.services.webmail = {
  #   enable = true;
  #   domain = config.custom.webmailDomain;
  # };

  # Dynamic DNS resolution for nftables
  foundrix.services.nftables-dns = {
    enable = true;
    allowedConnections = [
      {
        host = "acme.zerossl.com";
        ports = [ 443 ];
      }
      {
        host = "ari.trust-provider.com";
        ports = [ 443 ];
      }
      {
        host = "zerossl.ocsp.sectigo.com";
        ports = [ 80 ];
      }
      {
        host = "*";
        ports = [ 25 ];
      }
      {
        host = "*";
        ports = [ 443 ];
      }
      {
        host = "cloudflare-dns.com";
        ports = [ 53 ];
        protocol = "udp";
      }
      {
        host = "dns.quad9.net";
        ports = [ 53 ];
        protocol = "udp";
      }
    ]
    ++ map (host: {
      inherit host;
      ports = [ 123 ];
      protocol = "udp";
    }) config.networking.timeServers;
    updateInterval = "1h";
  };

  networking.firewall.allowedTCPPorts = [ 22 ]
    ++ lib.optionals ((config.device.name or "") == "qemu") [ 8080 ];

  foundrix.config.networking.controlled-egress-firewall = {
    enable = true;
    allowLinkLocalMetadata = true;
  };

  # Docker needs to restart when nftables rules change to re-add its networking rules
  systemd.services.docker = {
    after = [
      "nftables.service"
      "nftables-dns-update.service"
    ];
    wants = [ "nftables-dns-update.service" ];
    partOf = [ "nftables.service" ];
  };

  foundrix.general.qemu.portForwards = [
    { host = 2222; guest = 22; }
    { host = 18080; guest = 8080; }
    { host = 8443; guest = 443; }
    { host = 2525; guest = 25; }
    { host = 4465; guest = 465; }
    { host = 9993; guest = 993; }
  ];

  foundrix.general.qemu = {
    dataDevice = "/dev/disk/by-id/ata-QEMU_HARDDISK_QM00003";
    disks = [ { name = "data"; size = "40G"; } ];
  };
}
