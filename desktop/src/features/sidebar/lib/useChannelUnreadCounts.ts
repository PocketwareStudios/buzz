import * as React from "react";

import { CHANNEL_UNREAD_COUNTS_SYNC } from "./channelUnreadCountsSync";
import { useChannelFlag } from "./useChannelFlag";

/** Which channels opted in to a numeric unread badge, synced across devices. */
export function useChannelUnreadCounts(
  pubkey: string | undefined,
  relayUrl?: string,
): {
  unreadCountChannelIds: Set<string>;
  showUnreadCount: (channelId: string) => void;
  hideUnreadCount: (channelId: string) => void;
} {
  const { flaggedChannelIds, setFlag } = useChannelFlag(
    CHANNEL_UNREAD_COUNTS_SYNC,
    pubkey,
    relayUrl,
  );
  const showUnreadCount = React.useCallback(
    (channelId: string) => setFlag(channelId, true),
    [setFlag],
  );
  const hideUnreadCount = React.useCallback(
    (channelId: string) => setFlag(channelId, false),
    [setFlag],
  );
  return {
    unreadCountChannelIds: flaggedChannelIds,
    showUnreadCount,
    hideUnreadCount,
  };
}
