import { KIND_CHANNEL_HIDE_TOMBSTONES } from "@/shared/constants/kinds";
import type { ChannelFlagSyncSpec } from "./channelFlagSync";
import { channelHideTombstonesStorage } from "./channelHideTombstonesStorage";

export const CHANNEL_HIDE_TOMBSTONES_SYNC: ChannelFlagSyncSpec<"enabled"> = {
  storage: channelHideTombstonesStorage,
  kind: KIND_CHANNEL_HIDE_TOMBSTONES,
  dTag: "channel-hide-tombstones",
  noun: "channel deletion-tombstone settings",
  logName: "channelHideTombstonesSync",
};
