{
  config,
  lib,
  pkgs,
  ...
}:
let
  # ---------------------------------------------------------------------------
  # The published identity for the SSO service.
  #
  # This used to live in foundrix, which rendered the policy from a gomplate
  # template driven by NixOS options. It does not belong there: foundrix is
  # infrastructure, and who the controller is and which authority is competent
  # are facts about an operator. foundrix now takes a finished document and
  # serves it, and each consumer writes its own.
  #
  # dev-infra carries the same identity for the git service. That duplication
  # is deliberate — they are distinct services, and a shared source would mean
  # one repo reaching into another for legal text.
  # ---------------------------------------------------------------------------
  operator = {
    name = "Simão Gomes Viana";
    # A c/o forwarding address, so a private home address is not published.
    careOf = "c/o IP-Management #10911";
    street = "Ludwig-Erhard-Str. 18";
    city = "20459 Hamburg";
    countryEn = "Germany";
  };

  # Competent authority follows the controller's actual establishment (Bavaria),
  # not the c/o mailing address in Hamburg.
  authority = {
    name = "Bayerisches Landesamt für Datenschutzaufsicht (BayLDA)";
    address = "Promenade 18, 91522 Ansbach";
    website = "https://www.lda.bayern.de";
  };

  # Bump when the text changes materially — it tells readers which version they
  # are looking at, so it must not float with the build.
  lastUpdatedEn = "27 July 2026";

  vars = {
    operatorName = operator.name;
    operatorCareOf = operator.careOf;
    operatorStreet = operator.street;
    operatorCity = operator.city;
    operatorCountryEn = operator.countryEn;
    emailPrivacy = "privacy@${config.custom.orgDomain}";
    ssoDomain = config.custom.ssoDomain;
    hostingProvider = "Hetzner Online GmbH";
    hostingLocation = "Nuremberg, Germany";
    dataLocation = "the European Union";
    authorityName = authority.name;
    authorityAddress = authority.address;
    authorityWebsite = authority.website;
    inherit lastUpdatedEn;
  };

  # `substitute` comes from stdenv's setup.sh and replaces @token@ literally,
  # with no shell involved in the value.
  privacyPolicy = pkgs.runCommand "xos-sso-privacy-policy.html" { } ''
    substitute ${./privacy.en.html} $out ${
      lib.concatStringsSep " " (
        lib.mapAttrsToList (
          name: value: "--subst-var-by ${lib.escapeShellArg name} ${lib.escapeShellArg value}"
        ) vars
      )
    }
  '';
in
{
  # `link` keeps its default of https://<webDomain>/privacy-policy, which is
  # where the module serves this file.
  foundrix.services.zitadel.privacyPolicy = {
    enable = true;
    content = privacyPolicy;
  };
}
