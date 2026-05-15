/**
 * Vitest global setup — installs `fake-indexeddb` and ensures a structured-
 * clone-able `crypto.subtle` is present on the global. Node 18+ already
 * exposes `globalThis.crypto`, but we belt-and-suspender it here so the
 * tests are robust on older minor versions.
 */

import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}
