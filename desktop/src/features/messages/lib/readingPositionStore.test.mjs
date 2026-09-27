import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const { MAX_READING_POSITIONS, readReadingPosition, writeReadingPosition } =
  await import("./readingPositionStore.ts");

test("a remembered position reads back; null (left at the floor) forgets it", () => {
  store.clear();
  writeReadingPosition("news", { messageId: "m20", topOffset: 40 }, 1);
  assert.deepEqual(readReadingPosition("news"), {
    messageId: "m20",
    topOffset: 40,
  });
  writeReadingPosition("news", null, 2);
  assert.equal(readReadingPosition("news"), null);
});

test("only the most recently left channels are kept", () => {
  store.clear();
  for (let index = 0; index <= MAX_READING_POSITIONS; index += 1) {
    writeReadingPosition(`c${index}`, { messageId: "m", topOffset: 0 }, index);
  }
  assert.equal(readReadingPosition("c0"), null, "the oldest entry is dropped");
  assert.notEqual(readReadingPosition(`c${MAX_READING_POSITIONS}`), null);
  const stored = JSON.parse(store.get("buzz-reading-positions.v1"));
  assert.equal(Object.keys(stored).length, MAX_READING_POSITIONS);
});

test("corrupt storage is ignored instead of throwing", () => {
  store.clear();
  store.set("buzz-reading-positions.v1", "{not json");
  assert.equal(readReadingPosition("news"), null);
  store.set(
    "buzz-reading-positions.v1",
    JSON.stringify({ news: { messageId: 5, topOffset: "x" } }),
  );
  assert.equal(readReadingPosition("news"), null);
  writeReadingPosition("news", { messageId: "m1", topOffset: 3 }, 1);
  assert.deepEqual(readReadingPosition("news"), {
    messageId: "m1",
    topOffset: 3,
  });
});
