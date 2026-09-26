import {
  createChannelFlagStorage,
  MAX_CHANNEL_FLAG_ENTRIES,
  type ChannelFlagEntry,
  type ChannelFlagStore,
} from "./channelFlagStorage";

export const MAX_CHANNEL_MUTE_ENTRIES = MAX_CHANNEL_FLAG_ENTRIES;

export type ChannelMuteEntry = ChannelFlagEntry<"muted">;
export type ChannelMuteStore = ChannelFlagStore<"muted">;

export const channelMutesStorage = createChannelFlagStorage({
  field: "muted",
  storageKeyPrefix: "buzz-channel-mutes.v1",
});

export const {
  DEFAULT_STORE,
  storageKey,
  parsePayload: parseMutePayload,
  readStore: readChannelMutesStore,
  boundStore: boundMuteStore,
  writeStore: writeChannelMutesStore,
  mergeStores,
  flaggedChannelIds: mutedChannelIdsFromStore,
} = channelMutesStorage;
