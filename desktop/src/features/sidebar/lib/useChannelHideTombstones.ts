import * as React from "react";

import { CHANNEL_HIDE_TOMBSTONES_SYNC } from "./channelHideTombstonesSync";
import { useChannelFlag } from "./useChannelFlag";

/** Which channels opted out of "removed a message" tombstones, synced across devices. */
export function useChannelHideTombstones(
  pubkey: string | undefined,
  relayUrl?: string,
): {
  hideTombstonesChannelIds: Set<string>;
  hideTombstones: (channelId: string) => void;
  showTombstones: (channelId: string) => void;
} {
  const { flaggedChannelIds, setFlag } = useChannelFlag(
    CHANNEL_HIDE_TOMBSTONES_SYNC,
    pubkey,
    relayUrl,
  );
  const hideTombstones = React.useCallback(
    (channelId: string) => setFlag(channelId, true),
    [setFlag],
  );
  const showTombstones = React.useCallback(
    (channelId: string) => setFlag(channelId, false),
    [setFlag],
  );
  return {
    hideTombstonesChannelIds: flaggedChannelIds,
    hideTombstones,
    showTombstones,
  };
}
