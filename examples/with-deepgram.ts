/**
 * End-to-end example — `AudioReplayBuffer` driving a mock streaming consumer
 * modeled on Deepgram's live STT WebSocket.
 *
 * Pattern:
 *  1. MediaRecorder.ondataavailable → `buffer.rememberFrame()` → forward live
 *     via the consumer's `send()`.
 *  2. Consumer receives ack messages and calls `buffer.acknowledge(seq)`.
 *  3. On `socket.onclose`, reconnect and call `buffer.replay()` with the
 *     new socket's send function. Acked frames are skipped; un-acked frames
 *     stream in order to backfill.
 *
 * The `DeepgramLikeClient` below is a stand-in — swap it for the real SDK.
 */

import { AudioReplayBuffer, type ReplayedFrame } from "@axumquant/mv3-audio-replay-buffer";

interface OutgoingFrame {
  type: "audio_frame";
  seq: number;
  ts: number;
  data: string;
  replay: boolean;
  replay_reason?: string;
}

class DeepgramLikeClient {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private readonly onAck: (seq: number) => void;
  private readonly onClose: () => void;

  constructor(opts: {
    url: string;
    onAck: (seq: number) => void;
    onClose: () => void;
  }) {
    this.url = opts.url;
    this.onAck = opts.onAck;
    this.onClose = opts.onClose;
  }

  async connect(): Promise<void> {
    this.socket = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.socket!.onopen = () => resolve();
      this.socket!.onerror = (e) => reject(e);
    });
    this.socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          seq?: number;
        };
        if (msg.type === "ack" && typeof msg.seq === "number") {
          this.onAck(msg.seq);
        }
      } catch {
        // Ignore non-JSON / transcript-only frames.
      }
    };
    this.socket.onclose = () => this.onClose();
  }

  send(frame: OutgoingFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Deepgram socket not open");
    }
    this.socket.send(JSON.stringify(frame));
  }
}

async function run(): Promise<void> {
  const buffer = new AudioReplayBuffer({
    dbName: "deepgram-replay",
    ttlMs: 60_000,
    maxFrames: 240,
  });
  await buffer.init();

  let client: DeepgramLikeClient | null = null;

  const handleAck = (seq: number) => {
    void buffer.acknowledge(seq);
  };

  const handleClose = () => {
    // Reconnect with exponential backoff in a real app. Once the new socket
    // opens, replay un-acked frames before resuming live forwarding.
    setTimeout(() => {
      void (async () => {
        client = new DeepgramLikeClient({
          url: "wss://api.example.com/deepgram",
          onAck: handleAck,
          onClose: handleClose,
        });
        await client.connect();
        await buffer.replay(async (frame: ReplayedFrame) => {
          client!.send({
            type: "audio_frame",
            seq: frame.seq,
            ts: frame.ts,
            data: frame.data,
            replay: true,
            replay_reason: frame.replay_reason,
          });
        }, "ws_reconnect");
      })();
    }, 1_000);
  };

  client = new DeepgramLikeClient({
    url: "wss://api.example.com/deepgram",
    onAck: handleAck,
    onClose: handleClose,
  });
  await client.connect();

  // Wire MediaRecorder elsewhere; here's the per-chunk handler.
  async function onChunk(chunk: { base64: string; ts: number }): Promise<void> {
    const remembered = await buffer.rememberFrame({
      data: chunk.base64,
      ts: chunk.ts,
      codec: "audio/webm;codecs=opus",
      sample_rate: 16000,
      capture_mode: "tab",
      speaker: "agent",
    });
    client!.send({
      type: "audio_frame",
      seq: remembered.seq,
      ts: remembered.ts,
      data: remembered.data,
      replay: false,
    });
  }

  // Demo: push one fake chunk so the example is self-contained.
  await onChunk({ base64: btoa("hello"), ts: Date.now() });
}

void run();
