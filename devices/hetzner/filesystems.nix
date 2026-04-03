{
  foundrixModules,
  ...
}:
{
  imports = [
    foundrixModules.config.filesystem.root-tmpfs
    foundrixModules.config.filesystem.esp
    foundrixModules.config.filesystem.nix
    foundrixModules.config.filesystem.home-tmpfs
  ];

  foundrix.config.filesystem.home-tmpfs.size = "1G";
}
