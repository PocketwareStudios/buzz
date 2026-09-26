import {
  createChannelFlagStorage,
  type ChannelFlagStore,
} from "./channelFlagStorage";

/**
 * Channels whose sidebar row shows a numeric unread count. Off by default:
 * ordinary channels only turn bold unless the user opts a channel in.
 */
export type ChannelUnreadCountStore = ChannelFlagStore<"enabled">;

export const channelUnreadCountsStorage = createChannelFlagStorage({
  field: "enabled",
  storageKeyPrefix: "buzz-channel-unread-counts.v1",
});
