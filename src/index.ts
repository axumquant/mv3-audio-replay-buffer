/**
 * Public entry point for `@axumquant/mv3-audio-replay-buffer`.
 *
 * The main class is `AudioReplayBuffer`. The `IndexedDbStore` and
 * `FrameCrypto` lower-level pieces are also exported in case advanced
 * consumers want to compose them differently.
 */

export { AudioReplayBuffer } from "./buffer.js";
export { FrameCrypto } from "./crypto.js";
export { IndexedDbStore } from "./indexeddb.js";

export type {
  AudioFrame,
  AudioReplayBufferOptions,
  BufferStatus,
  ForwardCallback,
  RememberedFrame,
  ReplayResult,
  ReplayedFrame,
} from "./types.js";

export type { EncryptedRecord } from "./crypto.js";
export type {
  StoredFrameRow,
  StoredKeyRow,
  StoreConfig,
} from "./indexeddb.js";
