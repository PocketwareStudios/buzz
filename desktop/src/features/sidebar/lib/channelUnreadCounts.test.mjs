import assert from "node:assert/strict";
import test from "node:test";

import { KIND_CHANNEL_UNREAD_COUNTS } from "@/shared/constants/kinds";
import { channelRowUnreadCount } from "./channelRowUnreadCount.ts";
import { channelUnreadCountsStorage } from "./channelUnreadCountsStorage.ts";
import { CHANNEL_UNREAD_COUNTS_SYNC } from "./channelUnreadCountsSync.ts";

// Persisted on every device and on the relay; changing these orphans settings.
test("unread-count settings keep their storage key and wire format", () => {
  assert.equal(
    channelUnreadCountsStorage.storageKey("pk"),
    "buzz-channel-unread-counts.v1:pk",
  );
  assert.deepEqual(
    {
      kind: CHANNEL_UNREAD_COUNTS_SYNC.kind,
      dTag: CHANNEL_UNREAD_COUNTS_SYNC.dTag,
      field: CHANNEL_UNREAD_COUNTS_SYNC.storage.field,
    },
    { kind: 30078, dTag: "channel-unread-counts", field: "enabled" },
  );
  assert.equal(KIND_CHANNEL_UNREAD_COUNTS, 30078);
});

const counts = new Map([
  ["news", 12],
  ["quiet", 0],
]);

test("a channel that did not opt in shows the dot, not a number", () => {
  assert.equal(
    channelRowUnreadCount("news", {
      unreadCountChannelIds: new Set(),
      unreadChannelCounts: counts,
    }),
    undefined,
  );
});

test("an opted-in channel shows its unread count", () => {
  assert.equal(
    channelRowUnreadCount("news", {
      unreadCountChannelIds: new Set(["news"]),
      unreadChannelCounts: counts,
    }),
    12,
  );
});

test("an opted-in channel with nothing unread reports zero", () => {
  assert.equal(
    channelRowUnreadCount("quiet", {
      unreadCountChannelIds: new Set(["quiet"]),
      unreadChannelCounts: counts,
    }),
    0,
  );
  assert.equal(
    channelRowUnreadCount("unknown", {
      unreadCountChannelIds: new Set(["unknown"]),
      unreadChannelCounts: counts,
    }),
    0,
  );
});

test("mute wins over an opted-in count", () => {
  assert.equal(
    channelRowUnreadCount("news", {
      unreadCountChannelIds: new Set(["news"]),
      mutedChannelIds: new Set(["news"]),
      unreadChannelCounts: counts,
    }),
    undefined,
  );
});
