# Changelog

All notable changes to this project are recorded here.

## 2026-06-24

### Fixed

- Fixed the Apple Music authorization flow by wrapping `MusicKit.authorize()` with a timeout and a clearer retry message when the authorization callback does not return.
- Relaxed the Worker `Referrer-Policy` from `no-referrer` to `strict-origin-when-cross-origin` so the Apple Music authorization callback can complete more reliably while still avoiding full URL leakage.

Commit: `0069506` (`Fix Apple Music authorization callback`)
