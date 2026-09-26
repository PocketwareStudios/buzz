import { KIND_CHANNEL_UNREAD_COUNTS } from "@/shared/constants/kinds";
import type { ChannelFlagSyncSpec } from "./channelFlagSync";
import { channelUnreadCountsStorage } from "./channelUnreadCountsStorage";

export const CHANNEL_UNREAD_COUNTS_SYNC: ChannelFlagSyncSpec<"enabled"> = {
  storage: channelUnreadCountsStorage,
  kind: KIND_CHANNEL_UNREAD_COUNTS,
  dTag: "channel-unread-counts",
  noun: "channel unread count settings",
  logName: "channelUnreadCountsSync",
};
