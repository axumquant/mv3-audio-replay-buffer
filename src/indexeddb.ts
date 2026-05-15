/**
 * Thin IndexedDB wrapper for the replay buffer.
 *
 * Owns the database handle, schema upgrade, and the basic CRUD primitives
 * used by `AudioReplayBuffer`. No business logic lives here — TTL/cap/ack
 * decisions belong to `buffer.ts`.
 */

/**
 * A stored, encrypted frame row.
 *
 * `iv` is the 12-byte AES-GCM nonce as a plain number array (so IndexedDB
 * structured clone is happy). `ciphertext` holds the encrypted payload from
 * `crypto.subtle.encrypt`. When `encrypt: false`, `iv` is `[]` and `ciphertext`
 * is a UTF-8 encoded JSON ArrayBuffer.
 *
 * `meta` is plaintext frame metadata — codec, sample_rate, etc. — kept
 * outside the ciphertext so the buffer can sort and trim without decrypting.
 */
export interface StoredFrameRow {
  seq: number;
  ts: number;
  meta: {
    seq: number;
    ts: number;
    codec: string;
    sample_rate: number;
    capture_mode: string;
    speaker: string;
    call_id: string | null;
  };
  iv: number[];
  ciphertext: ArrayBuffer;
}

/**
 * Row stored in the key store. We persist the CryptoKey as a non-extractable
 * handle — IndexedDB's structured clone is allowed to round-trip
 * `CryptoKey` objects on browsers that implement HTML structured-clone
 * for them (Chrome/Firefox/Edge do).
 */
export interface StoredKeyRow {
  id: string;
  key: CryptoKey;
  created_at: number;
}

/**
 * Configuration the store needs to open the DB. Mirrors the subset of
 * `AudioReplayBufferOptions` that touches IndexedDB.
 */
export interface StoreConfig {
  dbName: string;
  dbVersion: number;
  frameStoreName: string;
  keyStoreName: string;
}

export class IndexedDbStore {
  private readonly cfg: StoreConfig;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(cfg: StoreConfig) {
    this.cfg = cfg;
  }

  /** Opens (or returns the cached handle to) the IndexedDB database. */
  open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.cfg.dbName, this.cfg.dbVersion);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.cfg.frameStoreName)) {
          const store = db.createObjectStore(this.cfg.frameStoreName, {
            keyPath: "seq",
          });
          store.createIndex("ts", "ts", { unique: false });
        }
        if (!db.objectStoreNames.contains(this.cfg.keyStoreName)) {
          db.createObjectStore(this.cfg.keyStoreName, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error ?? new Error("IndexedDB open failed"));
      req.onblocked = () =>
        reject(
          new Error(
            `IndexedDB open blocked — another connection holds DB "${this.cfg.dbName}" at a lower version`,
          ),
        );
    });
    return this.dbPromise;
  }

  /** Resets the cached promise — call after `clear()` or test teardown. */
  reset(): void {
    this.dbPromise = null;
  }

  /** Returns a promise that resolves when the transaction completes. */
  private txDone(tx: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () =>
        reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  /** Fetch every row in the frame store. */
  async getAllFrames(): Promise<StoredFrameRow[]> {
    const db = await this.open();
    return new Promise<StoredFrameRow[]>((resolve, reject) => {
      const tx = db.transaction(this.cfg.frameStoreName, "readonly");
      const req = tx.objectStore(this.cfg.frameStoreName).getAll();
      req.onsuccess = () =>
        resolve(Array.isArray(req.result) ? (req.result as StoredFrameRow[]) : []);
      req.onerror = () =>
        reject(req.error ?? new Error("IndexedDB read failed"));
    });
  }

  /** Insert/replace a single frame row keyed by `seq`. */
  async putFrame(row: StoredFrameRow): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(this.cfg.frameStoreName, "readwrite");
    tx.objectStore(this.cfg.frameStoreName).put(row);
    await this.txDone(tx);
  }

  /** Delete a set of frame rows by their `seq` keys. */
  async deleteFrameSeqs(seqs: number[]): Promise<void> {
    if (!seqs.length) return;
    const db = await this.open();
    const tx = db.transaction(this.cfg.frameStoreName, "readwrite");
    const store = tx.objectStore(this.cfg.frameStoreName);
    for (const seq of seqs) store.delete(seq);
    await this.txDone(tx);
  }

  /** Read the stored CryptoKey row for `keyId`, if any. */
  async getKeyRow(keyId: string): Promise<StoredKeyRow | null> {
    const db = await this.open();
    return new Promise<StoredKeyRow | null>((resolve, reject) => {
      const tx = db.transaction(this.cfg.keyStoreName, "readonly");
      const req = tx.objectStore(this.cfg.keyStoreName).get(keyId);
      req.onsuccess = () =>
        resolve((req.result as StoredKeyRow | undefined) ?? null);
      req.onerror = () =>
        reject(req.error ?? new Error("IndexedDB key read failed"));
    });
  }

  /** Persist a CryptoKey under `keyId`. */
  async putKeyRow(row: StoredKeyRow): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(this.cfg.keyStoreName, "readwrite");
    tx.objectStore(this.cfg.keyStoreName).put(row);
    await this.txDone(tx);
  }

  /** Delete a stored CryptoKey. Used during `rotate()` and `clear()`. */
  async deleteKey(keyId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(this.cfg.keyStoreName, "readwrite");
    tx.objectStore(this.cfg.keyStoreName).delete(keyId);
    await this.txDone(tx);
  }

  /** Clear both stores in a single transaction. */
  async clearAll(keyId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(
      [this.cfg.frameStoreName, this.cfg.keyStoreName],
      "readwrite",
    );
    tx.objectStore(this.cfg.frameStoreName).clear();
    tx.objectStore(this.cfg.keyStoreName).delete(keyId);
    await this.txDone(tx);
  }
}
