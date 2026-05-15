import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrameCrypto } from "../src/crypto.js";
import { IndexedDbStore } from "../src/indexeddb.js";

let counter = 0;
function freshStore(): IndexedDbStore {
  counter += 1;
  return new IndexedDbStore({
    dbName: `test-crypto-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    dbVersion: 1,
    frameStoreName: "frames",
    keyStoreName: "keys",
  });
}

describe("FrameCrypto", () => {
  let store: IndexedDbStore;

  beforeEach(async () => {
    store = freshStore();
    await store.open();
  });

  afterEach(() => {
    store.reset();
  });

  it("encrypts and decrypts roundtrip with the same key", async () => {
    const c = new FrameCrypto({
      store,
      keyId: "test-key",
      enabled: true,
    });
    const record = await c.encrypt("hello world");
    expect(record.iv).toHaveLength(12);
    expect(record.ciphertext.byteLength).toBeGreaterThan(0);

    const decrypted = await c.decrypt(record);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.data).toBe("hello world");
  });

  it("produces a fresh IV per encryption (probabilistic check)", async () => {
    const c = new FrameCrypto({ store, keyId: "iv-key", enabled: true });
    const a = await c.encrypt("same plaintext");
    const b = await c.encrypt("same plaintext");
    expect(a.iv).not.toEqual(b.iv);
    // Different IV → different ciphertext bytes too.
    const aBytes = new Uint8Array(a.ciphertext);
    const bBytes = new Uint8Array(b.ciphertext);
    expect(aBytes).not.toEqual(bBytes);
  });

  it("returns null when decrypting with the wrong key", async () => {
    const writer = new FrameCrypto({ store, keyId: "writer", enabled: true });
    const record = await writer.encrypt("secret");

    // Different keyId → different generated AES key.
    const reader = new FrameCrypto({ store, keyId: "reader", enabled: true });
    const decrypted = await reader.decrypt(record);
    expect(decrypted).toBeNull();
  });

  it("returns null on tampered ciphertext", async () => {
    const c = new FrameCrypto({ store, keyId: "tamper-key", enabled: true });
    const record = await c.encrypt("don't touch this");
    const bytes = new Uint8Array(record.ciphertext.slice(0));
    // Flip the last byte of the AES-GCM auth tag → AEAD verification fails.
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
    const result = await c.decrypt({
      iv: record.iv,
      ciphertext: bytes.buffer,
    });
    expect(result).toBeNull();
  });

  it("persists the key across FrameCrypto instances", async () => {
    const first = new FrameCrypto({
      store,
      keyId: "persist-key",
      enabled: true,
    });
    const record = await first.encrypt("durable");
    // Second instance over the SAME store should pick up the persisted key.
    const second = new FrameCrypto({
      store,
      keyId: "persist-key",
      enabled: true,
    });
    const decrypted = await second.decrypt(record);
    expect(decrypted?.data).toBe("durable");
  });

  it("rotate() deletes the key so subsequent decrypts fail", async () => {
    const c = new FrameCrypto({ store, keyId: "rotate-key", enabled: true });
    const record = await c.encrypt("pre-rotation");
    await c.rotate();
    // After rotate() a fresh key is generated on next encrypt; decrypt with
    // the new key fails the old ciphertext.
    const decrypted = await c.decrypt(record);
    expect(decrypted).toBeNull();
  });

  it("works in plaintext mode when encrypt: false", async () => {
    const c = new FrameCrypto({
      store,
      keyId: "plain-key",
      enabled: false,
    });
    const record = await c.encrypt("plain text");
    expect(record.iv).toEqual([]);
    const decrypted = await c.decrypt(record);
    expect(decrypted?.data).toBe("plain text");
  });
});
