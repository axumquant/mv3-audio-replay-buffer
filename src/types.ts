/**
 * Public types for the MV3 Audio Replay Buffer.
 */

/**
 * An audio frame submitted by the producer.
 *
 * `data` is the opaque audio payload — typically a base64-encoded chunk from
 * `MediaRecorder.ondataavailable`. The library never inspects it; it just
 * encrypts and stores. Whatever string you put in is what your forward
 * callback gets back on replay.
 */
export interface AudioFrame {
  /** Opaque audio payload — usually base64 of a MediaRecorder chunk. */
  data: string;
  /** Monotonic per-call sequence. If omitted/<=0, the buffer auto-assigns nextSeq+1. */
  seq?: number;
  /** Capture timestamp (ms since epoch). Defaults to Date.now() if omitted. */
  ts?: number;
  /** Codec identifier, e.g. "webm-opus" or "audio/webm;codecs=opus". */
  codec?: string;
  /** Audio sample rate in Hz. */
  sample_rate?: number;
  /** Capture mode label — caller-defined, e.g. "tab", "mic", "tab+mic". */
  capture_mode?: string;
  /** Speaker label — caller-defined, e.g. "agent", "customer". */
  speaker?: string;
  /** Optional call/session identifier — opaque to the buffer. */
  call_id?: string | null;
}

/**
 * Status snapshot returned by `status()`, `rememberFrame()`, `acknowledge()`, etc.
 */
export interface BufferStatus {
  /** Number of unacked frames currently buffered (after TTL/cap eviction). */
  buffered_frames: number;
  /** Approximate buffered audio duration in ms = buffered_frames * chunkMs. */
  buffered_ms: number;
  /** Highest seq number ever assigned (whether still buffered or evicted). */
  audio_seq: number;
  /** Last acknowledged seq (frames at or below this are trimmed on cleanup). */
  last_ack_seq: number;
  /** Configured TTL in ms. */
  ttl_ms: number;
  /** Configured max frame cap. */
  max_frames: number;
}

/**
 * Result of `replay()` — status plus the count of frames forwarded.
 */
export interface ReplayResult extends BufferStatus {
  /** Number of frames that were decrypted and forwarded to the callback. */
  replayed_frames: number;
}

/**
 * Shape of a frame as delivered to your forward callback during replay.
 *
 * Note: the `replay` flag and `replay_reason` are added by the buffer so your
 * consumer (e.g. backend WS) can distinguish backfill from live.
 */
export interface ReplayedFrame {
  data: string;
  seq: number;
  ts: number;
  codec: string;
  sample_rate: number;
  capture_mode: string;
  speaker: string;
  call_id: string | null;
  /** Always `true` for frames delivered via replay. */
  replay: true;
  /** The `reason` string you passed to `replay()` (or "reconnect"). */
  replay_reason: string;
}

/**
 * Callback invoked once per replayed frame. May be async; replay awaits each call.
 */
export type ForwardCallback = (frame: ReplayedFrame) => void | Promise<void>;

/**
 * Frame envelope returned by `rememberFrame()` — the original metadata plus
 * the current buffer status. Intended for callers that want to forward live
 * frames with status piggybacked in the same message.
 */
export interface RememberedFrame extends BufferStatus {
  seq: number;
  ts: number;
  codec: string;
  sample_rate: number;
  capture_mode: string;
  speaker: string;
  call_id: string | null;
  data: string;
}

/**
 * Constructor options for `AudioReplayBuffer`.
 *
 * All fields are optional — sensible defaults match the production behavior
 * from sales-coach (60s TTL, 240 frames, 250ms chunks).
 */
export interface AudioReplayBufferOptions {
  /**
   * IndexedDB database name. Use a distinct name per app/site to avoid
   * collisions when multiple extensions share an origin.
   *
   * @default "mv3_audio_replay_v1"
   */
  dbName?: string;
  /**
   * IndexedDB schema version. Bump when you change `frameStoreName` /
   * `keyStoreName` between releases.
   *
   * @default 1
   */
  dbVersion?: number;
  /**
   * Object store name for encrypted audio rows.
   *
   * @default "frames"
   */
  frameStoreName?: string;
  /**
   * Object store name for the persisted AES-GCM CryptoKey.
   *
   * @default "keys"
   */
  keyStoreName?: string;
  /**
   * Key ID within `keyStoreName` — distinguishes multiple keys if you ever
   * key-per-session.
   *
   * @default "session-audio-buffer"
   */
  keyId?: string;
  /**
   * How long an unacked frame may live before TTL eviction.
   *
   * @default 60_000  // 60 seconds
   */
  ttlMs?: number;
  /**
   * Hard cap on buffered (unacked, unexpired) frames. When exceeded, oldest
   * seqs are evicted first.
   *
   * @default 240  // 60s @ 250ms/chunk
   */
  maxFrames?: number;
  /**
   * Approximate chunk duration in ms — only used to compute `buffered_ms` for
   * status reporting. Does NOT control eviction; it's metadata.
   *
   * @default 250
   */
  chunkMs?: number;
  /**
   * Whether to encrypt frame data at rest. Set `false` for tests/debugging.
   * In production, leave this `true`.
   *
   * @default true
   */
  encrypt?: boolean;
}
