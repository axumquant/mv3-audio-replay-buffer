# `@axumquant/mv3-audio-replay-buffer`

**Encrypted, durable audio frame buffer for MV3 service workers.**

Survive Chrome service worker restarts mid-call. Keep the last N seconds of audio AES-GCM encrypted at rest. Replay un-acked frames the moment your backend WebSocket reconnects. No `chrome.runtime` coupling — bring your own transport.

[![CI](https://github.com/axumquant/mv3-audio-replay-buffer/actions/workflows/ci.yml/badge.svg)](https://github.com/axumquant/mv3-audio-replay-buffer/actions/workflows/ci.yml)

---

## The problem

You're streaming live audio from a Chrome MV3 extension to a backend STT service (Deepgram, AssemblyAI, your own Whisper). Three things conspire against you:

1. **MV3 service workers die unpredictably** — after ~30 seconds idle, on extension reload, on memory pressure. Anything buffered in SW memory is gone.
2. **`chrome.storage.local` is not encrypted.** It is readable by other extensions sharing the profile in some setups, and is plainly visible on disk. Live audio chunks are sensitive — especially in a sales/medical/legal context.
3. **WebSockets flap.** Wi-Fi blips, backend deploys, idle timeouts — every reconnect is a chance to silently drop seconds of audio. STT services that don't get a clean stream produce garbled transcripts.

The only durable, encrypt-capable storage available to MV3 offscreen documents is **IndexedDB + Web Crypto**. But writing a correct buffer (TTL eviction, sequence numbers, ack-trim, AES-GCM with proper IVs, key rotation) is the kind of code that's easy to get wrong and impossible to make small. So we extracted ours from sales-coach into a library.

## What this solves

- **Encrypted at rest** — every frame's audio payload is AES-GCM-256 encrypted with a non-extractable `CryptoKey` persisted in IndexedDB. The plaintext never touches disk.
- **Survives SW restart** — frames sit in IndexedDB. After the SW comes back, `init()` rehydrates the seq counter and you keep streaming.
- **Ack-trimmed** — backend tells you "I've got everything through seq N", you call `acknowledge(N)`, and those frames get dropped on the next cleanup pass. Memory + storage stay bounded.
- **Replay on demand** — on reconnect, hand `replay()` a callback and it forwards every un-acked frame, in seq order, tagged `replay: true` so the backend knows to backfill, not duplicate.
- **Transport-agnostic** — the buffer never calls `chrome.runtime.sendMessage`, `WebSocket.send`, or anything else. *You* tell it where the frames go via the callback.

---

## Install

```bash
npm install @axumquant/mv3-audio-replay-buffer
```

Requires **Node ≥ 18** for `npm install` / build / test. The library itself runs in browser contexts that expose `indexedDB` and `crypto.subtle` — i.e. modern Chromium-based browsers and MV3 offscreen documents.

Peer dependencies: **none**. The whole library is one TypeScript class plus two helpers; it does not pull in any runtime deps.

---

## Quickstart

```typescript
import { AudioReplayBuffer } from "@axumquant/mv3-audio-replay-buffer";

const buffer = new AudioReplayBuffer({ dbName: "my-app-audio" });
await buffer.init();

// Producer: MediaRecorder gives you a chunk → buffer it AND forward live.
recorder.ondataavailable = async (event) => {
  const data = await blobToBase64(event.data);
  const remembered = await buffer.rememberFrame({ data, ts: Date.now() });
  ws.send(JSON.stringify({ type: "audio_frame", ...remembered }));
};

// Consumer ack:
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "ack") void buffer.acknowledge(msg.seq);
});

// Reconnect: flush un-acked frames to the new socket before resuming live.
async function onReconnect(newWs: WebSocket) {
  await buffer.replay(async (frame) => {
    newWs.send(JSON.stringify({ type: "audio_frame", ...frame }));
  }, "ws_reconnect");
}
```

That's the full lifecycle: `init` → `rememberFrame` per chunk → `acknowledge` on backend confirmation → `replay` on reconnect → `clear` at end of call.

---

## API reference

### `new AudioReplayBuffer(options?: AudioReplayBufferOptions)`

| Option           | Default                  | Notes                                                                      |
| ---------------- | ------------------------ | -------------------------------------------------------------------------- |
| `dbName`         | `"mv3_audio_replay_v1"`  | IndexedDB database name. Pick a unique name per app.                       |
| `dbVersion`      | `1`                      | IndexedDB schema version. Bump when changing store names.                  |
| `frameStoreName` | `"frames"`               | Object store for encrypted frame rows.                                     |
| `keyStoreName`   | `"keys"`                 | Object store for the persisted AES key.                                    |
| `keyId`          | `"session-audio-buffer"` | Key ID within `keyStoreName`. Pin per-session if you want key-per-call.    |
| `ttlMs`          | `60_000`                 | Frames older than this get evicted on the next cleanup pass.               |
| `maxFrames`      | `240`                    | Hard cap on un-acked frames. Oldest evicted first.                         |
| `chunkMs`        | `250`                    | Used only to compute `buffered_ms`. Doesn't affect eviction.               |
| `encrypt`        | `true`                   | If `false`, frames are stored as plaintext JSON. Useful for tests/debug.   |

### `await buffer.init(): Promise<void>`

Opens the IndexedDB and hydrates `nextSeq` from persisted frames. Safe to call repeatedly. Implicitly awaited by every other method, so calling it explicitly is optional but recommended at boot.

### `await buffer.rememberFrame(frame: AudioFrame): Promise<RememberedFrame>`

Encrypts and stores a frame. Assigns `seq = nextSeq + 1` if the caller didn't supply one. Returns the canonical metadata + original `data` + current status, so you can forward live without re-reading.

```typescript
const remembered = await buffer.rememberFrame({
  data: base64,
  seq: 42,                                  // optional; auto-assigned otherwise
  ts: Date.now(),                            // optional; defaults to now
  codec: "audio/webm;codecs=opus",           // optional metadata
  sample_rate: 16000,
  capture_mode: "tab",                       // caller-defined label
  speaker: "agent",
  call_id: "call_xyz",                       // opaque to the buffer
});
// remembered = { seq, ts, codec, sample_rate, capture_mode, speaker, call_id,
//                data, buffered_frames, buffered_ms, audio_seq, last_ack_seq,
//                ttl_ms, max_frames }
```

### `await buffer.acknowledge(seq: number): Promise<BufferStatus>`

Mark frames with `seq <= ackSeq` as confirmed. They get trimmed on the next cleanup pass. Idempotent and monotonic — passing a lower seq later is a no-op.

### `await buffer.replay(forward, reason?): Promise<ReplayResult>`

Send every un-acked, un-expired frame to your callback in seq order. Each frame is decrypted, tagged `replay: true` and `replay_reason: reason`, then handed to `forward`. Your callback may be async — replay awaits each call so you can rate-limit.

```typescript
type ForwardCallback = (frame: ReplayedFrame) => void | Promise<void>;

const result = await buffer.replay(async (frame) => {
  await myStream.send(frame);
}, "ws_reconnect");
// result = { ...status, replayed_frames: 12 }
```

Frames that fail decryption (wrong key, tampered ciphertext) are silently skipped — replay is best-effort. **Replay does not trim** — frames stay buffered until ack'd or evicted.

### `await buffer.status(): Promise<BufferStatus>`

```typescript
{
  buffered_frames: 5,      // un-acked frames currently on disk
  buffered_ms: 1250,       // = buffered_frames * chunkMs
  audio_seq: 42,           // highest seq ever assigned
  last_ack_seq: 37,
  ttl_ms: 60000,
  max_frames: 240,
}
```

Calling `status()` triggers a cleanup pass — TTL + cap eviction is lazy and runs on every public op.

### `await buffer.clear(): Promise<BufferStatus>`

Drop all frames AND the AES key. Use at end-of-session. The next `rememberFrame()` will lazily regenerate a fresh key.

### `await buffer.rotateKey(): Promise<BufferStatus>`

Wipe the AES key and the frame store (existing ciphertext is unreadable after rotation). The next write generates a fresh key.

---

## Encryption

- **Algorithm:** AES-GCM-256.
- **Key derivation:** none — keys are generated via `crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])`. They are **non-extractable** — the raw bytes never leave the browser.
- **Persistence:** the `CryptoKey` object is stored via IndexedDB's structured clone. Chromium browsers support cloning `CryptoKey`; the key handle survives SW restarts.
- **IV:** a fresh 12-byte random nonce per encryption (NIST SP 800-38D recommended size). Authentication tag is 128 bits (AES-GCM default).
- **Rotation:** call `rotateKey()` to wipe and regenerate. Any in-flight ciphertext written before rotation becomes unreadable.

**What's NOT protected:**
- Frame metadata (codec, sample_rate, capture_mode, speaker, call_id, ts, seq) is stored in plaintext outside the ciphertext so the buffer can sort and trim without decrypting. If you consider metadata sensitive, encrypt it before stuffing it into the `AudioFrame`.

---

## Integration patterns

### A) Deepgram live STT with replay-on-reconnect

```typescript
const buffer = new AudioReplayBuffer({ dbName: "deepgram-audio" });
await buffer.init();

function connect(): WebSocket {
  const ws = new WebSocket("wss://api.deepgram.com/v1/listen?...");
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    void buffer.replay(async (frame) => {
      ws.send(base64ToArrayBuffer(frame.data));  // Deepgram wants binary
    }, "ws_reconnect");
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.is_final && typeof msg.seq === "number") {
      void buffer.acknowledge(msg.seq);          // ack at the final-transcript boundary
    }
  });

  ws.addEventListener("close", () => {
    setTimeout(() => connect(), 1_000);
  });

  return ws;
}

let ws = connect();
recorder.ondataavailable = async (e) => {
  const remembered = await buffer.rememberFrame({ data: await blobToBase64(e.data), ts: Date.now() });
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(base64ToArrayBuffer(remembered.data));
  }
  // If the socket is down, just buffer — replay will catch it up on next connect.
};
```

### B) Twilio Voice media-stream bridge

```typescript
// Twilio sends/receives base64-encoded mulaw 8kHz frames over a WebSocket.
const buffer = new AudioReplayBuffer({
  dbName: "twilio-bridge",
  chunkMs: 20,           // Twilio's media-stream frame size
  maxFrames: 1_500,      // 30s of headroom at 20ms/frame
});
await buffer.init();

twilioWs.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === "media") {
    await buffer.rememberFrame({
      data: msg.media.payload,
      seq: Number(msg.media.chunk),
      ts: Date.now(),
      codec: "mulaw",
      sample_rate: 8000,
    });
  }
});

// Forward to your STT/agent backend with replay on its socket reconnect.
agentWs.on("open", () => {
  void buffer.replay((frame) => {
    agentWs.send(JSON.stringify({ event: "media", chunk: frame.seq, payload: frame.data }));
  }, "agent_reconnect");
});
```

### C) Custom WS audio pipeline with end-to-end seq tracking

```typescript
const buffer = new AudioReplayBuffer({ dbName: "custom-stream" });
await buffer.init();

// Producer side
async function onChunk(chunk: { base64: string; ts: number }) {
  const remembered = await buffer.rememberFrame({ data: chunk.base64, ts: chunk.ts });
  ws.send(JSON.stringify({
    type: "audio_frame",
    seq: remembered.seq,
    ts: remembered.ts,
    data: remembered.data,
    // Piggyback status so the backend can warn on lag
    buffered_frames: remembered.buffered_frames,
    buffered_ms: remembered.buffered_ms,
  }));
}

// Consumer ack
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "audio_ack") void buffer.acknowledge(msg.seq);
});
```

---

## Performance

- **Write latency:** ~3–10 ms per `rememberFrame()` on a warm Chrome IndexedDB on a desktop SSD. Dominated by the AES-GCM encrypt (sub-ms for typical chunk sizes) and the IDB transaction roundtrip. The library batches nothing — each frame is its own transaction so a SW death mid-write loses at most one frame.
- **Max realistic throughput:** ~100 frames/sec sustained on commodity hardware (i.e. 10 ms/frame chunks). For higher rates, batch at the producer level before calling `rememberFrame`.
- **Storage:** with `maxFrames = 240` and typical 250 ms Opus chunks (~6 KB encoded), the buffer caps at ~1.5 MB on disk. AES-GCM adds 28 bytes overhead per record (12-byte IV + 16-byte auth tag, IV stored alongside).
- **Cleanup cost:** `cleanup()` walks every row to filter by TTL / ack. For `maxFrames = 240` this is negligible; if you raise `maxFrames` to thousands, consider running cleanup less aggressively (the library does it on every public op today).

---

## Pitfalls

- **`IndexedDB blocked` errors.** If two extension contexts open the same `dbName` at different `dbVersion` values, the open with the higher version blocks until the lower-version connection closes. Bumping `dbVersion` while tabs are open will hang. Mitigations: pick a `dbName` carefully up front, or use the version-change hook to close the older connection.
- **Safari quirks.** Safari has historically thrown `DataCloneError` when structured-cloning `CryptoKey` to IndexedDB. The library targets Chromium-family browsers; on Safari you'd need to switch to `JsonWebKey`-encoded keys (not currently implemented).
- **Key persistence across SW restarts.** The CryptoKey survives SW restarts via IndexedDB structured clone in Chromium. If the user's profile is corrupted or the IDB is wiped, frames written under the old key are permanently unreadable — `replay()` returns them as skipped (decrypt returns `null`).
- **Replay does not auto-trim.** Frames stay on disk until ack'd. If your backend forgets to ack, you'll lean on TTL + `maxFrames` for eviction. Set those conservatively for your worst-case retention.
- **Sequence collisions.** If you pass an explicit `seq` and reuse a value, the second `rememberFrame` overwrites the first row (IndexedDB `put` semantics on the `seq` keypath). Either let the buffer assign seqs, or guarantee monotonicity at the producer.
- **`encrypt` flips are sticky per `dbName`.** Frames written with `encrypt: true` cannot be read with `encrypt: false` (and vice versa). If you change the mode, `clear()` first.
- **MV3 offscreen-only.** This library expects a DOM context (`indexedDB` + `crypto.subtle`). The MV3 background service worker has both, but no `MediaRecorder` — wire this from the offscreen document, not directly from the SW.

---

## License

MIT — see [LICENSE](./LICENSE).

Extracted from [sales-coach](https://github.com/axumquant/sales-coach)'s offscreen audio pipeline.
