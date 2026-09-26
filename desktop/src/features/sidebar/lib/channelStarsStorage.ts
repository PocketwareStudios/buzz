import {
  createChannelFlagStorage,
  MAX_CHANNEL_FLAG_ENTRIES,
  type ChannelFlagEntry,
  type ChannelFlagStore,
} from "./channelFlagStorage";

export const MAX_CHANNEL_STAR_ENTRIES = MAX_CHANNEL_FLAG_ENTRIES;

export type ChannelStarEntry = ChannelFlagEntry<"starred">;
export type ChannelStarStore = ChannelFlagStore<"starred">;

export const channelStarsStorage = createChannelFlagStorage({
  field: "starred",
  storageKeyPrefix: "buzz-channel-stars.v1",
});

export const {
  DEFAULT_STORE,
  storageKey,
  parsePayload: parseStarPayload,
  readStore: readChannelStarsStore,
  boundStore: boundStarStore,
  writeStore: writeChannelStarsStore,
  mergeStores,
  flaggedChannelIds: starredChannelIdsFromStore,
} = channelStarsStorage;
