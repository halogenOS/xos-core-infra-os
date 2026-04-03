{ pkgs, ... }:
let
  logo = pkgs.stdenvNoCC.mkDerivation {
    name = "xos-branding";
    src = ./.;
    nativeBuildInputs = [
      (pkgs.python3.withPackages (ps: [ ps.pillow ]))
    ];
    buildPhase = ''
      mkdir -p $out
      python3 generate-logo.py
    '';
  };
in
{
  foundrix.services.zitadel.instance.branding = {
    logoUrl = "${logo}/logo-light.png";
    logoUrlDark = "${logo}/logo-dark.png";
    iconUrl = "${logo}/icon.png";
    iconUrlDark = "${logo}/icon.png";
  };
}
