import { KIND_CHANNEL_MUTES } from "@/shared/constants/kinds";
import { channelMutesStorage } from "./channelMutesStorage";
import {
  ChannelFlagSyncManager,
  type ChannelFlagSyncSpec,
  type RemoteChannelFlags,
} from "./channelFlagSync";

export const CHANNEL_MUTES_SYNC: ChannelFlagSyncSpec<"muted"> = {
  storage: channelMutesStorage,
  kind: KIND_CHANNEL_MUTES,
  dTag: "channel-mutes",
  noun: "channel mutes",
  logName: "channelMutesSync",
};

export type RemoteMutes = RemoteChannelFlags<"muted">;

export class ChannelMuteSyncManager extends ChannelFlagSyncManager<"muted"> {
  constructor(pubkey: string, relayUrl: string) {
    super(CHANNEL_MUTES_SYNC, pubkey, relayUrl);
  }
}
