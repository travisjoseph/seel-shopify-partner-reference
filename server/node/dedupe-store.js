"use strict";

/**
 * Dedupe store interface: { has(key) -> boolean, add(key) -> void }.
 * Both may also return a Promise, so a durable store (Redis SET NX, a
 * database unique index) drops in without changing the handlers.
 *
 * This default lives in process memory: it forgets everything on restart
 * and is not shared between instances. Replace it in production.
 */
function createMemoryDedupeStore(maxKeys = 10000) {
  const keys = new Set();
  return {
    has(key) {
      return keys.has(key);
    },
    add(key) {
      if (keys.has(key)) return;
      keys.add(key);
      // A Set iterates in insertion order, so the first key is the oldest.
      if (keys.size > maxKeys) keys.delete(keys.values().next().value);
    },
  };
}

module.exports = { createMemoryDedupeStore };
