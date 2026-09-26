/**
 * The number a channel row shows instead of its unread dot, or `undefined`
 * for the dot. Only channels the user opted in to counts get a number, and
 * mute wins: a muted channel never shows one.
 */
export function channelRowUnreadCount(
  channelId: string,
  {
    unreadCountChannelIds,
    mutedChannelIds,
    unreadChannelCounts,
  }: {
    unreadCountChannelIds?: ReadonlySet<string>;
    mutedChannelIds?: ReadonlySet<string>;
    unreadChannelCounts?: ReadonlyMap<string, number>;
  },
): number | undefined {
  if (!unreadCountChannelIds?.has(channelId)) return undefined;
  if (mutedChannelIds?.has(channelId)) return undefined;
  return unreadChannelCounts?.get(channelId) ?? 0;
}
