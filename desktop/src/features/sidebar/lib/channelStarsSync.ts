import { KIND_CHANNEL_STARS } from "@/shared/constants/kinds";
import { channelStarsStorage } from "./channelStarsStorage";
import {
  ChannelFlagSyncManager,
  type ChannelFlagSyncSpec,
  type RemoteChannelFlags,
} from "./channelFlagSync";

export const CHANNEL_STARS_SYNC: ChannelFlagSyncSpec<"starred"> = {
  storage: channelStarsStorage,
  kind: KIND_CHANNEL_STARS,
  dTag: "channel-stars",
  noun: "channel stars",
  logName: "channelStarsSync",
};

export type RemoteStars = RemoteChannelFlags<"starred">;

export class ChannelStarSyncManager extends ChannelFlagSyncManager<"starred"> {
  constructor(pubkey: string, relayUrl: string) {
    super(CHANNEL_STARS_SYNC, pubkey, relayUrl);
  }
}
