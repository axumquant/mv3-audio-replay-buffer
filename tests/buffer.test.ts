import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioReplayBuffer } from "../src/index.js";
import type { ReplayedFrame } from "../src/types.js";

// Each test gets a fresh DB to keep them isolated.
let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `test-buffer-${dbCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("AudioReplayBuffer", () => {
  let buffer: AudioReplayBuffer;

  beforeEach(async () => {
    buffer = new AudioReplayBuffer({
      dbName: freshDbName(),
      ttlMs: 60_000,
      maxFrames: 240,
    });
    await buffer.init();
  });

  afterEach(async () => {
    await buffer.clear();
  });

  it("hydrates a fresh buffer with empty status", async () => {
    const status = await buffer.status();
    expect(status.buffered_frames).toBe(0);
    expect(status.audio_seq).toBe(0);
    expect(status.last_ack_seq).toBe(0);
    expect(status.ttl_ms).toBe(60_000);
    expect(status.max_frames).toBe(240);
  });

  it("put 10 frames, ack seq 5, status reports 5 remaining", async () => {
    for (let i = 1; i <= 10; i += 1) {
      await buffer.rememberFrame({
        data: `frame-${i}`,
        seq: i,
        ts: Date.now(),
      });
    }
    const beforeAck = await buffer.status();
    expect(beforeAck.buffered_frames).toBe(10);
    expect(beforeAck.audio_seq).toBe(10);

    const afterAck = await buffer.acknowledge(5);
    expect(afterAck.buffered_frames).toBe(5);
    expect(afterAck.last_ack_seq).toBe(5);
    expect(afterAck.audio_seq).toBe(10);
  });

  it("replay calls the callback once per buffered frame in seq order", async () => {
    for (let i = 1; i <= 7; i += 1) {
      await buffer.rememberFrame({
        data: `payload-${i}`,
        seq: i,
        ts: Date.now(),
      });
    }
    await buffer.acknowledge(2);

    const received: ReplayedFrame[] = [];
    const result = await buffer.replay(async (frame) => {
      received.push(frame);
    }, "test_replay");

    expect(result.replayed_frames).toBe(5);
    expect(received.map((f) => f.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(received.every((f) => f.replay === true)).toBe(true);
    expect(received.every((f) => f.replay_reason === "test_replay")).toBe(true);
    expect(received[0]!.data).toBe("payload-3");
  });

  it("auto-assigns seq when caller omits it", async () => {
    const a = await buffer.rememberFrame({ data: "a" });
    const b = await buffer.rememberFrame({ data: "b" });
    const c = await buffer.rememberFrame({ data: "c" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(3);
    expect(c.audio_seq).toBe(3);
  });

  it("evicts oldest frames when maxFrames is exceeded", async () => {
    const tiny = new AudioReplayBuffer({
      dbName: freshDbName(),
      ttlMs: 60_000,
      maxFrames: 3,
    });
    await tiny.init();
    for (let i = 1; i <= 5; i += 1) {
      await tiny.rememberFrame({ data: `f${i}`, seq: i, ts: Date.now() });
    }
    const status = await tiny.status();
    // After eviction we keep the 3 most recent: seqs 3, 4, 5.
    expect(status.buffered_frames).toBe(3);
    const received: number[] = [];
    await tiny.replay(async (frame) => {
      received.push(frame.seq);
    });
    expect(received).toEqual([3, 4, 5]);
    await tiny.clear();
  });

  it("evicts TTL-expired frames", async () => {
    const ttlBuf = new AudioReplayBuffer({
      dbName: freshDbName(),
      ttlMs: 1_000,
      maxFrames: 240,
    });
    await ttlBuf.init();
    // Backdated ts → already expired against a 1s TTL.
    await ttlBuf.rememberFrame({
      data: "old",
      seq: 1,
      ts: Date.now() - 10_000,
    });
    await ttlBuf.rememberFrame({ data: "new", seq: 2, ts: Date.now() });
    const status = await ttlBuf.status();
    expect(status.buffered_frames).toBe(1);
    await ttlBuf.clear();
  });

  it("acknowledge is idempotent and monotonic", async () => {
    for (let i = 1; i <= 5; i += 1) {
      await buffer.rememberFrame({ data: `f${i}`, seq: i, ts: Date.now() });
    }
    await buffer.acknowledge(3);
    // Lower ack must NOT regress lastAckSeq.
    const status = await buffer.acknowledge(1);
    expect(status.last_ack_seq).toBe(3);
    expect(status.buffered_frames).toBe(2);
  });

  it("replay leaves frames on disk for re-replay until ack'd", async () => {
    for (let i = 1; i <= 3; i += 1) {
      await buffer.rememberFrame({ data: `f${i}`, seq: i, ts: Date.now() });
    }
    const first = await buffer.replay(async () => {});
    expect(first.replayed_frames).toBe(3);
    const second = await buffer.replay(async () => {});
    expect(second.replayed_frames).toBe(3);
    await buffer.acknowledge(3);
    const third = await buffer.replay(async () => {});
    expect(third.replayed_frames).toBe(0);
  });

  it("buffered_ms = buffered_frames * chunkMs", async () => {
    const buf = new AudioReplayBuffer({
      dbName: freshDbName(),
      chunkMs: 100,
    });
    await buf.init();
    for (let i = 1; i <= 4; i += 1) {
      await buf.rememberFrame({ data: `f${i}`, seq: i, ts: Date.now() });
    }
    const status = await buf.status();
    expect(status.buffered_ms).toBe(400);
    await buf.clear();
  });

  it("clear wipes frames and resets sequence counters", async () => {
    for (let i = 1; i <= 4; i += 1) {
      await buffer.rememberFrame({ data: `f${i}`, seq: i, ts: Date.now() });
    }
    const cleared = await buffer.clear();
    expect(cleared.buffered_frames).toBe(0);
    expect(cleared.audio_seq).toBe(0);
    expect(cleared.last_ack_seq).toBe(0);
  });

  it("works with encrypt: false (plain wire format roundtrip)", async () => {
    const plain = new AudioReplayBuffer({
      dbName: freshDbName(),
      encrypt: false,
    });
    await plain.init();
    await plain.rememberFrame({ data: "hello-plain", seq: 1, ts: Date.now() });
    const received: string[] = [];
    await plain.replay(async (frame) => {
      received.push(frame.data);
    });
    expect(received).toEqual(["hello-plain"]);
    await plain.clear();
  });
});
