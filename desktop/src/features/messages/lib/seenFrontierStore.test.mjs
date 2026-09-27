import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  isAfterFrontier,
  MAX_SEEN_FRONTIERS,
  readSeenFrontier,
  writeSeenFrontier,
} from "./seenFrontierStore.ts";

function installStorage() {
  const items = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (items.has(key) ? items.get(key) : null),
      setItem: (key, value) => items.set(key, String(value)),
      removeItem: (key) => items.delete(key),
    },
  };
  return items;
}

beforeEach(() => {
  installStorage();
});

test("orders by time, then id", () => {
  assert.equal(
    isAfterFrontier({ createdAt: 2, id: "a" }, { createdAt: 1, id: "z" }),
    true,
  );
  assert.equal(
    isAfterFrontier({ createdAt: 1, id: "b" }, { createdAt: 1, id: "a" }),
    true,
  );
  assert.equal(
    isAfterFrontier({ createdAt: 1, id: "a" }, { createdAt: 1, id: "a" }),
    false,
  );
  assert.equal(
    isAfterFrontier({ createdAt: 1, id: "z" }, { createdAt: 2, id: "a" }),
    false,
  );
});

test("remembers the frontier per channel", () => {
  writeSeenFrontier("one", { createdAt: 5, id: "e" });
  writeSeenFrontier("two", { createdAt: 7, id: "g" });
  assert.deepEqual(readSeenFrontier("one"), { createdAt: 5, id: "e" });
  assert.deepEqual(readSeenFrontier("two"), { createdAt: 7, id: "g" });
  assert.equal(readSeenFrontier("three"), null);
});

test("only moves forward", () => {
  writeSeenFrontier("one", { createdAt: 5, id: "e" });
  writeSeenFrontier("one", { createdAt: 3, id: "c" });
  assert.deepEqual(readSeenFrontier("one"), { createdAt: 5, id: "e" });
  writeSeenFrontier("one", { createdAt: 6, id: "f" });
  assert.deepEqual(readSeenFrontier("one"), { createdAt: 6, id: "f" });
});

test("keeps the most recently saved channels", () => {
  for (let index = 0; index <= MAX_SEEN_FRONTIERS; index += 1) {
    writeSeenFrontier(`c${index}`, { createdAt: 1, id: "a" }, index);
  }
  assert.equal(readSeenFrontier("c0"), null);
  assert.deepEqual(readSeenFrontier(`c${MAX_SEEN_FRONTIERS}`), {
    createdAt: 1,
    id: "a",
  });
  assert.deepEqual(readSeenFrontier("c1"), { createdAt: 1, id: "a" });
});

test("ignores corrupt or unavailable storage", () => {
  const items = installStorage();
  items.set("buzz-seen-frontiers.v1", "{not json");
  assert.equal(readSeenFrontier("one"), null);
  items.set(
    "buzz-seen-frontiers.v1",
    JSON.stringify({ one: { createdAt: "x", id: "a", savedAt: 1 } }),
  );
  assert.equal(readSeenFrontier("one"), null);
  globalThis.window = {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
  };
  assert.doesNotThrow(() =>
    writeSeenFrontier("one", { createdAt: 1, id: "a" }),
  );
  assert.equal(readSeenFrontier("one"), null);
});
