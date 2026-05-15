/**
 * AudioReplayBuffer — durable, encrypted, ack-trimmed audio replay buffer for
 * MV3 service workers and offscreen documents.
 *
 * Decoupling: this class has zero dependency on `chrome.*` APIs or any
 * specific transport. The producer calls `rememberFrame(frame)` whenever a
 * chunk lands, and on reconnect calls `replay(callback, reason)` — the
 * callback is what wires frames to your real transport (a WebSocket send,
 * `chrome.runtime.sendMessage`, Deepgram client, etc.).
 */

import { IndexedDbStore, type StoredFrameRow } from "./indexeddb.js";
import { FrameCrypto } from "./crypto.js";
import type {
  AudioFrame,
  AudioReplayBufferOptions,
  BufferStatus,
  ForwardCallback,
  RememberedFrame,
  ReplayResult,
  ReplayedFrame,
} from "./types.js";

/** Defaults match the production behavior extracted from sales-coach. */
const DEFAULTS = {
  dbName: "mv3_audio_replay_v1",
  dbVersion: 1,
  frameStoreName: "frames",
  keyStoreName: "keys",
  keyId: "session-audio-buffer",
  ttlMs: 60_000,
  maxFrames: 240,
  chunkMs: 250,
  encrypt: true,
} as const;

export class AudioReplayBuffer {
  private readonly store: IndexedDbStore;
  private readonly crypto: FrameCrypto;
  private readonly ttlMs: number;
  private readonly maxFrames: number;
  private readonly chunkMs: number;
  private readonly keyId: string;

  /** Highest seq ever assigned by this instance (or seen on init replay). */
  private nextSeq = 0;
  /** Last acknowledged seq — cleanup drops frames at or below this. */
  private lastAckSeq = 0;
  /** Set once `init()` has hydrated state from disk. */
  private initialized = false;

  constructor(options: AudioReplayBufferOptions = {}) {
    const cfg = { ...DEFAULTS, ...options };
    this.ttlMs = cfg.ttlMs;
    this.maxFrames = cfg.maxFrames;
    this.chunkMs = cfg.chunkMs;
    this.keyId = cfg.keyId;
    this.store = new IndexedDbStore({
      dbName: cfg.dbName,
      dbVersion: cfg.dbVersion,
      frameStoreName: cfg.frameStoreName,
      keyStoreName: cfg.keyStoreName,
    });
    this.crypto = new FrameCrypto({
      store: this.store,
      keyId: cfg.keyId,
      enabled: cfg.encrypt,
    });
  }

  /**
   * Open the IndexedDB and hydrate `nextSeq` from any persisted frames.
   * Safe to call repeatedly. Must be called (or implicitly awaited via any
   * other method) before frames are written.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.open();
    const rows = await this.store.getAllFrames();
    for (const row of rows) {
      const seq = Number(row.seq ?? 0);
      if (Number.isFinite(seq) && seq > this.nextSeq) {
        this.nextSeq = seq;
      }
    }
    this.initialized = true;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.init();
  }

  /**
   * Drop rows that are TTL-expired or already acknowledged, then trim oldest
   * frames if we're over `maxFrames`. Idempotent — called before every
   * public op that needs an accurate view.
   */
  private async cleanup(): Promise<void> {
    const rows = await this.store.getAllFrames();
    const cutoff = Date.now() - this.ttlMs;
    const expired = rows
      .filter(
        (row) =>
          Number(row.seq ?? 0) <= this.lastAckSeq ||
          Number(row.ts ?? 0) < cutoff,
      )
      .map((row) => row.seq);
    const expiredSet = new Set(expired);
    const liveRows = rows
      .filter((row) => !expiredSet.has(row.seq))
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
    const overflow =
      liveRows.length > this.maxFrames
        ? liveRows
            .slice(0, liveRows.length - this.maxFrames)
            .map((row) => row.seq)
        : [];
    await this.store.deleteFrameSeqs([...expired, ...overflow]);
  }

  /** Current buffer status snapshot. */
  async status(): Promise<BufferStatus> {
    await this.ensureInit();
    await this.cleanup();
    const pending = (await this.store.getAllFrames())
      .filter((row) => Number(row.seq ?? 0) > this.lastAckSeq)
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
    return {
      buffered_frames: pending.length,
      buffered_ms: pending.length * this.chunkMs,
      audio_seq: this.nextSeq,
      last_ack_seq: this.lastAckSeq,
      ttl_ms: this.ttlMs,
      max_frames: this.maxFrames,
    };
  }

  /**
   * Persist a frame. Assigns `seq = nextSeq + 1` if the caller didn't supply
   * one. Returns the canonicalized metadata + payload + current status so
   * the caller can forward it on the live wire without re-reading.
   */
  async rememberFrame(frame: AudioFrame): Promise<RememberedFrame> {
    await this.ensureInit();
    await this.cleanup();

    const requestedSeq = Number(frame.seq ?? 0);
    const seq = requestedSeq > 0 ? requestedSeq : this.nextSeq + 1;
    this.nextSeq = Math.max(this.nextSeq, seq);

    const requestedTs = Number(frame.ts ?? 0);
    const ts = requestedTs > 0 ? requestedTs : Date.now();

    const meta = {
      seq,
      ts,
      codec: frame.codec ?? "webm-opus",
      sample_rate: frame.sample_rate ?? 16000,
      capture_mode: frame.capture_mode ?? "",
      speaker: frame.speaker ?? "",
      call_id: frame.call_id ?? null,
    };
    const encrypted = await this.crypto.encrypt(frame.data ?? "");
    const row: StoredFrameRow = {
      seq,
      ts,
      meta,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
    };
    await this.store.putFrame(row);
    const current = await this.status();
    return {
      ...meta,
      data: frame.data ?? "",
      ...current,
    };
  }

  /**
   * Mark every frame with `seq <= ackSeq` as ack'd. Cleanup will trim them
   * on the next op. Idempotent; ignores non-positive / non-finite input.
   */
  async acknowledge(ackSeq: number): Promise<BufferStatus> {
    await this.ensureInit();
    const parsed = Number(ackSeq ?? 0);
    if (Number.isFinite(parsed) && parsed > 0) {
      this.lastAckSeq = Math.max(this.lastAckSeq, parsed);
    }
    return this.status();
  }

  /**
   * Replay every still-buffered (unacked, unexpired) frame to `forward`, in
   * ascending seq order. Each frame is decrypted, tagged with `replay:true`
   * and `replay_reason`, then handed to the callback. The callback may be
   * async — replay awaits each call so the consumer can rate-limit.
   *
   * Frames that fail decryption are skipped (logged-by-omission). The
   * remaining buffered frames stay on disk until ack'd — replay does NOT
   * trim. The caller controls the ack lifecycle.
   */
  async replay(
    forward: ForwardCallback,
    reason: string = "reconnect",
  ): Promise<ReplayResult> {
    await this.ensureInit();
    await this.cleanup();
    const rows = (await this.store.getAllFrames())
      .filter((row) => Number(row.seq ?? 0) > this.lastAckSeq)
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
    let replayed = 0;
    for (const row of rows) {
      const payload = await this.crypto.decrypt({
        iv: row.iv,
        ciphertext: row.ciphertext,
      });
      if (!payload?.data) continue;
      const meta = row.meta;
      const frame: ReplayedFrame = {
        seq: meta.seq,
        ts: meta.ts,
        codec: meta.codec,
        sample_rate: meta.sample_rate,
        capture_mode: meta.capture_mode,
        speaker: meta.speaker,
        call_id: meta.call_id,
        data: payload.data,
        replay: true,
        replay_reason: reason,
      };
      await forward(frame);
      replayed += 1;
    }
    const status = await this.status();
    return { ...status, replayed_frames: replayed };
  }

  /**
   * Drop all stored frames AND the AES key. Use on session end / sign-out.
   * After `clear()`, the next `rememberFrame` lazily regenerates a key.
   */
  async clear(): Promise<BufferStatus> {
    await this.ensureInit();
    await this.store.clearAll(this.keyId);
    await this.crypto.rotate(); // reset cached keyPromise
    this.nextSeq = 0;
    this.lastAckSeq = 0;
    return this.status();
  }

  /**
   * Rotate the encryption key. Wipes the frame store (existing ciphertext
   * would be unreadable) and forces a fresh key on the next write.
   */
  async rotateKey(): Promise<BufferStatus> {
    await this.ensureInit();
    await this.store.clearAll(this.keyId);
    await this.crypto.rotate();
    this.nextSeq = 0;
    this.lastAckSeq = 0;
    return this.status();
  }
}
