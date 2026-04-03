{
  applyHomeManagerShared,
  pkgs,
  foundrixPkgs,
  ...
}:
{
  home-manager = applyHomeManagerShared {
    home.language = rec {
      base = "en_US.UTF-8";
      measurement = base;
      monetary = base;
      name = base;
      paper = base;
      time = base;
    };
    home.packages = with pkgs; [
      jq
      pv
      pwgen
      socat
      git
      curl
      dig
      unzip
      file
      zstd
      tree
      bat
      fd
      brotli
      e2fsprogs
      lm_sensors
      fastfetch
      bc
      openssl
      nmap
      lz4
      zip
      btop
      rsync
      iptables
      nftables
      inetutils
      hwloc
      dysk
      hdparm
      ddrescue
      smartmontools
      stress
      vim
      foundrixPkgs.json2nix
      foundrixPkgs.nix2json
      foundrixPkgs.git-aliases
    ];
  };
}
