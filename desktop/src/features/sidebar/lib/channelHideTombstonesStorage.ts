import {
  createChannelFlagStorage,
  type ChannelFlagStore,
} from "./channelFlagStorage";

/**
 * Channels that opted out of "{name} removed a message" tombstones for
 * deleted messages. Off by default: a deletion is still shown unless the
 * channel owner opts it out (e.g. a bot that routinely cleans up its own
 * old posts, where every deletion is routine rather than noteworthy).
 */
export type ChannelHideTombstonesStore = ChannelFlagStore<"enabled">;

export const channelHideTombstonesStorage = createChannelFlagStorage({
  field: "enabled",
  storageKeyPrefix: "buzz-channel-hide-tombstones.v1",
});
