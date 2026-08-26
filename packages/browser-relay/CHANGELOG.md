# Changelog

## [Unreleased]

### Fixed

- Fixed the browser-relay extension missing attachments that were created after the relay had already disconnected, so a late `chrome.debugger.attach` no longer escapes the orphan sweep and leaves Chrome's "started debugging this browser" infobar stranded after the grace timer expires ([#8930](https://github.com/can1357/oh-my-pi/issues/8930)).
- Fixed a fast-reconnect race where the extension's cleanup detach of a late-resolving attach was reported as a user cancellation: it is now marked guard-internal so the surviving relay reconciles the tab from the next `hello` instead of banning it ([#8930](https://github.com/can1357/oh-my-pi/issues/8930)).
- Fixed the extension never reclaiming a debugger attachment that survived an MV3 service-worker restart while the relay stayed unreachable: startup/install/keepalive now reconcile surviving attachments and arm an orphan sweep independent of a successful relay connection ([#8930](https://github.com/can1357/oh-my-pi/issues/8930)).
- Fixed a fast-reconnect race where a guard detach resolving during reconnect fired a second `hello` alongside the new socket's own: both could launch competing recovery attaches, and the loser's "already attached" failure retracted the tab the winner just recovered. Hello refreshes are now coalesced per live socket so only one recovery attach is launched ([#8930](https://github.com/can1357/oh-my-pi/issues/8930)).
### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
