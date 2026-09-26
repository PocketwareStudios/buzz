import * as React from "react";

import { CHANNEL_MUTES_SYNC } from "./channelMutesSync";
import { useChannelFlag } from "./useChannelFlag";

export function useChannelMutes(
  pubkey: string | undefined,
  relayUrl?: string,
): {
  mutedChannelIds: Set<string>;
  muteChannel: (channelId: string) => void;
  unmuteChannel: (channelId: string) => void;
} {
  const { flaggedChannelIds, setFlag } = useChannelFlag(
    CHANNEL_MUTES_SYNC,
    pubkey,
    relayUrl,
  );
  const muteChannel = React.useCallback(
    (channelId: string) => setFlag(channelId, true),
    [setFlag],
  );
  const unmuteChannel = React.useCallback(
    (channelId: string) => setFlag(channelId, false),
    [setFlag],
  );
  return { mutedChannelIds: flaggedChannelIds, muteChannel, unmuteChannel };
}
