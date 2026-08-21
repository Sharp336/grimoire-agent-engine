# Changelog

## [Unreleased]

### Fixed

- Fixed the browser-relay extension missing attachments that were created after the relay had already disconnected, so a late `chrome.debugger.attach` no longer escapes the orphan sweep and leaves Chrome's "started debugging this browser" infobar stranded after the grace timer expires ([#8930](https://github.com/can1357/oh-my-pi/issues/8930)).

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
