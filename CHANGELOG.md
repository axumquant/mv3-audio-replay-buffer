# Changelog

All notable changes to this project will be documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-15

Initial public release. Extracted from a production AI coaching extension (`sales-coach`) and decoupled into a domain-agnostic library.

### Added
- `AudioReplayBuffer` — IndexedDB-backed, AES-GCM-256 encrypted audio frame buffer that survives Chrome MV3 service-worker restarts.
- Public API: `init()`, `rememberFrame()`, `acknowledge(lastAckSeq)`, `replay(forward, reason)`, `status()`, `clear()`, `rotateKey()`.
- Decoupled forward callback — no hardcoded `chrome.runtime.sendMessage`. Callers control where replayed frames go (WebSocket, fetch, queue, etc.).
- All seven storage / capacity knobs are constructor options: `dbName`, `dbVersion`, `frameStoreName`, `keyStoreName`, `keyId`, `ttlMs`, `maxFrames`, `chunkMs`, `encrypt`.
- TTL-based eviction (default 60s) AND max-frames eviction (default 240) — whichever fires first.
- Ack-monotonic trim — `acknowledge(seq)` removes only acked-and-older frames, never re-trims.
- `fake-indexeddb` test setup for Node-based unit testing.

### Known limitations
- Safari has IndexedDB quota quirks; not currently tested there.
- `replay()` does not auto-trim — trimming is ack-driven by design so replay can be called multiple times if the upstream consumer is also unreliable.

[Unreleased]: https://github.com/axumquant/mv3-audio-replay-buffer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/axumquant/mv3-audio-replay-buffer/releases/tag/v0.1.0
