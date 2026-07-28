# Changelog

## [Unreleased]

### Changed

- Require the first executor-registry host contract, assumed for publishing to be
  `@oh-my-pi/pi-coding-agent >=17.2.0 <18`; unpatched `17.1.5` hosts are rejected at extension registration.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed the peer dependency range for @oh-my-pi/pi-coding-agent to match the current ^16 major version.

## [15.9.0] - 2026-06-04

### Fixed

- Fixed swarm `/swarm run` failing with authStorage/modelRegistry identity error ([#1472](https://github.com/can1357/oh-my-pi/issues/1472))
