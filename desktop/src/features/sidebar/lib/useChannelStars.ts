import * as React from "react";

import { CHANNEL_STARS_SYNC } from "./channelStarsSync";
import { useChannelFlag } from "./useChannelFlag";

export function useChannelStars(
  pubkey: string | undefined,
  relayUrl?: string,
): {
  starredChannelIds: Set<string>;
  starChannel: (channelId: string) => void;
  unstarChannel: (channelId: string) => void;
} {
  const { flaggedChannelIds, setFlag } = useChannelFlag(
    CHANNEL_STARS_SYNC,
    pubkey,
    relayUrl,
  );
  const starChannel = React.useCallback(
    (channelId: string) => setFlag(channelId, true),
    [setFlag],
  );
  const unstarChannel = React.useCallback(
    (channelId: string) => setFlag(channelId, false),
    [setFlag],
  );
  return { starredChannelIds: flaggedChannelIds, starChannel, unstarChannel };
}
