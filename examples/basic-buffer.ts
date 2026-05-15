/**
 * Basic buffer example — put a few frames, ack some, replay the rest.
 *
 * Run inside a Chrome extension offscreen document or any browser context
 * with `indexedDB` and `crypto.subtle`. Not runnable in pure Node without
 * a DOM polyfill (see `tests/` for the fake-indexeddb setup).
 */

import { AudioReplayBuffer } from "@axumquant/mv3-audio-replay-buffer";

async function main(): Promise<void> {
  const buffer = new AudioReplayBuffer({
    dbName: "demo-audio",
    ttlMs: 30_000,
    maxFrames: 120,
  });
  await buffer.init();

  // Producer side — push 5 fake frames as they "arrive" from MediaRecorder.
  for (let i = 1; i <= 5; i += 1) {
    await buffer.rememberFrame({
      data: btoa(`fake-audio-chunk-${i}`),
      seq: i,
      ts: Date.now(),
      codec: "audio/webm;codecs=opus",
      sample_rate: 16000,
      capture_mode: "tab",
      speaker: "agent",
      call_id: "demo-call",
    });
  }

  console.log("after 5 puts:", await buffer.status());
  // { buffered_frames: 5, buffered_ms: 1250, audio_seq: 5, last_ack_seq: 0, … }

  // Backend acks through seq 3.
  await buffer.acknowledge(3);
  console.log("after ack(3):", await buffer.status());
  // { buffered_frames: 2, … }

  // Simulate reconnect — flush the remaining frames to the new socket.
  const result = await buffer.replay(async (frame) => {
    console.log(
      `replay seq=${frame.seq} reason=${frame.replay_reason} bytes=${frame.data.length}`,
    );
    // In a real app: webSocket.send(JSON.stringify(frame))
  }, "ws_reconnect");

  console.log("replay result:", result);
  // { buffered_frames: 2, replayed_frames: 2, … }

  await buffer.clear();
}

void main();
