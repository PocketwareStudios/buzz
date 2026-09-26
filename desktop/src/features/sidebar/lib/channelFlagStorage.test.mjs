import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_CHANNEL_MUTES,
  KIND_CHANNEL_STARS,
} from "@/shared/constants/kinds";
import { createChannelFlagStorage } from "./channelFlagStorage.ts";
import { storageKey as muteStorageKey } from "./channelMutesStorage.ts";
import { CHANNEL_MUTES_SYNC } from "./channelMutesSync.ts";
import { storageKey as starStorageKey } from "./channelStarsStorage.ts";
import { CHANNEL_STARS_SYNC } from "./channelStarsSync.ts";

// The keys, tags and fields below are persisted on every user's devices and
// relay. Changing any of them silently orphans existing preferences.
test("mute and star flags keep their persisted storage keys", () => {
  assert.equal(muteStorageKey("pk"), "buzz-channel-mutes.v1:pk");
  assert.equal(starStorageKey("pk"), "buzz-channel-stars.v1:pk");
});

test("mute and star flags keep their relay wire format", () => {
  assert.deepEqual(
    {
      kind: CHANNEL_MUTES_SYNC.kind,
      dTag: CHANNEL_MUTES_SYNC.dTag,
      field: CHANNEL_MUTES_SYNC.storage.field,
    },
    { kind: KIND_CHANNEL_MUTES, dTag: "channel-mutes", field: "muted" },
  );
  assert.deepEqual(
    {
      kind: CHANNEL_STARS_SYNC.kind,
      dTag: CHANNEL_STARS_SYNC.dTag,
      field: CHANNEL_STARS_SYNC.storage.field,
    },
    { kind: KIND_CHANNEL_STARS, dTag: "channel-stars", field: "starred" },
  );
});

test("a flag only accepts entries carrying its own field", () => {
  const storage = createChannelFlagStorage({
    field: "pinned",
    storageKeyPrefix: "test-pins.v1",
  });
  const parsed = storage.parsePayload({
    version: 1,
    channels: {
      a: { pinned: true, updatedAt: 1 },
      b: { muted: true, updatedAt: 1 },
      c: { pinned: "yes", updatedAt: 1 },
    },
  });
  assert.deepEqual(Object.keys(parsed.channels), ["a"]);
  assert.deepEqual([...storage.flaggedChannelIds(parsed)], ["a"]);
});
