---
name: mv3-audio-replay-buffer
description: When and how to add a durable, encrypted audio replay buffer to a Chrome MV3 extension or any browser app that streams live audio over an unreliable WebSocket. Use when the user mentions "live audio reconnect", "audio buffering chrome extension", "MV3 offscreen audio", "deepgram replay buffer", or any scenario where service worker restarts must not drop in-flight audio chunks.
---

# mv3-audio-replay-buffer

`AudioReplayBuffer` is the encrypted IndexedDB-backed audio frame buffer extracted from sales-coach. It survives MV3 service worker restarts, holds audio chunks AES-GCM encrypted at rest, evicts on TTL + frame-count caps, and exposes ack-based replay-on-reconnect. The forwarding side is fully decoupled — you give it a callback, it gives back each buffered frame in seq order.

## When to use

- Chrome MV3 extension capturing tab/mic audio with `MediaRecorder` in an offscreen document, streaming chunks to a backend WebSocket for live STT (Deepgram, AssemblyAI, Whisper).
- Any browser app where the backend connection can flake and you need to replay the last 30–60 seconds of audio after reconnect without losing alignment.
- You need encryption at rest for compliance — HIPAA-style audio handling on a shared computer, multi-tenant offscreen pages, etc.
- You need a durable buffer that outlives the service worker; raw in-memory queues lose audio when the SW sleeps.

## When NOT to use

- Your stream is already reliable end-to-end (HTTP/2 long-poll with retry, Twilio media stream with built-in buffering). The extra IndexedDB write per chunk is overhead.
- You're outside a browser context — Node/Deno servers can use a normal bounded queue.
- You need *low-latency* audio (sub-50ms round-trip). IndexedDB writes add ~3–10 ms per chunk; for sub-frame latencies use an in-memory ring buffer.

## Quick API

```typescript
import { AudioReplayBuffer } from "@axumquant/mv3-audio-replay-buffer";

const buffer = new AudioReplayBuffer({
  dbName: "my-app-audio",   // namespace per app
  ttlMs: 60_000,            // 60s default
  maxFrames: 240,           // 60s @ 250ms/chunk
  encrypt: true,            // AES-GCM-256 at rest
});

await buffer.init();
await buffer.rememberFrame({ data: base64Chunk, seq: 1, ts: Date.now() });
await buffer.acknowledge(lastAckedSeq); // backend confirms
await buffer.replay(async (frame) => {
  ws.send(JSON.stringify(frame));        // forward via your transport
}, "ws_reconnect");
```

## Common tasks

### 1. Wire `MediaRecorder` chunks through the buffer to a WebSocket

```typescript
const buffer = new AudioReplayBuffer({ dbName: "sales-coach-audio" });
await buffer.init();

recorder.ondataavailable = async (event) => {
  const base64 = await blobToBase64(event.data);
  const remembered = await buffer.rememberFrame({
    data: base64,
    ts: Date.now(),
    codec: "audio/webm;codecs=opus",
    sample_rate: 16000,
    capture_mode: "tab",
    speaker: "agent",
  });
  ws.send(JSON.stringify({
    type: "audio_frame",
    seq: remembered.seq,
    data: remembered.data,
    buffered_frames: remembered.buffered_frames,
  }));
};
```

### 2. Ack frames as your backend confirms them

```typescript
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "ack") {
    void buffer.acknowledge(msg.seq);
  }
});
```

### 3. Replay un-acked frames after reconnect

```typescript
ws.addEventListener("close", () => {
  reconnectWithBackoff(async (newWs) => {
    await buffer.replay(async (frame) => {
      newWs.send(JSON.stringify({
        type: "audio_frame",
        seq: frame.seq,
        data: frame.data,
        replay: true,
        replay_reason: frame.replay_reason,
      }));
    }, "ws_reconnect");
  });
});
```

### 4. End-of-session cleanup

```typescript
async function endCall() {
  recorder.stop();
  await buffer.clear();   // wipes frames AND the AES key
}
```

### 5. Periodic status reporting back to the SW

```typescript
setInterval(async () => {
  const status = await buffer.status();
  chrome.runtime.sendMessage({ type: "audio_buffer_status", ...status });
}, 5_000);
```

## Pitfalls

- **IndexedDB `blocked` errors.** If two tabs/contexts open the same DB at different `dbVersion`s, the newer one blocks until the older closes. Don't bump `dbVersion` lightly; use a fresh `dbName` for new schemas.
- **Service worker death drops the JS handle, not the data.** Frames are on disk; the in-memory `nextSeq` and `lastAckSeq` are rebuilt from disk on `init()`. The ack counter resets to 0 across SW restarts unless YOU persist it separately — supply `seq` explicitly per frame if your producer survives.
- **Safari quirks.** Safari has historically thrown on `CryptoKey` structured clone into IndexedDB. The library doesn't currently target Safari extension contexts; Chromium-family browsers work.
- **`maxFrames` is a soft cap, not a hard limit.** A burst of writes during cleanup can transiently exceed `maxFrames`; the next op trims back down.
- **Encryption is opt-in only at construction.** Once you've written frames with `encrypt: true`, you can't read them back with `encrypt: false` (and vice versa). Pick one per `dbName`.
- **Replay does NOT trim.** Frames stay until ack'd. If your backend never acks, you'll lean on TTL/maxFrames to evict.

## Files

- `src/buffer.ts` — `AudioReplayBuffer` class. Seq assignment, ack semantics, cleanup, replay orchestration.
- `src/crypto.ts` — `FrameCrypto`: AES-GCM-256 encrypt/decrypt, key generation, rotation. Persists key handle in IndexedDB.
- `src/indexeddb.ts` — `IndexedDbStore`: thin wrapper around `indexedDB.open`, CRUD primitives, schema upgrade.
- `src/types.ts` — public types (`AudioFrame`, `ReplayedFrame`, `BufferStatus`, `AudioReplayBufferOptions`, etc.).
- `src/index.ts` — public re-exports.
