/**
 * AES-GCM payload encryption for the replay buffer.
 *
 * - Key generation: non-extractable AES-GCM-256.
 * - Persistence: stored in IndexedDB via structured clone (browsers that
 *   support cloning of CryptoKey objects, including Chrome).
 * - IV: fresh 12-byte random nonce per frame (NIST-recommended size).
 *
 * Decoupled from `IndexedDbStore` — accepts the store at construction so
 * tests can stub it. No dependency on `chrome.*` or extension APIs.
 */

import type { IndexedDbStore } from "./indexeddb.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Payload shape stored as ciphertext. Wrapping in `{data}` rather than
 * encrypting the raw string lets us add fields later without breaking
 * forward-compat.
 */
interface EncryptedPayload {
  data: string;
}

/** Wire format produced by `encryptPayload`. */
export interface EncryptedRecord {
  iv: number[];
  ciphertext: ArrayBuffer;
}

export class FrameCrypto {
  private readonly store: IndexedDbStore;
  private readonly keyId: string;
  private readonly enabled: boolean;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(opts: {
    store: IndexedDbStore;
    keyId: string;
    enabled: boolean;
  }) {
    this.store = opts.store;
    this.keyId = opts.keyId;
    this.enabled = opts.enabled;
  }

  /** True if encryption is on for this buffer instance. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get (or generate-and-persist) the AES-GCM key for this buffer instance.
   * Idempotent — concurrent callers share the same in-flight promise.
   */
  async getKey(): Promise<CryptoKey> {
    if (!this.enabled) {
      throw new Error("FrameCrypto.getKey called with encryption disabled");
    }
    if (this.keyPromise) return this.keyPromise;
    this.keyPromise = (async () => {
      const existing = await this.store.getKeyRow(this.keyId);
      if (existing?.key) return existing.key;
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        // `extractable: false` — the key never leaves the browser as bytes.
        false,
        ["encrypt", "decrypt"],
      );
      await this.store.putKeyRow({
        id: this.keyId,
        key,
        created_at: Date.now(),
      });
      return key;
    })();
    return this.keyPromise;
  }

  /**
   * Rotate the key — deletes the stored key. Any existing ciphertext written
   * with the old key will fail to decrypt (you should also `clear()` the
   * frame store after rotation; the high-level `AudioReplayBuffer.rotateKey`
   * does both).
   */
  async rotate(): Promise<void> {
    this.keyPromise = null;
    await this.store.deleteKey(this.keyId);
  }

  /**
   * Encrypt the audio payload. When encryption is disabled, returns a record
   * with empty IV and a UTF-8 JSON ArrayBuffer in `ciphertext` so the wire
   * shape stays the same.
   */
  async encrypt(data: string): Promise<EncryptedRecord> {
    const payload: EncryptedPayload = { data };
    const plaintext = textEncoder.encode(JSON.stringify(payload));
    if (!this.enabled) {
      // Make a fresh ArrayBuffer copy — TypedArray.buffer can be a SharedArrayBuffer
      // or a slice of a larger buffer; we want a clean, owned ArrayBuffer for IDB.
      const buf = new ArrayBuffer(plaintext.byteLength);
      new Uint8Array(buf).set(plaintext);
      return { iv: [], ciphertext: buf };
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.getKey();
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plaintext,
    );
    return { iv: Array.from(iv), ciphertext };
  }

  /**
   * Decrypt a stored record. Returns `null` on failure (wrong key, tampered
   * ciphertext, malformed JSON) so the buffer can skip the row gracefully.
   */
  async decrypt(record: {
    iv: number[];
    ciphertext: ArrayBuffer;
  }): Promise<{ data: string } | null> {
    try {
      let plaintext: ArrayBuffer;
      if (!this.enabled) {
        plaintext = record.ciphertext;
      } else {
        const key = await this.getKey();
        plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: new Uint8Array(record.iv ?? []) },
          key,
          record.ciphertext,
        );
      }
      const parsed = JSON.parse(textDecoder.decode(plaintext)) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "data" in parsed &&
        typeof (parsed as { data: unknown }).data === "string"
      ) {
        return { data: (parsed as { data: string }).data };
      }
      return null;
    } catch {
      return null;
    }
  }
}
