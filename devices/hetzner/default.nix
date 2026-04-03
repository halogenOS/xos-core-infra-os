{
  lib,
  pkgs,
  foundrixModules,
  ...
}:
{
  imports = [
    ./filesystems.nix
    foundrixModules.hardware.cloud.hetzner
    foundrixModules.profiles.image.server-writable
    foundrixModules.config.runtime.repart.var
    foundrixModules.config.device.dynamic
  ];

  device = {
    name = "hetzner";
    platforms = [ "x86_64" ];
    crossCompile = false;
  };

  foundrix.config.device.dynamic.hetzner-data.glob = "/dev/disk/by-id/scsi-0HC_Volume_*";
  foundrix.config.image.device.dataDevice = "/dev/dynamic/hetzner-data-0";
  foundrix.config.image.boot.systemd-boot.timeout = 1;
  boot.kernelPackages = lib.mkForce pkgs.linuxPackages_latest;
  boot.kernelParams = [ "systemd.setenv=SYSTEMD_SULOGIN_FORCE=1" ];

  # Ensure IPv6 is configured before DNS resolution
  systemd.services.hetzner-ipv6.before = [ "nftables-dns-update.service" ];
}
