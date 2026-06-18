# Nix outline fixture.

{ pkgs ? import <nixpkgs> { } }:

let
  greeting = "hello";

  mkShell = name: attrs:
    pkgs.mkShell (attrs // { inherit name; });

  tools = rec {
    formatter = pkgs.alejandra;
    linter    = pkgs.statix;
    combined  = [ formatter linter ];
  };

  builder = { stdenv, lib }:
    stdenv.mkDerivation {
      pname = "example";
      version = "0.1.0";
    };
in
mkShell "dev" {
  buildInputs = [ tools.formatter ];
}
