import '../channel_flags/channel_flag_store.dart';

/// Whether a channel's row shows a numeric unread count. Off by default:
/// ordinary channels only turn bold unless the user opts a channel in.
class ChannelUnreadCountEntry extends ChannelFlagEntry {
  const ChannelUnreadCountEntry({
    required bool enabled,
    required super.updatedAt,
  }) : super(value: enabled);

  bool get enabled => value;
}

class ChannelUnreadCountStore
    extends ChannelFlagStore<ChannelUnreadCountEntry> {
  const ChannelUnreadCountStore({super.version, super.channels});

  Set<String> get enabledChannelIds => {
    for (final entry in channels.entries)
      if (entry.value.enabled) entry.key,
  };
}

/// Synced like mutes and stars, with the same d tag and field as desktop.
final channelUnreadCountsSpec =
    ChannelFlagSpec<ChannelUnreadCountEntry, ChannelUnreadCountStore>(
      field: 'enabled',
      storageKeyPrefix: 'buzz.channel-unread-counts.v1',
      dTag: 'channel-unread-counts',
      logName: 'ChannelUnreadCountsManager',
      entry: (value, updatedAt) =>
          ChannelUnreadCountEntry(enabled: value, updatedAt: updatedAt),
      store: (channels) => ChannelUnreadCountStore(channels: channels),
    );

/// The number a channel row shows, or null for none (including when nothing
/// is unread). Only channels the user opted in to counts get a number, and
/// mute wins.
int? channelRowUnreadCount(
  String channelId, {
  required Set<String> unreadCountChannelIds,
  required Set<String> mutedChannelIds,
  required Map<String, int> unreadCounts,
}) {
  if (!unreadCountChannelIds.contains(channelId)) return null;
  if (mutedChannelIds.contains(channelId)) return null;
  final count = unreadCounts[channelId] ?? 0;
  return count > 0 ? count : null;
}
